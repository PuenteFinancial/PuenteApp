import { supabaseAdmin } from './supabase.js'
import {
  transitionTransfer,
  correctionRefundLedgerEntries,
  correctionVoidLedgerEntries,
} from './transfers.js'
import { getFundingProcessor, undoModeForRef } from './funding/index.js'
import { claimRefund, isClaimAbandoned } from './refunds.js'
import { pendingCancellationFor, resolveCancellationRequest } from './cancellations.js'
import { earliestDepositEvidenceAt } from './payment-events.js'

// The two lawful exits from UNDER_REVIEW for a cancellation request, and only
// those (slice-7 PR6b).
//
// A transfer reaches UNDER_REVIEW here exactly one way: the sender made a TIMELY
// cancellation request, the payout COMPLETED anyway, and payment-event-process
// routed it for a human. The recipient has the money and is not asked to give it
// back; Reg E obliges us to make the SENDER whole regardless. That is the
// accepted, bounded double-pay.
//
//   refund — pay the sender again as a post-delivery CORRECTION PAYMENT. A new
//     expense against Puente, booked to loss_cancellation_correction. The
//     original COMPLETED entries are never touched: we do not rewrite delivered
//     history.
//   deny  — only for a request that was NOT timely. The transfer returns to
//     COMPLETED and the request closes with the operator's evidence.
//
// Why a service and not an endpoint: same reasoning as the refund trigger
// (decisions.md 2026-07-27). A money-moving prod endpoint is the admin console
// the PRD rules out; the CLI is strictly safer than the SQL editor because it
// posts through the ledger RPC.

interface ReviewableTransfer {
  id: string
  state: string
  send_amount_minor: number
  fee_amount_minor: number
  margin_minor: number
  payment_at: string | null
  refund_payment_ref: string | null
  funding_payment_ref: string | null
  idempotency_key: string
  refund_claimed_at: string | null
  refund_claimed_by: string | null
}

const REVIEWABLE_COLUMNS =
  'id, state, send_amount_minor, fee_amount_minor, margin_minor, payment_at, refund_payment_ref, funding_payment_ref, idempotency_key, refund_claimed_at, refund_claimed_by'

export type ReviewOutcome =
  // `already_disbursed` = the money left in a PRIOR run (a crash between the
  // ref persist and the transition); this run settled the state and closed the
  // request but paid nothing. Distinct from `refunded` for the same reason the
  // PAYOUT_FAILED tail distinguishes them: a tool that says "sender paid" for
  // a run that moved no money is lying about the only fact that matters here.
  | { done: true; outcome: 'refunded' | 'already_disbursed' | 'already_refunded' | 'denied' }
  | { done: false; reason: 'transfer_not_found' }
  | { done: false; reason: 'not_under_review'; state: string }
  | { done: false; reason: 'no_pending_request' }
  // The refund-owed guard: the request satisfied BOTH §1005.34 conditions —
  // inside the 30-minute window AND made before the deposit the operator is
  // citing. Such a request cannot be denied by any tool.
  | { done: false; reason: 'request_precedes_deposit' }
  // The cited deposit timestamp is provably wrong: before the sender even
  // paid, or after the moment we RECEIVED Bridge's deposit confirmation (the
  // true deposit cannot postdate our evidence of it). Refused so a denial can
  // never be recorded against impossible evidence.
  | {
      done: false
      reason: 'deposit_evidence_conflict'
      paymentAt: string | null
      depositEvidenceAt: string | null
    }
  | { done: false; reason: 'claim_taken'; claimedAt: string | null; claimedBy: string | null }
  | { done: false; reason: 'claim_abandoned'; claimedAt: string | null; claimedBy: string | null }

async function loadReviewable(transferId: string): Promise<ReviewableTransfer | null> {
  const { data, error } = await supabaseAdmin
    .from('transfers')
    .select(REVIEWABLE_COLUMNS)
    .eq('id', transferId)
    .maybeSingle()
  if (error) throw new Error(`cancellation review load failed: ${error.message}`)
  return (data as ReviewableTransfer | null) ?? null
}

/**
 * Pay the sender their correction payment and settle UNDER_REVIEW → REFUNDED.
 *
 * Takes the SAME refund claim as the PAYOUT_FAILED tail — both disburse against
 * `refund_payment_ref` on one transfer, so they contend on one lock. The claim
 * is never released on a throw, so a processor failure here leaves the row for
 * ops exactly as it does there (runbooks/manual-refund.md).
 *
 * Reads live state itself rather than trusting a caller-supplied row: this is a
 * money-moving entry point reachable from an operator CLI, so the amounts and
 * the guards come from the database.
 */
export async function refundCancellation(input: {
  transferId: string
  operator: string
}): Promise<ReviewOutcome> {
  const actor = `ops:${input.operator}`
  const transfer = await loadReviewable(input.transferId)
  if (!transfer) return { done: false, reason: 'transfer_not_found' }

  // Idempotent terminal: already made whole. Writes nothing but the close —
  // and the close must not claim a correction payment, because REFUNDED may
  // have been reached by the PAYOUT_FAILED tail (its resolve failed and paged;
  // the runbook sends the operator here). On that transfer nothing delivered
  // and no correction exists, so the resolution text stays neutral.
  if (transfer.state === 'REFUNDED') {
    await closeRequest(transfer.id, actor, ALREADY_REFUNDED_RESOLUTION)
    return { done: true, outcome: 'already_refunded' }
  }

  // The guard that matters. Only a transfer the job actually routed for review
  // may be paid twice — never a plain COMPLETED transfer, which would be an
  // unreviewed double payment on a delivery nobody contested.
  if (transfer.state !== 'UNDER_REVIEW') {
    return { done: false, reason: 'not_under_review', state: transfer.state }
  }

  // The request is the authority for the payment. Without one there is no ask to
  // honour, and paying would be a gift of company money with no record of why.
  const request = await pendingCancellationFor(transfer.id)
  if (!request) return { done: false, reason: 'no_pending_request' }

  const alreadyDisbursed = transfer.refund_payment_ref !== null
  // Carried to the settle, where the undo's MODE picks the correction batch —
  // prefix-encoded in the ref so the crash-recovery path can still tell.
  let disbursedRef = transfer.refund_payment_ref
  if (!alreadyDisbursed) {
    if (transfer.funding_payment_ref === null) {
      throw new Error(`correction refund aborted: transfer ${transfer.id} has no funding_payment_ref`)
    }
    if (await claimRefund(transfer.id, actor)) {
      // No try/catch, deliberately — same rule as the PAYOUT_FAILED tail: a
      // timeout and a rejection throw identically, so releasing the claim would
      // green-light a retry that may pay a third time.
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
      if (error) throw new Error(`correction refund ref persist failed: ${error.message}`)
      disbursedRef = undo.ref
    } else {
      const fresh = await loadReviewable(transfer.id)
      if (!fresh) return { done: false, reason: 'transfer_not_found' }
      if (fresh.state === 'REFUNDED') {
        await closeRequest(transfer.id, actor, ALREADY_REFUNDED_RESOLUTION)
        return { done: true, outcome: 'already_refunded' }
      }
      // A losing run writes nothing at all — the PR6b-0 rule.
      return {
        done: false,
        reason: isClaimAbandoned(fresh.refund_claimed_at) ? 'claim_abandoned' : 'claim_taken',
        claimedAt: fresh.refund_claimed_at,
        claimedBy: fresh.refund_claimed_by,
      }
    }
  }

  // The batch depends on HOW the sender was made whole (PR-S2): a `refunded`
  // undo paid real cash (CR cash_clearing); a `voided` undo — the LIKELY case,
  // since delivery precedes settlement by days — canceled the uncleared pull,
  // so the compliance loss books against the receivable that will never
  // collect instead of against cash that never moved.
  if (disbursedRef === null) {
    // Unreachable — see the identical guard in refundPayoutFailure.
    throw new Error(`correction settle reached with no disbursement ref for ${transfer.id}`)
  }
  const undoMode = undoModeForRef(disbursedRef)
  await transitionTransfer({
    transferId: transfer.id,
    fromState: 'UNDER_REVIEW',
    toState: 'REFUNDED',
    actor,
    reason: 'timely cancellation on a delivered transfer — correction payment',
    metadata: { cancellationRequestId: request.id, requestedAt: request.requested_at },
    ledgerDescription:
      undoMode === 'voided'
        ? 'transfer REFUNDED — Reg E correction; uncleared funding voided (receivable written off)'
        : 'transfer REFUNDED — Reg E correction payment on a delivered transfer',
    ledgerEntries:
      undoMode === 'voided'
        ? correctionVoidLedgerEntries(transfer)
        : correctionRefundLedgerEntries(transfer),
  })

  await closeRequest(
    transfer.id,
    actor,
    'timely cancellation on a delivered transfer — correction payment issued',
  )
  // alreadyDisbursed = the money left in a PRIOR run; this run only settled.
  return { done: true, outcome: alreadyDisbursed ? 'already_disbursed' : 'refunded' }
}

/**
 * Deny a request that is owed nothing. Two lawful grounds, mirroring §1005.34's
 * two conditions, and only these:
 *
 *   out of window            — the 30-minute clock was missed. Provable from our
 *                              own `cancelable_until` (within_window = false).
 *   deposit preceded request — inside the window, but the funds were already
 *                              deposited when the sender asked. Provable ONLY
 *                              from Bridge's deposit timestamp, which is why
 *                              `depositedAt` is load-bearing here, not just
 *                              recorded: the guard compares it to requested_at.
 *
 * REFUSES to deny a request that beat the deposit. That is the legal guard of
 * this whole file: in-window AND pre-deposit means the refund is owed, full
 * stop, and the tool must not let an operator close one by typing a denial
 * instead. If such a request genuinely must not be paid, that is an escalation,
 * not a CLI flag.
 *
 * `depositedAt` comes from the Bridge dashboard (getBridgeTransfer returns only
 * id/state/sourceAmount); it is recorded in the resolution and the transition
 * metadata so the denial is provable later.
 *
 * ⚠️ The dangerous direction of a typo is EARLIER (PR6b review fix — this text
 * previously claimed the opposite): an earlier-than-reality timestamp makes
 * `depositedAt > requested_at` LESS likely to hold, i.e. makes the tool DENY
 * more, not refuse more. Two nets narrow that: garbage input throws (below —
 * `Date.parse(garbage)` is NaN and every NaN comparison is false, which would
 * fail the guard OPEN), and the cited value is bounded to what is physically
 * possible: no earlier than the sender's payment, no later than the moment we
 * received Bridge's deposit confirmation. Inside those bounds the timestamp is
 * the operator's judgment — read it carefully; the CLI's dry run shows the
 * request time it will be compared against.
 */
export async function denyCancellation(input: {
  transferId: string
  operator: string
  depositedAt: string
}): Promise<ReviewOutcome> {
  // Fail CLOSED on unparseable input before any comparison sees it. This is a
  // money-adjacent legal guard reachable from any future caller, not just the
  // CLI (which validates upstream) — and NaN would skip the owed-guard below.
  if (Number.isNaN(Date.parse(input.depositedAt))) {
    throw new Error(
      `denyCancellation: depositedAt "${input.depositedAt}" is not a parseable timestamp`,
    )
  }
  const actor = `ops:${input.operator}`
  const transfer = await loadReviewable(input.transferId)
  if (!transfer) return { done: false, reason: 'transfer_not_found' }

  const request = await pendingCancellationFor(transfer.id)
  if (!request) return { done: false, reason: 'no_pending_request' }

  // The guard that matters here: both statutory conditions held → owed → cannot
  // be denied. (within_window is condition 1, frozen at record time; the
  // deposit comparison is condition 2, against the operator's cited timestamp.)
  if (request.within_window && Date.parse(input.depositedAt) > Date.parse(request.requested_at)) {
    return { done: false, reason: 'request_precedes_deposit' }
  }

  // Plausibility bounds on the cited evidence (PR6b review fix). The true
  // deposit lies in [payment_at, earliest payment_processed received_at]: it
  // cannot precede the sender's payment, and it cannot postdate the moment
  // Bridge TOLD us it had happened. A value outside that range is provably
  // wrong, and a denial must never be recorded against impossible evidence —
  // refuse and send the operator back to the dashboard. (Inside the range a
  // fat-finger is still possible; these bounds are a net, not proof.)
  const depositEvidenceAt = await earliestDepositEvidenceAt(transfer.id)
  const cited = Date.parse(input.depositedAt)
  if (
    (transfer.payment_at !== null && cited < Date.parse(transfer.payment_at)) ||
    (depositEvidenceAt !== null && cited > Date.parse(depositEvidenceAt))
  ) {
    return {
      done: false,
      reason: 'deposit_evidence_conflict',
      paymentAt: transfer.payment_at,
      depositEvidenceAt,
    }
  }

  // Out-of-window requests on a COMPLETED transfer were never routed, so there
  // may be nothing to transition — the state is already correct. Only move a row
  // the job actually parked.
  if (transfer.state === 'UNDER_REVIEW') {
    await transitionTransfer({
      transferId: transfer.id,
      fromState: 'UNDER_REVIEW',
      toState: 'COMPLETED',
      actor,
      reason: 'cancellation request denied — outside the Reg E window',
      metadata: {
        cancellationRequestId: request.id,
        requestedAt: request.requested_at,
        bridgeDepositedAt: input.depositedAt,
      },
      // NO ledger: nothing moved. The transfer delivered and stays delivered.
    })
  } else if (transfer.state !== 'COMPLETED') {
    return { done: false, reason: 'not_under_review', state: transfer.state }
  }

  // Name the ground actually relied on — the two denials are provable from
  // different sources, and an auditor should not have to reconstruct which.
  const ground = request.within_window
    ? `funds deposited at ${input.depositedAt}, before the request at ${request.requested_at}`
    : `request made after the Reg E window; Bridge deposited at ${input.depositedAt}`
  await resolveCancellationRequest({
    transferId: transfer.id,
    status: 'resolved_denied',
    resolution: `denied — ${ground}`,
    resolvedBy: actor,
  })
  return { done: true, outcome: 'denied' }
}

// The already-refunded close must not assert facts that may be false on this
// transfer: REFUNDED can be the PAYOUT_FAILED tail's doing (nothing delivered,
// no correction payment exists). Neutral text states only what is known.
const ALREADY_REFUNDED_RESOLUTION =
  'sender already refunded before this review; request closed — no correction payment was made by this run'

/** Close the request as refunded. Idempotent; guarded on pending in the service. */
async function closeRequest(transferId: string, actor: string, resolution: string): Promise<void> {
  await resolveCancellationRequest({
    transferId,
    status: 'resolved_refunded',
    resolution,
    resolvedBy: actor,
  })
}

/**
 * The ops backlog: every transfer parked at UNDER_REVIEW with an open request,
 * plus every open request whose transfer was NOT routed (the out-of-window ones
 * awaiting a human denial). Both need a person; neither clears on its own.
 *
 * Column list is a PII decision: ids, amounts and timestamps only — never
 * recipient names or destination details, which must not reach an operator's
 * terminal or scrollback.
 */
export interface PendingReview {
  transfer_id: string
  state: string
  send_amount_minor: number
  fee_amount_minor: number
  requested_at: string
  within_window: boolean
  refund_payment_ref: string | null
}

// PostgREST caps every response at max_rows (1000) regardless of the requested
// limit, so a response AT the cap may be silently truncated — fail loud rather
// than present a capped backlog as complete (repo convention; stuck-watch.ts).
const REVIEW_ROW_BOUND = 1000

export async function listPendingReviews(): Promise<PendingReview[]> {
  const { data, error } = await supabaseAdmin
    .from('cancellation_requests')
    .select('transfer_id, requested_at, within_window, transfers!inner(state, send_amount_minor, fee_amount_minor, refund_payment_ref)')
    .eq('status', 'pending')
    .limit(REVIEW_ROW_BOUND)
  // Fail closed: an empty backlog and a broken read must never look the same.
  if (error || data == null) {
    throw new Error(`cancellation review backlog query failed: ${error?.message ?? 'no rows returned'}`)
  }
  if (data.length >= REVIEW_ROW_BOUND) {
    throw new Error(
      `cancellation review backlog hit the ${REVIEW_ROW_BOUND}-row PostgREST cap — results may be silently truncated`,
    )
  }
  type Joined = {
    transfer_id: string
    requested_at: string
    within_window: boolean
    transfers: {
      state: string
      send_amount_minor: number
      fee_amount_minor: number
      refund_payment_ref: string | null
    }
  }
  return (data as unknown as Joined[]).map((r) => ({
    transfer_id: r.transfer_id,
    state: r.transfers.state,
    send_amount_minor: r.transfers.send_amount_minor,
    fee_amount_minor: r.transfers.fee_amount_minor,
    requested_at: r.requested_at,
    within_window: r.within_window,
    refund_payment_ref: r.transfers.refund_payment_ref,
  }))
}
