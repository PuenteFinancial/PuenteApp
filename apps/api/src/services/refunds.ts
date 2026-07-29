import * as Sentry from '@sentry/node'
import { supabaseAdmin } from './supabase.js'
import { resolveCancellationRequest } from './cancellations.js'
import {
  transitionTransfer,
  bridgeReturnLedgerEntries,
  refundedLedgerEntries,
  type LedgerEntryJson,
} from './transfers.js'
import { postLedgerTransaction, type LedgerEntryInput } from './ledger.js'
import { getFundingProcessor } from './funding/index.js'
import { getBridgeTransfer } from './bridge.js'

// The PAYOUT_FAILED → REFUNDED refund-from-float tail (ledger-rules.md), lifted
// out of the payment-event job in slice-7 PR6a so the automated path (job, gated
// by AUTO_REFUND) and the operator path (scripts/trigger-refund.ts, run by a
// human when the flag is off) execute the SAME ledger + disbursement tail and
// cannot diverge. The two paths are not equally guarded, though: the operator
// path additionally runs the principal-returned interlock below, while the job
// trusts mapBridgeState's `principalReturned` on the event that triggered it.
//
// The policy gate lives at the CALL SITE, never here: this service has no
// `force` parameter and no flag read, so which callers may move money stays
// visible per caller. The job checks AUTO_REFUND; the operator IS the gate.
//
// Replay-safe AND concurrency-safe: the two ledger batches are keyed
// (bridge_return / REFUNDED), and the disbursement is gated by the REFUND CLAIM
// — a guarded UPDATE on refund_claimed_at (slice-7 PR6b-0) that exactly one run
// wins. A webhook+poll duplicate, a crash-replay, or two operators running at
// once post and disburse once, so concurrent runs ARE supported. The PROCESSOR's
// idempotency key (`{idempotency_key}:refund`) is now the LAST line of defence
// rather than the only one — which matters, because the mock funding processor
// ignores that key outright (funding/mock.ts).
//
// The claim is NEVER released. A processor throw leaves it standing on purpose:
// a thrown timeout is indistinguishable from a definitive rejection (the
// FundingProcessor seam has no error taxonomy), so releasing would green-light a
// retry that may double-pay. After CLAIM_STALE_AFTER_MS an unfinished claim is
// ABANDONED — an ops decision, never an automatic retry. That is the deliberate
// asymmetry with the submit claim, whose stale path re-POSTs to Bridge
// idempotently and so can afford to heal itself (docs/decisions.md 2026-07-28,
// docs/runbooks/manual-refund.md).
//
// Any NON-BENIGN throw propagates — the job leaves its event 'received' for
// retry, the CLI exits non-zero. A TransferRpcError of transition_conflict /
// transfer_not_found is treated as benign by the job (it marks the event
// processed), because another actor already advanced the row.

interface RefundableTransfer {
  id: string
  state: string
  send_amount_minor: number
  fee_amount_minor: number
  refund_payment_ref: string | null
  funding_payment_ref: string | null
  idempotency_key: string
  refund_claimed_at: string | null
  refund_claimed_by: string | null
}

const REFUNDABLE_COLUMNS =
  'id, state, send_amount_minor, fee_amount_minor, refund_payment_ref, ' +
  'funding_payment_ref, idempotency_key, refund_claimed_at, refund_claimed_by'

// How long an unfinished claim stays "in progress" before it is ABANDONED.
//
// 10 minutes, matching the submit claim (payout-sweep.ts STALE_CLAIM_MS). It
// was 30 while no Bridge or processor call set an AbortSignal — undici's ~300s
// defaults meant a hung-but-alive refund could legitimately hold a claim for
// ~10 minutes, and an alert that fetches a human must not fire on a call that
// is merely slow. That basis is gone (decisions.md 2026-07-29): every Bridge
// call is bounded by BRIDGE_TIMEOUT_SECONDS (~15s), the processor leg is pure
// today (mock), and the FundingProcessor seam requires future adapters to
// bound their own calls — so nothing legitimately alive holds a claim for
// minutes, and a long window only delays the page on a run that genuinely
// crashed, where the sender MAY ALREADY HAVE BEEN PAID. Page sooner.
//
// The asymmetry that REMAINS vs the submit claim is what stale MEANS: a stale
// submit claim self-heals by idempotent re-POST; an abandoned refund claim
// pages a human and is never machine-retaken.
export const CLAIM_STALE_AFTER_MS = 10 * 60 * 1000

/**
 * A claim this old with no disbursement recorded is abandoned, not in flight.
 *
 * An UNPARSEABLE stamp reads as abandoned, not as in-flight. `Date.parse`
 * returns NaN on garbage and every NaN comparison is false, so the natural
 * expression would quietly classify a corrupt row as "someone is refunding it
 * right now" — forever, since that state is the silent one. Wrong in the only
 * direction that hides a stuck transfer from ops.
 */
export function isClaimAbandoned(claimedAt: string | null, now = Date.now()): boolean {
  if (claimedAt === null) return false
  const at = Date.parse(claimedAt)
  if (Number.isNaN(at)) return true
  return now - at >= CLAIM_STALE_AFTER_MS
}

// Terminal Bridge states that mean the principal is back with us — the same two
// that carry `principalReturned` in mapBridgeState (payment-events.ts).
// `refund_in_flight` is still in progress and `refund_failed` means the
// principal is stuck AT Bridge; neither confirms anything.
const PRINCIPAL_RETURNED_STATES = ['returned', 'refunded'] as const

// Transfer ids arrive from an operator's command line and are interpolated into
// a PostgREST `or` FILTER STRING (findReturnEvent), which takes no bound
// parameters — so the shape is checked before it can reach one.
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

// `done` means the transfer is at REFUNDED. The three done-outcomes are kept
// distinct because a caller that reports "refunded by you" must not say so for
// a run that wrote nothing:
//   refunded          — this run disbursed and settled
//   already_disbursed — the disbursement pre-existed (crash between the persist
//                       and the transition); this run posted the REFUNDED batch
//                       and settled the state (bridge_return necessarily
//                       pre-existed too, so that post is a keyed no-op)
//   already_settled   — already REFUNDED; this run wrote NOTHING at all
//
// A refusal carries the state it observed, because whether a refusal is alarming
// depends entirely on it: at COMPLETED the transfer delivered and the sender is
// owed nothing, at SUBMITTED something is genuinely wrong.
//
// The two claim refusals are NOT interchangeable, and no caller may collapse
// them — they are the difference between silence and paging a human:
//   claim_taken     — another run holds a live claim and is disbursing right
//                     now. Benign. Nothing to do; it will settle.
//   claim_abandoned — a claim older than CLAIM_STALE_AFTER_MS with no
//                     disbursement recorded. The claimant died somewhere between
//                     taking the claim and persisting the ref, so the sender may
//                     or may not have been paid. Only a human can tell, by
//                     checking the processor (runbooks/manual-refund.md).
//
// Neither is reported as `already_disbursed`. That outcome means "the
// disbursement pre-existed AND THIS RUN settled the state" — the CLI prints
// exactly that — so using it for a run that wrote nothing would be a lie.
export type RefundOutcome =
  | { done: true; outcome: 'refunded' | 'already_disbursed' | 'already_settled' }
  | { done: false; reason: 'not_payout_failed'; state: string }
  | { done: false; reason: 'transfer_not_found' }
  // Two ARMS, not one arm with a union of reasons, because callers must be
  // unable to collapse them: `claim_taken` is silent and `claim_abandoned`
  // pages, and getting that backwards means either an alert storm on healthy
  // concurrency or a sender stranded with no signal. Separate arms make
  // `Extract<RefundOutcome, {reason:'claim_abandoned'}>` usable and let the job
  // switch exhaustively with an assertNever default, so a future third refusal
  // breaks the build instead of silently taking someone else's branch.
  | { done: false; reason: 'claim_taken'; claimedAt: string | null; claimedBy: string | null }
  | { done: false; reason: 'claim_abandoned'; claimedAt: string | null; claimedBy: string | null }

export type PrincipalVerdict =
  | { returned: true; bridgeState: string; eventType: string }
  | {
      returned: false
      reason: 'transfer_not_found' | 'not_submitted' | 'no_return_event' | 'bridge_disagrees'
      bridgeState?: string
      eventType?: string
    }

const toLedgerInput = (entries: LedgerEntryJson[]): LedgerEntryInput[] =>
  entries.map((e) => ({
    accountCode: e.account_code,
    direction: e.direction,
    money: { amountMinor: e.amount_minor, currency: e.currency },
  }))

/**
 * Drive a transfer parked at `PAYOUT_FAILED` all the way to `REFUNDED`: book the
 * returned principal back to cash, return the collected funds to the sender, and
 * settle the state with the refund ledger batch.
 *
 * Reads live state itself rather than trusting a caller-supplied row — this is a
 * money-moving entry point reachable from an operator CLI, so the amounts and the
 * never-refund-a-delivered-transfer guard must come from the database, not the
 * caller. Returns a structured verdict; the script prints it, the job ignores it.
 *
 * `actor` is written to `transfer_transitions` and is the ONLY durable record of
 * who triggered a manual refund (jobs and scripts write no audit-plugin rows).
 */
export async function refundPayoutFailure(input: {
  transferId: string
  actor: string
  reason: string
}): Promise<RefundOutcome> {
  const transfer = await loadRefundable(input.transferId)
  if (!transfer) return { done: false, reason: 'transfer_not_found' }

  // Already settled — a duplicate event, a retried job, or an operator running
  // the command twice. Report success WITHOUT writing: the batches and the
  // disbursement are keyed, so re-posting would be a no-op anyway, but a replay
  // from a terminal state should not touch the ledger at all. Distinct from the
  // refusal below so the CLI can exit 0 here and non-zero there.
  if (transfer.state === 'REFUNDED') {
    // Writes nothing to the ledger, but DOES re-attempt the cancellation close:
    // that is the only retry a resolve failure ever gets (see
    // settleCancellationRequest).
    await settleCancellationRequest(transfer.id, input.actor)
    return { done: true, outcome: 'already_settled' }
  }

  // The guard that matters: only refund a transfer that actually reached
  // PAYOUT_FAILED — never one that delivered.
  if (transfer.state !== 'PAYOUT_FAILED') {
    return { done: false, reason: 'not_payout_failed', state: transfer.state }
  }

  // 1) Book the returned principal back to cash — a stand-alone post (state
  //    stays PAYOUT_FAILED), keyed {id}:bridge_return, idempotent on replay.
  await postLedgerTransaction({
    transferId: transfer.id,
    transition: 'bridge_return',
    description: 'bridge returned principal on payout failure',
    entries: toLedgerInput(bridgeReturnLedgerEntries(transfer)),
  })

  // 2) Return the collected funds to the sender — behind the CLAIM, so exactly
  //    one run can reach the processor. Keyed off the transfer's stable bridge
  //    idempotency key so a retry also dedupes against a real processor.
  //
  //    A ref that ALREADY exists needs no claim: the disbursement happened, and
  //    all that is left is the state, which step 3 settles. That is the
  //    crash-recovery path listRefundBacklog exists to surface, and it behaves
  //    exactly as it did before the claim landed.
  const alreadyDisbursed = transfer.refund_payment_ref !== null
  if (!alreadyDisbursed) {
    // Refuse to disburse against a missing funding ref rather than coercing it
    // to ''. Unreachable in practice — reaching PAYOUT_FAILED means the transfer
    // was FUNDED, which sets this — so a null here means the row is corrupt, and
    // the fallback would send the processor an empty payment reference: a real
    // Stripe adapter rejects it, and a lenient one refunds against nothing.
    // Checked BEFORE the claim so a row we cannot pay never holds one. Throws
    // rather than returning a refusal because this is a data-integrity fault,
    // not a business outcome — same shape as the load/persist failures here.
    if (transfer.funding_payment_ref === null) {
      throw new Error(`refund aborted: transfer ${transfer.id} has no funding_payment_ref`)
    }
    if (await claimRefund(transfer.id, input.actor)) {
      // No try/catch, deliberately. A throw here leaves the claim standing —
      // see the header: releasing it would green-light a retry that may
      // double-pay, because a timeout and a rejection throw identically.
      const undo = await getFundingProcessor().refund({
        transferId: transfer.id,
        paymentRef: transfer.funding_payment_ref,
        amountMinor: transfer.send_amount_minor + transfer.fee_amount_minor,
        currency: 'USD',
        idempotencyKey: `${transfer.idempotency_key}:refund`,
      })
      const { error } = await supabaseAdmin
        .from('transfers')
        .update({ refund_payment_ref: undo.ref, refunded_at: new Date().toISOString() })
        .eq('id', transfer.id)
        .is('refund_payment_ref', null)
      if (error) throw new Error(`refund ref persist failed: ${error.message}`)
    } else {
      // Someone holds the claim. ONE re-read tells us which of three it is —
      // our own load is already stale by the time the claim comes back.
      // A run that lost the claim WRITES NOTHING. Not the disbursement, and not
      // the transition either — that is the subtle one. Falling through to
      // transitionTransfer here looks harmless because the RPC treats a
      // transition whose target is the current state as a replay (returns the
      // row, appends nothing, posts nothing), but the caller cannot tell that
      // from a real settle: it would report `already_disbursed`, the CLI would
      // print "state settled by this run" and "refunded by ops:<you>", and the
      // verify query would show somebody else as the actor. Observed exactly
      // that in the two-operator rig before this returned early.
      const fresh = await loadRefundable(transfer.id)
      if (!fresh) return { done: false, reason: 'transfer_not_found' }
      if (fresh.state === 'REFUNDED') {
        await settleCancellationRequest(transfer.id, input.actor)
        return { done: true, outcome: 'already_settled' }
      }

      // Still unsettled. If the ref appeared between our load and our claim,
      // the winner is mid-flight between its persist and its transition — which
      // is exactly `claim_taken`: someone else owns this and will finish it. And
      // if the winner dies in that gap, the row is left with a ref set and the
      // state open, which the PRE-LOAD branch above heals on the next run.
      //
      // A null claimedAt would mean the holder released the claim between our
      // attempt and this read, which only releaseStaleRefundClaim does. Read it
      // as taken rather than crashing: the caller's two responses are "stay
      // quiet" and "page a human", and quiet is the safe one to be wrong with.
      return {
        done: false,
        reason: isClaimAbandoned(fresh.refund_claimed_at) ? 'claim_abandoned' : 'claim_taken',
        claimedAt: fresh.refund_claimed_at,
        claimedBy: fresh.refund_claimed_by,
      }
    }
  }

  // 3) Recognize + pay the refund and settle REFUNDED — a DISTINCT posting key
  //    from bridge_return (the UNIQUE(transfer_id, transition) index needs both).
  await transitionTransfer({
    transferId: transfer.id,
    fromState: 'PAYOUT_FAILED',
    toState: 'REFUNDED',
    actor: input.actor,
    reason: input.reason,
    ledgerDescription: 'transfer REFUNDED — payout failed, sender refunded from float',
    ledgerEntries: refundedLedgerEntries(transfer),
  })

  await settleCancellationRequest(transfer.id, input.actor)
  return { done: true, outcome: alreadyDisbursed ? 'already_disbursed' : 'refunded' }
}

/**
 * Tail 1 of the post-submission cancellation story (slice-7 PR6b): the sender
 * asked to cancel a transfer already on its way to payout, the payout then
 * FAILED, and the refund tail has now made them whole. Nothing further is owed —
 * close the request.
 *
 * Called from every exit that leaves the transfer at REFUNDED, which is the
 * transition itself AND the two `already_settled` early returns. Including the
 * latter is what makes this self-healing: without them, a resolve that failed on
 * a transient error after a successful transition would never be retried — every
 * later run short-circuits at `already_settled` — and the request would sit
 * pending forever on a transfer that was refunded. `resolveCancellationRequest`
 * is guarded on `status = 'pending'`, so a run that closes a stale request writes
 * once and later runs write nothing.
 *
 * `resolvedBy` records who CLOSED the request, not who paid: a run that observes
 * an already-refunded transfer and closes a stale request is legitimately its
 * resolver.
 *
 * Never throws. This is bookkeeping hanging off a money path — the sender has
 * been paid, and a failure to file that fact must not undo, retry, or fail the
 * refund. It pages instead.
 */
async function settleCancellationRequest(transferId: string, actor: string): Promise<void> {
  try {
    await resolveCancellationRequest({
      transferId,
      status: 'resolved_refunded',
      resolution: 'payout failed; sender refunded in full by the refund tail',
      resolvedBy: actor,
    })
  } catch (err) {
    Sentry.withScope((scope) => {
      scope.setFingerprint(['cancellation-resolve-failed', transferId])
      scope.setContext('cancellation_resolve_failed', {
        transferId,
        tail: 'PAYOUT_FAILED->REFUNDED',
        // The page is the only place this error surfaces (the swallow is the
        // point) — carry the reason. Service/PostgREST message, no PII.
        error: err instanceof Error ? err.message : String(err),
        runbook: 'docs/runbooks/pending-cancellation.md',
      })
      Sentry.captureMessage(
        'refund settled but the cancellation request was not closed — close it by hand',
        'error',
      )
    })
    // Swallowed on purpose: see the doc comment. The next run through this
    // transfer re-attempts it from the already_settled exit.
    void err
  }
}

/**
 * The principal-returned interlock for the operator path. `bridge_return` books
 * `DR cash_clearing / CR due_from_bridge` — it ASSERTS Bridge sent our cash back,
 * so if that is wrong the books claim cash we do not hold.
 *
 * Two independent sources must agree: a recorded terminal `returned`/`refunded`
 * event, AND a live Bridge GET saying the same. Either one alone can be stale or
 * wrong — a webhook can arrive for a state Bridge later reverses, and a live read
 * with no recorded event means our own pipeline never saw it. An unreachable
 * Bridge throws rather than resolving to a verdict: silence is not confirmation.
 *
 * This checks WHETHER the principal came back, not HOW MUCH. A partial return
 * would still book the full `send_amount_minor` in bridge_return and make the
 * sender whole from float, leaving the shortfall as an unreconciled receivable.
 * Same open assumption the automated path already carries (transfers.ts:
 * "assumes Bridge returns S, not the actual USDC draw A") — a pilot-verification
 * item, not something to resolve from a CLI.
 */
export async function verifyPrincipalReturned(transferId: string): Promise<PrincipalVerdict> {
  const { data, error } = await supabaseAdmin
    .from('transfers')
    .select('id, state, provider_transfer_ref')
    .eq('id', transferId)
    .maybeSingle()
  if (error) throw new Error(`refund interlock transfer load failed: ${error.message}`)
  const transfer = data as { id: string; provider_transfer_ref: string | null } | null
  if (!transfer) return { returned: false, reason: 'transfer_not_found' }
  // Never submitted to Bridge → Bridge holds nothing of ours to return.
  if (!transfer.provider_transfer_ref) return { returned: false, reason: 'not_submitted' }

  const eventType = await findReturnEvent(transfer.id, transfer.provider_transfer_ref)
  const bridge = await getBridgeTransfer(transfer.provider_transfer_ref)
  const bridgeAgrees = (PRINCIPAL_RETURNED_STATES as readonly string[]).includes(bridge.state)

  if (!eventType) return { returned: false, reason: 'no_return_event', bridgeState: bridge.state }
  if (!bridgeAgrees) {
    return { returned: false, reason: 'bridge_disagrees', bridgeState: bridge.state, eventType }
  }
  return { returned: true, bridgeState: bridge.state, eventType }
}

// Read-only ops surface for the CLI. Deliberately here rather than in the
// script: nothing under scripts/ queries the database directly — DB access
// stays under src/ — and the column list is a PII decision (ids, amounts,
// timestamps — never recipient names or destination details, which must not
// reach an operator's terminal or scrollback).
/**
 * `unclaimed` — free; the next run takes it.
 * `claimed`   — a run is disbursing right now. Leave it alone.
 * `abandoned` — claimed over CLAIM_STALE_AFTER_MS ago and never finished. The
 *               sender may or may not have been paid; an operator confirms in
 *               the processor, then `--reclaim`.
 */
export type ClaimStatus = 'unclaimed' | 'claimed' | 'abandoned'

export interface ParkedRefund {
  id: string
  send_amount_minor: number
  fee_amount_minor: number
  provider_transfer_ref: string | null
  /** Non-null = the sender was already paid but the state never settled. */
  refund_payment_ref: string | null
  created_at: string
  refund_claimed_at: string | null
  refund_claimed_by: string | null
  /** Derived from refund_claimed_at — the window belongs to the service. */
  claimStatus: ClaimStatus
}

// One string literal, not a concatenation: supabase-js parses the column list at
// the TYPE level, and splitting it collapses the row type to GenericStringError.
const PARKED_COLUMNS =
  'id, send_amount_minor, fee_amount_minor, provider_transfer_ref, refund_payment_ref, created_at, refund_claimed_at, refund_claimed_by'

// Classifying here rather than in the CLI keeps CLAIM_STALE_AFTER_MS in one
// place: an operator must never be handed the window arithmetic to do by eye.
const classifyClaim = (claimedAt: string | null): ClaimStatus =>
  claimedAt === null ? 'unclaimed' : isClaimAbandoned(claimedAt) ? 'abandoned' : 'claimed'

/**
 * The parked-refund backlog: every transfer stuck at `PAYOUT_FAILED` after the
 * payout was submitted. With `AUTO_REFUND` off the poller skips these entirely,
 * and a row whose terminal event was already processed while the flag was off is
 * never re-driven by flipping it on — so this IS the human backlog.
 *
 * Deliberately NOT filtered on `refund_payment_ref IS NULL`, unlike the poller's
 * self-heal scan (payout-poll.ts). A crash between the disbursement and the
 * REFUNDED transition leaves the ref SET and the state still `PAYOUT_FAILED`:
 * the sender's cash went out but `{id}:REFUNDED` was never posted, so
 * `transfer_payable` stays open and the books disagree with actual cash. On the
 * job path a pg-boss retry heals that; on this path nothing does, so hiding
 * those rows would hide the only class of row the ledger is wrong about.
 * `refund_payment_ref` is returned so the caller can mark them — they need
 * finishing, not disbursing (`refundPayoutFailure` reports `already_disbursed`).
 */
export async function listRefundBacklog(): Promise<ParkedRefund[]> {
  const { data, error } = await supabaseAdmin
    .from('transfers')
    .select(PARKED_COLUMNS)
    .eq('state', 'PAYOUT_FAILED')
    .not('provider_transfer_ref', 'is', null)
  // Fail closed: an empty backlog and a broken read must never look the same.
  if (error || data == null) {
    throw new Error(`refund backlog query failed: ${error?.message ?? 'no rows returned'}`)
  }
  return (data as Omit<ParkedRefund, 'claimStatus'>[]).map((row) => ({
    ...row,
    claimStatus: classifyClaim(row.refund_claimed_at),
  }))
}

/**
 * The claim on ONE transfer — what the CLI's dry run reports, so an operator
 * learns a claim is abandoned before they reach for `--confirm`.
 */
export async function refundClaimStatus(
  transferId: string,
): Promise<{ claimStatus: ClaimStatus; claimedAt: string | null; claimedBy: string | null } | null> {
  const { data, error } = await supabaseAdmin
    .from('transfers')
    .select('refund_claimed_at, refund_claimed_by')
    .eq('id', transferId)
    .maybeSingle()
  if (error) throw new Error(`refund claim status query failed: ${error.message}`)
  const row = data as { refund_claimed_at: string | null; refund_claimed_by: string | null } | null
  if (!row) return null
  return {
    claimStatus: classifyClaim(row.refund_claimed_at),
    claimedAt: row.refund_claimed_at,
    claimedBy: row.refund_claimed_by,
  }
}

/**
 * Clear an ABANDONED claim so the tail can be re-driven. The only code anywhere
 * that clears a claim, and the operator's only exit from one.
 *
 * NOT a `force` flag on refundPayoutFailure — the PR6a ADR rejected that shape
 * because a bypass parameter on a money-moving service invites the next caller
 * to use it. This is a separate named operation the job never calls, and it
 * bypasses no policy: the principal-returned interlock, the PAYOUT_FAILED guard,
 * `--operator` and `--confirm` all still run afterwards.
 *
 * Guarded three ways, so it can only ever undo the situation it is named for:
 * the ref must still be null (never disturb a completed disbursement), and the
 * claim must be genuinely older than the window (never yank a live one out from
 * under a run that is mid-flight). Returns false when nothing moved — the
 * caller must re-refuse rather than assume it worked.
 */
export async function releaseStaleRefundClaim(transferId: string): Promise<boolean> {
  const staleBefore = new Date(Date.now() - CLAIM_STALE_AFTER_MS).toISOString()
  const { data, error } = await supabaseAdmin
    .from('transfers')
    .update({ refund_claimed_at: null, refund_claimed_by: null })
    .eq('id', transferId)
    .is('refund_payment_ref', null)
    .lt('refund_claimed_at', staleBefore)
    .select('id')
  if (error) throw new Error(`refund claim release failed: ${error.message}`)
  return (data ?? []).length === 1
}

/** The posting batches on a transfer — the operator's proof both keys landed. */
export async function refundLedgerBatches(
  transferId: string,
): Promise<Array<{ transition: string | null; idempotency_key: string }>> {
  const { data, error } = await supabaseAdmin
    .from('ledger_transactions')
    .select('transition, idempotency_key')
    .eq('transfer_id', transferId)
  if (error || data == null) {
    throw new Error(`refund ledger batch query failed: ${error?.message ?? 'no rows returned'}`)
  }
  return data as Array<{ transition: string | null; idempotency_key: string }>
}

// The atomic claim — the shape of claimForSubmission (jobs/payout-submit.ts),
// deliberately WITHOUT a staleness term in the predicate. `refund_claimed_at is
// null` is the whole guard: a claim is never retaken by a machine, only cleared
// by releaseStaleRefundClaim after a human has looked. The window lives in
// isClaimAbandoned, in the backlog classification, and in the job's alert —
// never here.
// Exported so the slice-7 PR6b correction payment (services/cancellation-review)
// takes the SAME claim rather than re-deriving the predicate. Both disburse
// against `refund_payment_ref` on one transfer, so they must contend on one
// lock; two claim implementations would be two chances to get it subtly wrong.
export async function claimRefund(transferId: string, actor: string): Promise<boolean> {
  const { data, error } = await supabaseAdmin
    .from('transfers')
    .update({ refund_claimed_at: new Date().toISOString(), refund_claimed_by: actor })
    .eq('id', transferId)
    .is('refund_payment_ref', null)
    .is('refund_claimed_at', null)
    .select('id')
  // Fail closed: a broken claim query must never read as a lost race, which
  // would silently downgrade a database fault to "someone else has it".
  // `data == null` is in the throw for the same reason — a null-without-error
  // would otherwise coalesce to [] and read as a loss, the exact fail-open this
  // comment forbids (matches listRefundBacklog / findReturnEvent).
  if (error || data == null) {
    throw new Error(`refund claim failed: ${error?.message ?? 'no rows returned'}`)
  }
  return data.length === 1
}

async function loadRefundable(transferId: string): Promise<RefundableTransfer | null> {
  const { data, error } = await supabaseAdmin
    .from('transfers')
    .select(REFUNDABLE_COLUMNS)
    .eq('id', transferId)
    .maybeSingle()
  if (error) throw new Error(`refund transfer load failed: ${error.message}`)
  return (data as RefundableTransfer | null) ?? null
}

// Ingest does not always resolve transfer_id (out-of-order / unknown reference —
// see payment-events.ts), so match on either key. PostgREST `or` takes a filter
// STRING, not bound parameters, so BOTH interpolated values are charset-checked
// first: an id like `x),or(1.eq.1` would otherwise rewrite the predicate. The
// transfer id reaches here straight from a CLI argument. The two failure modes
// differ on purpose — a bad transfer id THROWS, a bad provider ref is DROPPED
// from the predicate, because narrowing the match can only produce a stricter
// verdict, never a false confirmation.
async function findReturnEvent(
  transferId: string,
  providerTransferRef: string,
): Promise<string | null> {
  if (!UUID_RE.test(transferId)) {
    throw new Error(`refund principal-return event query failed: malformed transfer id`)
  }
  const clauses = [`transfer_id.eq.${transferId}`]
  if (/^[A-Za-z0-9_-]+$/.test(providerTransferRef)) {
    clauses.push(`provider_ref.eq.${providerTransferRef}`)
  }

  const { data, error } = await supabaseAdmin
    .from('payment_events')
    .select('event_type')
    .in('event_type', [...PRINCIPAL_RETURNED_STATES])
    .or(clauses.join(','))
    .limit(1)
  // Fail closed: a null-without-error must never read as "no return event", which
  // is the same answer as a confirmed refusal but for the wrong reason.
  if (error || data == null) {
    throw new Error(
      `refund principal-return event query failed: ${error?.message ?? 'no rows returned'}`,
    )
  }
  const rows = data as Array<{ event_type: string }>
  return rows[0]?.event_type ?? null
}
