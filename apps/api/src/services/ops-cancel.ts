import * as Sentry from '@sentry/node'
import { supabaseAdmin } from './supabase.js'
import {
  opsCancelHeldTransfer,
  transitionTransfer,
  cancelRefundOwedLedgerEntries,
  refundOwedPaidLedgerEntries,
  refundOwedVoidedLedgerEntries,
  TransferRpcError,
} from './transfers.js'
import { claimRefund, isClaimAbandoned } from './refunds.js'
import { processorFor, undoModeForRef, undoRequiresManualDisbursement } from './funding/index.js'
import { recordOpsAction } from './ops-actions.js'

// The exit for a funded payout that can never leave (staging cleanup
// 2026-09-14).
//
// A transfer sits FUNDED on an operator-actionable hold whose cause will never
// resolve — a Bridge destination that cannot be paid to, a quote far past the
// drift gate. The sender's money is collected and the recipient will never see
// it. Until now nothing in the system could end that:
//
//   hold-release  re-holds on the next preflight (payout-submit re-checks and
//                 parks the row again) — releasing does not make it payable;
//   ops refund    wraps refundPayoutFailure, which refuses anything that is not
//                 PAYOUT_FAILED, and this row never reached Bridge to fail;
//   sender cancel refuses on the Reg E window, which closed 30 minutes after
//                 payment;
//   the reapers   take SUBMITTED/IN_FLIGHT (sandbox) or delivered UNDER_REVIEW
//                 rows (cancellation review). Neither matches.
//
// So this is a THIRD tail alongside the PAYOUT_FAILED refund (services/refunds)
// and the post-delivery correction (services/cancellation-review), and it walks
// the two edges the state machine already has: FUNDED → CANCELED → REFUNDED.
// No new state, no new edge — the same pair the sender's own cancel uses,
// entered through a different door and posting different batches.
//
// A SERVICE DRIVEN BY A CLI, NOT A BUTTON (the unfreeze-sender.ts precedent).
// This should fire approximately never, and the default answer for a held
// transfer is still to fix the cause and release. A route later is a thin
// wrapper the way /ops/transfers/refund wraps refundPayoutFailure — the
// ordering, the guards and the batches all live here, not in the caller.
//
// THE POLICY GATE LIVES AT THE CALL SITE. No `force` parameter, no flag read:
// the operator IS the gate, exactly as in refundPayoutFailure.
//
// NO CANCELLATION-REQUEST CLOSE, unlike the other two tails — and that is a
// reachability fact, not an oversight. `cancellation_requested_at` is written
// only by submissionInProgressResponse (routes/v1/transfers.ts), which fires
// only for SUBMITTED, IN_FLIGHT, or a FUNDED row the submit job has CLAIMED.
// Every one of those is refused here as `submit_in_progress`, so a row this
// tail can touch cannot carry an open request. If that ever stops being true —
// a new writer of the flag — this needs resolveCancellationRequest on each
// terminal exit, the way services/refunds.ts does.

interface Logger {
  info(obj: Record<string, unknown>, msg: string): void
  warn(obj: Record<string, unknown>, msg: string): void
  error(obj: Record<string, unknown>, msg: string): void
}

/**
 * The holds this tool may discharge — deliberately the four reasons
 * reconciliation already counts as HUMAN_ACTIONED_HOLD_REASONS, i.e. the ones
 * it flags at 24h because a person owes an action on them. Every one of them
 * means: we hold the sender's money, the payout has not left, and only a human
 * can decide whether it ever will.
 *
 * The three that are NOT here, and what to do instead:
 *
 *   funding_disputed  — the money that funded this transfer is being clawed
 *                       back. Refunding the sender pays them a second time out
 *                       of a balance that is already shrinking. The loss path
 *                       owns these rows (docs/runbooks/proposals/funding-reversal.md).
 *   sender_suspended  — the same fact one level up: the sender is frozen on a
 *                       dispute somewhere in their account. Unfreeze first
 *                       (scripts/unfreeze-sender.ts) and the hold releases
 *                       itself; if the payout is ALSO undeliverable, the row
 *                       comes back here under its own reason.
 *   sender_kyc_pending — auto-released by Bridge's approval webhook, with no
 *                       human in the loop. Cancelling one is a bet that an
 *                       approval minutes away will not land, and losing that
 *                       bet refunds a sender whose payout was about to go. Same
 *                       reason it is absent from RELEASABLE_HOLD_REASONS.
 */
export const CANCELABLE_HOLD_REASONS = [
  'payability',
  'velocity_review',
  'fx_drift',
  'submit_error',
] as const
export type CancelableHoldReason = (typeof CANCELABLE_HOLD_REASONS)[number]

const isCancelableHoldReason = (reason: string): reason is CancelableHoldReason =>
  (CANCELABLE_HOLD_REASONS as readonly string[]).includes(reason)

/**
 * `canceled_and_refunded` — this run canceled the transfer AND disbursed.
 * `already_disbursed`     — the money left in a PRIOR run that died before
 *                           settling; this run only finished the state. Kept
 *                           distinct for the same reason the other two tails
 *                           keep it: a tool that says "sender paid" for a run
 *                           that moved nothing is lying about the one fact
 *                           that matters.
 * `already_settled`       — already REFUNDED; this run wrote nothing.
 * `awaiting_disbursement` — the transfer is CANCELED and the undo is recorded,
 *                           but the funds were collected on a rail we do not
 *                           operate (manual, onramp) and a human still has to
 *                           send them back. NOT refunded, and deliberately not
 *                           reported as such.
 */
export type OpsCancelOutcome =
  | { done: true; outcome: 'canceled_and_refunded' | 'already_disbursed' | 'already_settled' }
  | { done: true; outcome: 'awaiting_disbursement'; refundRef: string }
  | { done: false; reason: 'transfer_not_found' }
  | { done: false; reason: 'not_funded'; state: string }
  | { done: false; reason: 'not_held' }
  // The row IS held, but for a reason this tool must not discharge.
  | { done: false; reason: 'hold_not_cancelable'; actual: string }
  // Held for a cancelable reason, but not the one the operator confirmed.
  | { done: false; reason: 'hold_reason_mismatch'; actual: string }
  // The submit job has claimed it, or a Bridge payout already exists. Either
  // way the payout is not ours to cancel.
  | { done: false; reason: 'submit_in_progress' }
  // The row is CANCELED, but by the SENDER's own cancel, not this tool. Its
  // books are already square; finishing it here would double-book.
  | { done: false; reason: 'not_our_cancel' }
  // THE DISPUTE INTERLOCK refused: this funding has been clawed back, so the
  // sender already has their money and there is nothing here to give back.
  // `source` says which half caught it — our own record, or the live provider.
  | {
      done: false
      reason: 'funding_disputed'
      source: 'record' | 'provider'
      disputeRef: string | null
      detail: string
    }
  // The guarded UPDATE refused and a re-read agrees with nothing above: the row
  // moved between the read and the write. Never forced.
  | { done: false; reason: 'changed_underneath'; state: string }
  // The two claim refusals, verbatim from the refund tail and NOT
  // interchangeable: `claim_taken` is silent, `claim_abandoned` pages.
  | { done: false; reason: 'claim_taken'; claimedAt: string | null; claimedBy: string | null }
  | { done: false; reason: 'claim_abandoned'; claimedAt: string | null; claimedBy: string | null }

export interface CancelableTransfer {
  id: string
  state: string
  send_amount_minor: number
  fee_amount_minor: number
  margin_minor: number
  payout_hold_reason: string | null
  payout_held_at: string | null
  submit_attempted_at: string | null
  provider_transfer_ref: string | null
  funding_payment_ref: string | null
  funding_processor?: string | null
  funding_cleared: boolean
  /** Our MIRROR of a dispute webhook — half of the dispute interlock, and the
   *  half that can be silently absent (it was, for three staging rows). */
  funding_disputed_at: string | null
  idempotency_key: string
  refund_payment_ref: string | null
  refund_claimed_at: string | null
  refund_claimed_by: string | null
  payout_destination_id: string
  created_at: string
}

// One string literal, not a concatenation: supabase-js parses the column list
// at the TYPE level and splitting it collapses the row type to
// GenericStringError. Column list is also a PII decision — ids, amounts,
// statuses and timestamps only; never the recipient or where the money goes.
const CANCELABLE_COLUMNS =
  'id, state, send_amount_minor, fee_amount_minor, margin_minor, payout_hold_reason, payout_held_at, submit_attempted_at, provider_transfer_ref, funding_payment_ref, funding_processor, funding_cleared, funding_disputed_at, idempotency_key, refund_payment_ref, refund_claimed_at, refund_claimed_by, payout_destination_id, created_at'

async function loadCancelable(transferId: string): Promise<CancelableTransfer | null> {
  const { data, error } = await supabaseAdmin
    .from('transfers')
    .select(CANCELABLE_COLUMNS)
    .eq('id', transferId)
    .maybeSingle()
  if (error) throw new Error(`ops cancel transfer load failed: ${error.message}`)
  return (data as CancelableTransfer | null) ?? null
}

/**
 * Whether the FUNDED → CANCELED transition on this row is one THIS tail wrote.
 *
 * The discriminator is the transition's metadata: ops_cancel_held_transfer
 * always stamps `{"payout_hold_reason": "<reason>"}` (the reason is required
 * and the column is cleared, so the metadata is the only place it survives),
 * while cancel_transfer — the sender's route — writes `{}`. Cheap, exact, and
 * guaranteed by the RPC rather than inferred from free text.
 *
 * Fails CLOSED: a broken read refuses the resume rather than letting it post a
 * batch against books that may already be square.
 */
async function canceledByOps(transferId: string): Promise<boolean> {
  const { data, error } = await supabaseAdmin
    .from('transfer_transitions')
    .select('metadata')
    .eq('transfer_id', transferId)
    .eq('from_state', 'FUNDED')
    .eq('to_state', 'CANCELED')
    .limit(1)
  if (error || data == null) {
    throw new Error(`ops cancel transition lookup failed: ${error?.message ?? 'no rows returned'}`)
  }
  const metadata = (data as Array<{ metadata: unknown }>)[0]?.metadata
  if (typeof metadata !== 'object' || metadata === null) return false
  return typeof (metadata as Record<string, unknown>)['payout_hold_reason'] === 'string'
}

/**
 * THE DISPUTE INTERLOCK (2026-09-14). Is this funding still ours to give back?
 *
 * Asked before the cancel commits, because a disputed charge has ALREADY
 * returned the sender's money through the card network. Refunding on top of
 * that pays twice; booking a refund the processor will refuse leaves the ledger
 * asserting a debt that does not exist.
 *
 * Two independent sources, and the second is the one that earns the name:
 *
 *   OUR RECORD    `funding_disputed_at`, a `funding_disputed` hold, or the
 *                 FUNDING_REVERSED state. Free to read and usually right — but
 *                 it is a MIRROR of a webhook, and a mirror can be empty. On
 *                 staging three disputes left no trace at all, because the
 *                 handler that writes these fields shipped hours after they
 *                 arrived. A gate that trusted this alone would have passed all
 *                 three.
 *   THE PROVIDER  the live charge. Costs a call and cannot be stale.
 *
 * FAILS CLOSED. A processor that implements getDisputeStatus and then throws —
 * timeout, 5xx, transport — is a refusal, not a pass: silence is not
 * confirmation (verifyPrincipalReturned, same rule). The caller turns the throw
 * into a stop.
 *
 * A rail that does NOT implement getDisputeStatus is a different case, and
 * treating it as a failure would be wrong. The mock cannot be disputed and
 * `manual` collects funds on a rail we do not operate, so there is no question
 * for them to answer — those proceed on our record alone, and `checked` says so
 * rather than leaving the caller to assume the provider was consulted.
 *
 * NOT A SAFETY GUARANTEE, and it should not be described as one. A dispute can
 * land a second after this returns. What makes the operation safe is the refund
 * claim and the ordering; this makes the common failure loud and early instead
 * of a mid-tail throw that strands the row.
 */
export type DisputeVerdict =
  | { disputed: false; checked: 'record_and_provider' | 'record_only' }
  | { disputed: true; source: 'record' | 'provider'; disputeRef: string | null; detail: string }

export async function verifyFundingNotDisputed(
  transfer: Pick<
    CancelableTransfer,
    'state' | 'payout_hold_reason' | 'funding_disputed_at' | 'funding_payment_ref' | 'funding_processor'
  >,
): Promise<DisputeVerdict> {
  // 1) Our record. Cheapest, and decisive when it is set.
  //
  // `!= null`, not `!== null`: an UNDEFINED value means the column was not
  // selected, not that a dispute exists. Strict equality here read every
  // caller that did not ask for the column as disputed and refused the lot —
  // caught by the fixtures the moment this landed. Undefined falls through to
  // the provider half, which is the half that can actually answer.
  if (transfer.funding_disputed_at != null) {
    return {
      disputed: true,
      source: 'record',
      disputeRef: null,
      detail: `funding_disputed_at is set (${transfer.funding_disputed_at})`,
    }
  }
  if (transfer.payout_hold_reason === 'funding_disputed' || transfer.state === 'FUNDING_REVERSED') {
    return {
      disputed: true,
      source: 'record',
      disputeRef: null,
      detail:
        transfer.state === 'FUNDING_REVERSED'
          ? 'the transfer is FUNDING_REVERSED'
          : "the payout is held on 'funding_disputed'",
    }
  }

  // 2) The provider. A null funding ref cannot be looked up — the caller
  //    already refuses such a row before disbursing, so this only avoids
  //    asking an unanswerable question.
  const processor = processorFor(transfer)
  if (!processor.getDisputeStatus || transfer.funding_payment_ref === null) {
    return { disputed: false, checked: 'record_only' }
  }
  // No try/catch: a throw IS the refusal. See the doc comment.
  const live = await processor.getDisputeStatus({ paymentRef: transfer.funding_payment_ref })
  if (live.disputed) {
    return {
      disputed: true,
      source: 'provider',
      disputeRef: live.disputeRef ?? null,
      detail: `the funding charge is disputed at the provider${live.status ? ` (${live.status})` : ''}`,
    }
  }
  return { disputed: false, checked: 'record_and_provider' }
}

/**
 * The refusal gate, pure and exported for tests. Returns null when the row is
 * cancelable under exactly the hold the operator confirmed.
 *
 * Refusing here is a CONVENIENCE — ops_cancel_held_transfer's guarded UPDATE is
 * the real guard — but it turns a race or a typo into a message that says what
 * to do next instead of a puzzling `transfer_not_cancelable`.
 *
 * Order matters: `hold_not_cancelable` is checked before the mismatch so a
 * funding_disputed row gets the refusal that names the loss path, rather than a
 * bare "the hold changed underneath you" that sends an operator looking for a
 * race that never happened.
 */
export function cancelRefusal(
  row: CancelableTransfer | null,
  holdReason: CancelableHoldReason,
): Extract<OpsCancelOutcome, { done: false }> | null {
  if (row == null) return { done: false, reason: 'transfer_not_found' }
  if (row.state !== 'FUNDED') return { done: false, reason: 'not_funded', state: row.state }
  // Both halves of the same fact (docs/transfer-state-machine.md, the binding
  // slice-6 contract): the submit job stamps submit_attempted_at while the
  // state still reads FUNDED, and a Bridge payout may exist from that moment
  // on. Such a row belongs to the payout-failure tail, never here.
  if (row.submit_attempted_at !== null || row.provider_transfer_ref !== null) {
    return { done: false, reason: 'submit_in_progress' }
  }
  if (row.payout_hold_reason == null) return { done: false, reason: 'not_held' }
  if (!isCancelableHoldReason(row.payout_hold_reason)) {
    return { done: false, reason: 'hold_not_cancelable', actual: row.payout_hold_reason }
  }
  if (row.payout_hold_reason !== holdReason) {
    return { done: false, reason: 'hold_reason_mismatch', actual: row.payout_hold_reason }
  }
  return null
}

/**
 * Cancel a held, undeliverable payout and return the sender's money.
 *
 * Reads live state itself rather than trusting a caller-supplied row: this is a
 * money-moving entry point reachable from an operator CLI, so the amounts and
 * the guards come from the database, not from whoever typed the command.
 *
 * THE ORDER IS THE SAFETY PROPERTY, and it differs from the sender cancel
 * route's on purpose:
 *
 *   1. FUNDED → CANCELED, posting the refund-owed batch. The state leaves
 *      FUNDED before anything else happens, which is what closes the payout
 *      race — payout-submit and payout-sweep both stop at "not FUNDED", so once
 *      this commits no payout can be created for this transfer by any path.
 *      Doing the disbursement first would leave a window in which a concurrent
 *      hold release lets the sweep submit a payout for a transfer we have
 *      already refunded.
 *   2. Take the refund CLAIM and disburse. The claim is the same one the other
 *      two tails take (claimRefund) — all three disburse against
 *      `refund_payment_ref` on one transfer, so they must contend on one lock.
 *   3. CANCELED → REFUNDED, posting the batch the undo's MODE selects.
 *
 * Replay-safe at every step: the two ledger batches are keyed (CANCELED /
 * REFUNDED), the RPC treats an already-CANCELED row as a no-op, and the
 * disbursement is gated by the claim. A re-run after a crash resumes from
 * wherever the last one stopped.
 *
 * No release-on-throw, same rule as the other tails: a processor timeout and a
 * processor rejection throw identically, so a failed disbursement leaves the
 * claim standing rather than green-lighting a retry that may pay twice
 * (docs/runbooks/manual-refund.md).
 */
export async function cancelHeldTransfer(
  input: {
    transferId: string
    /** `ops:<operator uuid>` — never defaulted; this is the audit trail. */
    actor: string
    /** The hold the operator confirmed, for the compare-and-swap. */
    holdReason: CancelableHoldReason
    /** What they verified before deciding the payout is undeliverable. */
    note: string
    /** Fastify request id on a route, null in a CLI. */
    requestId: string | null
  },
  log: Logger,
): Promise<OpsCancelOutcome> {
  const loaded = await loadCancelable(input.transferId)
  if (!loaded) return { done: false, reason: 'transfer_not_found' }

  // What this run SAW when it started — captured before anything moves, because
  // the cancel clears the hold and a `before` read off the post-cancel row would
  // record the operator seeing a hold that was already gone (caught by the
  // provenance test). Fixed keys only: that is the PII guard for the jsonb
  // columns.
  const before = {
    state: loaded.state,
    payoutHoldReason: loaded.payout_hold_reason,
    payoutHeldAt: loaded.payout_held_at,
    fundingCleared: loaded.funding_cleared,
  }

  // Idempotent terminal: already made whole. Writes nothing — both batches and
  // the disbursement are keyed, so re-posting would be a no-op anyway, but a
  // replay from a terminal state must not touch the ledger at all.
  if (loaded.state === 'REFUNDED') {
    await recordCancel(input, before, { outcome: 'already_settled', undoMode: null }, log)
    return { done: true, outcome: 'already_settled' }
  }

  // ── 0) the dispute interlock ───────────────────────────────────────────────
  // BEFORE the cancel, not after: the cancel is the irreversible half, and a
  // refusal that arrives later leaves the row stranded at CANCELED with a
  // refunds_payable it will never discharge. That is exactly what happened on
  // staging when nothing asked at all (2026-09-14) — Stripe refused the refund
  // mid-tail and two transfers had to be corrected by hand.
  //
  // Placed after the REFUNDED early-return above: a settled transfer is done,
  // and a dispute arriving afterwards is the loss path's business, not this
  // tail's.
  const verdict = await verifyFundingNotDisputed(loaded)
  if (verdict.disputed) {
    return {
      done: false,
      reason: 'funding_disputed',
      source: verdict.source,
      disputeRef: verdict.disputeRef,
      detail: verdict.detail,
    }
  }

  // ── 1) the cancel ──────────────────────────────────────────────────────────
  // An already-CANCELED row resumes at step 2 (a prior run died between the
  // cancel and the disbursement); anything else must pass the guards.
  let row = loaded
  if (loaded.state === 'CANCELED') {
    // …but ONLY if it is OUR cancel. A row resting at CANCELED from the
    // SENDER's cancel route (its void needs an out-of-band disbursement, or it
    // crashed between the void and the REFUNDED transition) has already posted
    // the FUNDED-batch REVERSAL — its books are square and `refunds_payable`
    // was never credited. Settling it here would post `{id}:REFUNDED` debiting
    // a liability that does not exist, driving refunds_payable negative and
    // crediting cash for a second time. Different door, different tail: those
    // rows belong to the cancel route's void tail
    // (docs/runbooks/manual-refund.md).
    if (!(await canceledByOps(loaded.id))) return { done: false, reason: 'not_our_cancel' }
  } else {
    const refusal = cancelRefusal(loaded, input.holdReason)
    if (refusal != null) return refusal

    try {
      const canceled = await opsCancelHeldTransfer({
        transferId: loaded.id,
        actor: input.actor,
        holdReason: input.holdReason,
        // System vocabulary only. The operator's note is free text and lives in
        // ops_actions.note — never in transfer_transitions.reason.
        reason: `ops cancel — payout undeliverable (hold: ${input.holdReason})`,
        ledgerDescription: `transfer CANCELED — payout undeliverable; refund owed to sender`,
        ledgerEntries: cancelRefundOwedLedgerEntries(loaded),
      })
      // Merge rather than cast: the RPC returns the full transfers row, which
      // TransferRow does not declare the claim columns on. The AMOUNTS come
      // from `loaded` on purpose — they are the ones the batch above was built
      // from and the terms trigger freezes them, so the two cannot drift.
      row = {
        ...loaded,
        state: canceled.state,
        payout_hold_reason: canceled.payout_hold_reason,
        payout_held_at: canceled.payout_held_at,
        refund_payment_ref: canceled.refund_payment_ref,
      }
    } catch (err) {
      if (err instanceof TransferRpcError && err.code === 'transfer_not_found') {
        return { done: false, reason: 'transfer_not_found' }
      }
      if (err instanceof TransferRpcError && err.code === 'transfer_not_cancelable') {
        // The guard refused after our read. ONE re-read says which refusal is
        // true now (the refunds.ts / payout-holds.ts precedent). A row that
        // still classifies as cancelable is unreachable — the CAS would have
        // applied — so it reports `changed_underneath` rather than pretending a
        // cancel happened.
        const fresh = await loadCancelable(input.transferId)
        return (
          cancelRefusal(fresh, input.holdReason) ?? {
            done: false,
            reason: 'changed_underneath',
            state: fresh?.state ?? 'unknown',
          }
        )
      }
      throw err
    }
    log.info(
      { audit: true, transferId: row.id, holdReason: input.holdReason, actor: input.actor },
      'held transfer canceled by ops — payout undeliverable',
    )
  }

  // ── 2) the disbursement ────────────────────────────────────────────────────
  // A ref that ALREADY exists needs no claim: the money left, and all that is
  // missing is the state, which step 3 settles.
  const alreadyDisbursed = row.refund_payment_ref !== null
  let disbursedRef = row.refund_payment_ref
  // Known fresh only on the path that actually calls the processor; the resume
  // path recovers it from the ref's namespace instead (undoModeForRef).
  let undoMode: 'voided' | 'refunded' | null = null

  if (!alreadyDisbursed) {
    // Refuse to disburse against a missing funding ref rather than coercing it
    // to ''. Unreachable in practice — a FUNDED row always has one — so a null
    // here means the row is corrupt, and the fallback would hand the processor
    // an empty payment reference. Checked BEFORE the claim so a row we cannot
    // pay never holds one.
    if (row.funding_payment_ref === null) {
      throw new Error(`ops cancel aborted: transfer ${row.id} has no funding_payment_ref`)
    }

    if (await claimRefund(row.id, input.actor)) {
      // `refund`, not `voidFunding`, even though this began as a cancel: these
      // rows are of unpredictable age, and refund() is the READ-FIRST arm — it
      // resolves the live PaymentIntent and cancels an uncleared pull or
      // refunds a settled one. voidFunding cancels optimistically, which is
      // right inside the 30-minute sender window and wrong here.
      //
      // The ROW's rail, not the process's (audit corner 1): a pull collected
      // under one processor is undone by that processor whatever
      // FUNDING_PROCESSOR says today.
      //
      // Same `:refund` sub-key as the other two tails on purpose. A transfer
      // takes exactly ONE undo path, so sharing the key means a row that
      // somehow reached two of them still dedupes at the processor.
      const undo = await processorFor(row).refund({
        transferId: row.id,
        paymentRef: row.funding_payment_ref,
        amountMinor: row.send_amount_minor + row.fee_amount_minor,
        currency: 'USD',
        idempotencyKey: `${row.idempotency_key}:refund`,
      })
      const { error } = await supabaseAdmin
        .from('transfers')
        .update({ refund_payment_ref: undo.ref, refunded_at: new Date().toISOString() })
        .eq('id', row.id)
        .is('refund_payment_ref', null)
      if (error) throw new Error(`ops cancel refund ref persist failed: ${error.message}`)
      disbursedRef = undo.ref
      undoMode = undo.mode
    } else {
      // Someone holds the claim. ONE re-read tells us which of three it is.
      // A run that lost the claim WRITES NOTHING further — not the
      // disbursement, and not the REFUNDED transition either, which would look
      // harmless (the RPC replays) but would report this run as the one that
      // paid.
      const fresh = await loadCancelable(row.id)
      if (!fresh) return { done: false, reason: 'transfer_not_found' }
      if (fresh.state === 'REFUNDED') {
        await recordCancel(input, before, { outcome: 'already_settled', undoMode: null }, log)
        return { done: true, outcome: 'already_settled' }
      }
      return {
        done: false,
        reason: isClaimAbandoned(fresh.refund_claimed_at) ? 'claim_abandoned' : 'claim_taken',
        claimedAt: fresh.refund_claimed_at,
        claimedBy: fresh.refund_claimed_by,
      }
    }
  }

  if (disbursedRef === null) {
    // Unreachable: every path above either loaded a non-null ref or persisted
    // one. A null is a logic fault — never guess a ledger batch over it.
    throw new Error(`ops cancel settle reached with no disbursement ref for ${row.id}`)
  }

  // ── 3) the settle ─────────────────────────────────────────────────────────
  // An undo the provider cannot actually perform (manual and onramp rails: the
  // funds were collected somewhere we do not operate) has issued NOTHING. The
  // transfer rests at CANCELED with the ref recorded — the honest state, since
  // refunds_payable stays open and says exactly what the sender is owed.
  // Claiming REFUNDED here would tell them their money was returned when
  // nobody has returned it.
  if (undoRequiresManualDisbursement(disbursedRef)) {
    // Nothing else watches a resting CANCELED row: reconciliation's aging
    // buckets cover FUNDED, SUBMITTED, IN_FLIGHT, PAYOUT_FAILED and
    // UNDER_REVIEW, and the ops board's open list does not include CANCELED.
    // So the page IS the follow-up, fingerprinted per transfer.
    Sentry.withScope((scope) => {
      scope.setFingerprint(['ops-cancel-awaiting-disbursement', row.id])
      scope.setContext('ops_cancel', {
        transferId: row.id,
        refundRef: disbursedRef,
        holdReason: input.holdReason,
        runbook: 'docs/runbooks/payout-holds.md',
      })
      Sentry.captureMessage(
        'ops cancel: sender owed an out-of-band refund — transfer resting at CANCELED',
        'error',
      )
    })
    log.warn(
      { audit: true, transferId: row.id, refundRef: disbursedRef },
      'ops cancel: refund awaits an out-of-band disbursement — holding at CANCELED',
    )
    await recordCancel(
      input,
      before,
      { outcome: 'awaiting_disbursement', undoMode: undoMode ?? undoModeForRef(disbursedRef) },
      log,
    )
    return { done: true, outcome: 'awaiting_disbursement', refundRef: disbursedRef }
  }

  // The BATCH depends on HOW the sender was made whole (PR-S2). `undo.mode` is
  // authoritative when this run disbursed; the crash-recovery path has only the
  // persisted ref, which is why the mode is prefix-encoded in the ref namespace.
  const mode = undoMode ?? undoModeForRef(disbursedRef)
  await transitionTransfer({
    transferId: row.id,
    fromState: 'CANCELED',
    toState: 'REFUNDED',
    actor: input.actor,
    reason: 'payout undeliverable — sender made whole',
    ledgerDescription:
      mode === 'voided'
        ? 'transfer REFUNDED — undeliverable payout; uncleared funding voided (receivable written off)'
        : 'transfer REFUNDED — undeliverable payout; sender refunded from cash',
    ledgerEntries: mode === 'voided' ? refundOwedVoidedLedgerEntries(row) : refundOwedPaidLedgerEntries(row),
  })

  const outcome = alreadyDisbursed ? 'already_disbursed' : 'canceled_and_refunded'
  await recordCancel(input, before, { outcome, undoMode: mode }, log)
  return { done: true, outcome }
}

/**
 * The provenance row — one per operator action, written at the END so `after`
 * can carry what actually happened rather than what was intended.
 *
 * Best-effort and never throws (recordOpsAction's contract): the state change,
 * the ledger batches and the transition actor are the PRIMARY record, and a
 * failed secondary write must not turn a completed refund into an error that
 * invites a retry. If a run dies before reaching here, transfer_transitions
 * still names the actor on both edges — only the note is lost.
 *
 * Fixed keys only; that is the PII guard for the two jsonb columns.
 */
async function recordCancel(
  input: { transferId: string; actor: string; holdReason: string; note: string; requestId: string | null },
  before: Record<string, unknown>,
  result: { outcome: string; undoMode: 'voided' | 'refunded' | null },
  log: Logger,
): Promise<void> {
  await recordOpsAction(
    {
      actor: input.actor,
      action: 'transfer_cancel',
      transferId: input.transferId,
      // MACHINE vocabulary: the hold that could not clear.
      reason: input.holdReason,
      note: input.note,
      before,
      after: {
        state: result.outcome === 'awaiting_disbursement' ? 'CANCELED' : 'REFUNDED',
        outcome: result.outcome,
        undoMode: result.undoMode,
      },
      requestId: input.requestId,
    },
    log,
  )
}

// ── Read-only ops surface for the CLI ───────────────────────────────────────
// Deliberately here rather than in the script: nothing under scripts/ queries
// the database directly — DB access stays under src/ — and the column list is a
// PII decision.

export interface HeldCandidate {
  id: string
  send_amount_minor: number
  fee_amount_minor: number
  payout_hold_reason: string
  payout_held_at: string | null
  funding_cleared: boolean
  refund_payment_ref: string | null
  /** The dispute interlock's inputs, so the CLI can preview the verdict
   *  without a second read of the same row. */
  funding_disputed_at: string | null
  funding_payment_ref: string | null
  funding_processor: string | null
  /** So a caller can re-probe the live cause without a second query. */
  payout_destination_id: string
  created_at: string
  /** False for a hold this tool refuses to discharge — rendered, not hidden. */
  cancelable: boolean
}

const CANDIDATE_COLUMNS =
  'id, send_amount_minor, fee_amount_minor, payout_hold_reason, payout_held_at, funding_cleared, refund_payment_ref, funding_disputed_at, funding_payment_ref, funding_processor, payout_destination_id, created_at'

const ROW_BOUND = 1000

/**
 * Every FUNDED transfer currently parked on a hold — not only the cancelable
 * ones.
 *
 * Listing the excluded reasons too (funding_disputed, sender_suspended,
 * sender_kyc_pending) is deliberate: an operator running this to find out why a
 * sender's money is stuck must not read a filtered list as "there is nothing
 * held here" and go looking elsewhere. Each row says whether this tool will
 * touch it.
 *
 * Rows the submit job has already claimed are excluded, because those are
 * genuinely not this tool's to cancel and showing them would invite the attempt.
 */
export async function listHeldTransfers(): Promise<HeldCandidate[]> {
  const { data, error } = await supabaseAdmin
    .from('transfers')
    .select(CANDIDATE_COLUMNS)
    .eq('state', 'FUNDED')
    .not('payout_hold_reason', 'is', null)
    .is('submit_attempted_at', null)
    .limit(ROW_BOUND)
  // Fail closed: an empty backlog and a broken read must never look the same.
  if (error || data == null) {
    throw new Error(`held transfer query failed: ${error?.message ?? 'no rows returned'}`)
  }
  // Loud, not silent: PostgREST caps a page at max-rows and a truncated list
  // would read as "fewer senders are stuck" — the exact under-count the ops
  // surfaces exist to prevent.
  if (data.length >= ROW_BOUND) {
    throw new Error(
      `held transfer query hit the ${ROW_BOUND}-row PostgREST cap — results may be silently truncated`,
    )
  }
  return (data as Omit<HeldCandidate, 'cancelable'>[]).map((row) => ({
    ...row,
    cancelable: isCancelableHoldReason(row.payout_hold_reason),
  }))
}

/** The posting batches on a transfer — the operator's proof both keys landed. */
export async function cancelLedgerBatches(transferId: string): Promise<string[]> {
  const { data, error } = await supabaseAdmin
    .from('ledger_transactions')
    .select('idempotency_key')
    .eq('transfer_id', transferId)
  if (error || data == null) {
    throw new Error(`ops cancel ledger batch query failed: ${error?.message ?? 'no rows returned'}`)
  }
  return (data as Array<{ idempotency_key: string }>).map((b) => b.idempotency_key)
}
