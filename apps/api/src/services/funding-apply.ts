import * as Sentry from '@sentry/node'
import { env } from '../config/env.js'
import { supabaseAdmin } from './supabase.js'
import { postLedgerTransaction } from './ledger.js'
import { enqueuePayoutSubmit } from './queue.js'
import { recordFloatTopUp } from './payouts.js'
import { getFundingProcessor, undoModeForRef } from './funding/index.js'
import {
  fundedLedgerEntries,
  fundingClearedLedgerEntries,
  transitionTransfer,
  TransferRpcError,
} from './transfers.js'

// The PENDING_PAYMENT → FUNDED / PAYMENT_FAILED transitions and the ACH-clears
// cash leg, lifted out of the funding webhook route so the ops manual-funding
// action drives the SAME code rather than becoming a second writer of FUNDED.
// There is still exactly one implementation of "a transfer became funded"; only
// the trigger differs — a signed processor webhook, or an allowlisted operator
// asserting that an out-of-band deposit landed.
//
// Deliberately a module of its own rather than more surface on transfers.ts:
// that file is the thin wrapper over the state-machine RPCs, while these
// orchestrate an RPC + a ledger post + a queue send. Keeping them separate also
// means transitionTransfer stays an ordinary cross-module import here, so a test
// that stubs it still observes exactly what these appliers ask the RPC to do.
//
// Callers map outcomes to their own transport semantics — a replay is a 200 ack
// to a webhook but a 409 to an operator — so these return a discriminated union
// instead of choosing a status code. Genuine faults (DB, ledger) THROW, so no
// caller can mistake a failed write for a benign skip.

export interface FundingTransferRow {
  id: string
  state: string
  send_amount_minor: number
  fee_amount_minor: number
  margin_minor: number
  /** Read so the FUNDED path can notice a clearing that already arrived — see
   *  the out-of-order catch-up in applyFundingSucceeded. */
  funding_cleared: boolean
  /** Read so a funding event can never REPLACE the ref initiation persisted —
   *  see the guard on fundingPaymentRef in applyFundingSucceeded. */
  funding_payment_ref: string | null
}

export type ApplyFundingOutcome =
  /** Transition committed. `enqueueFailed` is only ever true on the FUNDED
   *  path — the row is funded and payout.sweep re-enqueues within a minute. */
  | { outcome: 'applied'; enqueueFailed: boolean }
  /** Already at the target state — a redelivered or duplicated trigger. */
  | { outcome: 'replayed' }
  /** The guarded UPDATE found a different from_state: the transfer moved past
   *  this event (canceled, already submitted). Never force it. */
  | { outcome: 'stale' }
  | { outcome: 'unknown_transfer' }

async function loadFundingTransfer(transferId: string): Promise<FundingTransferRow | null> {
  const { data } = await supabaseAdmin
    .from('transfers')
    .select('id, state, send_amount_minor, fee_amount_minor, margin_minor, funding_cleared, funding_payment_ref')
    .eq('id', transferId)
    .single()
  return (data as FundingTransferRow | null) ?? null
}

/**
 * PENDING_PAYMENT → FUNDED: the first real money posting of a transfer's life.
 * One DB transaction carries the state change, the transition log row, and the
 * FUNDED ledger batch; the payout enqueue happens strictly AFTER that commit
 * (slice-5 decision 1 — enqueue-after-commit, never a shared transaction), so a
 * lost enqueue can only delay a payout, never fund a transfer without one.
 */
export async function applyFundingSucceeded(input: {
  transferId: string
  paymentRef: string
  eventId: string
  actor: string
  reason?: string
  /** Merged into the transition's metadata. The ops path uses it to record the
   *  operator and the real-world deposit reference alongside the event id. */
  metadata?: Record<string, unknown>
}): Promise<ApplyFundingOutcome> {
  const transfer = await loadFundingTransfer(input.transferId)
  if (!transfer) return { outcome: 'unknown_transfer' }
  if (transfer.state === 'FUNDED') return { outcome: 'replayed' }

  const paymentAt = new Date()
  try {
    await transitionTransfer({
      transferId: transfer.id,
      fromState: 'PENDING_PAYMENT',
      toState: 'FUNDED',
      actor: input.actor,
      reason: input.reason ?? 'funding captured/initiated',
      metadata: { eventId: input.eventId, paymentRef: input.paymentRef, ...input.metadata },
      ledgerDescription: 'transfer FUNDED — funding initiated',
      ledgerEntries: fundedLedgerEntries(transfer),
      paymentAt,
      cancelableUntil: new Date(paymentAt.getTime() + env.CANCEL_WINDOW_MINUTES * 60_000),
      // NEVER REPLACE A REF INITIATION PERSISTED. The RPC coalesces
      // (new ?? existing), so passing the event's ref would overwrite. On the
      // Checkout rail with bank debit that is exactly what happened
      // (2026-09-10, f07c8e67): `payment_intent.processing` beat
      // `checkout.session.completed`, came through the parent PI map as
      // funding_succeeded, and wrote its `pi_…` over the `cs_…` the row was
      // created with — after which void/refund, which look the Session up by
      // that ref, throw on a 404. The event's ref is only ever needed when
      // initiation did not persist one (the deferred crypto rail, whose
      // session exists only from the pay step). Every eager rail already
      // carries the same value both places, so this changes nothing for them.
      fundingPaymentRef: transfer.funding_payment_ref ?? input.paymentRef,
    })
  } catch (err) {
    if (err instanceof TransferRpcError && err.code === 'transition_conflict') {
      return { outcome: 'stale' }
    }
    throw err
  }

  // OUT-OF-ORDER CLEARING CATCH-UP.
  //
  // A clearing event can land BEFORE the funding one, and on the Checkout rail
  // with a card it routinely will: `payment_intent.succeeded` and
  // `checkout.session.completed` are emitted about a second apart and Stripe
  // guarantees no order between them. Observed on the very first real payment
  // (2026-09-09, transfer 681c8e1a): succeeded at :43, completed at :44.
  //
  // applyFundingCleared sets `funding_cleared` unconditionally but SKIPS its
  // ledger leg while the transfer is still PENDING_PAYMENT — correctly, since
  // the receivable it would settle does not exist yet. Without this catch-up
  // nothing ever posts that leg afterwards: a card emits no further event. The
  // row then claims cleared while the ledger still carries an open receivable,
  // forever, and the check that would notice (stripe_receivables) does not run
  // on this rail.
  //
  // So: now that FUNDED has committed and the receivable IS open, re-run the
  // clearing. It re-reads state and is idempotent on (transfer, transition), so
  // the in-order case — where this flag is false here and the real cleared
  // event arrives later — is untouched. Same shape as the catch-up
  // applyOnrampSettlement already does in the other direction.
  //
  // Reported, never thrown: FUNDED is committed and cannot be unwound, and a
  // funded transfer must still get its payout. Same posture as the enqueue.
  //
  // The flag is RE-READ here rather than taken from the load at the top: that
  // load happened before the transition, and a cleared event processed in the
  // gap would have flipped the flag after we looked. The transition RPC held
  // the row lock, so a concurrent applyFundingCleared's UPDATE queued behind
  // it and has committed (or will fail loudly) by the time this read runs.
  const { data: after, error: afterError } = await supabaseAdmin
    .from('transfers')
    .select('funding_cleared')
    .eq('id', transfer.id)
    .maybeSingle()
  if (afterError) Sentry.captureException(new Error(`post-FUNDED re-read failed: ${afterError.message}`))
  if ((after as { funding_cleared?: boolean } | null)?.funding_cleared) {
    try {
      await applyFundingCleared({ transferId: transfer.id })
    } catch (clearErr) {
      Sentry.captureException(clearErr)
    }
  }

  // Immediate payout (slice-5 decision 1). An enqueue failure is REPORTED, not
  // thrown: the transfer is already funded and the ledger batch is committed, so
  // there is nothing to unwind — payout.sweep re-enqueues within a minute
  // (decision 3) and the stately singleton dedupes.
  try {
    await enqueuePayoutSubmit(transfer.id, 'api')
  } catch (enqueueErr) {
    Sentry.captureException(enqueueErr)
    return { outcome: 'applied', enqueueFailed: true }
  }
  return { outcome: 'applied', enqueueFailed: false }
}

/**
 * PENDING_PAYMENT → PAYMENT_FAILED. Terminal, and posts no ledger batch: no
 * funds were ever collected, so there is nothing to reverse.
 */
export async function applyFundingFailed(input: {
  transferId: string
  paymentRef: string
  eventId: string
  actor: string
  reason?: string
}): Promise<ApplyFundingOutcome> {
  const transfer = await loadFundingTransfer(input.transferId)
  if (!transfer) return { outcome: 'unknown_transfer' }
  if (transfer.state === 'PAYMENT_FAILED') return { outcome: 'replayed' }

  try {
    await transitionTransfer({
      transferId: transfer.id,
      fromState: 'PENDING_PAYMENT',
      toState: 'PAYMENT_FAILED',
      actor: input.actor,
      reason: input.reason ?? 'funding failed',
      metadata: { eventId: input.eventId, paymentRef: input.paymentRef },
      // no ledger batch: no funds were ever collected
    })
  } catch (err) {
    if (err instanceof TransferRpcError && err.code === 'transition_conflict') {
      return { outcome: 'stale' }
    }
    throw err
  }
  return { outcome: 'applied', enqueueFailed: false }
}

export type ApplyFundingClearedOutcome =
  | { outcome: 'applied' }
  /** The receivable was never opened, or is already closed. The funding_cleared
   *  flag is still written; only the cash leg is skipped. */
  | { outcome: 'skipped'; state: string }

/**
 * The ACH-clears cash leg: funding_receivable → cash_clearing. Not a state
 * change — a transfer can clear before, during, or long after its payout — so it
 * is keyed on its own `funding_cleared` transition, and a redelivery is a no-op
 * on the ledger's (transfer_id, transition) uniqueness.
 *
 * Throws on any DB or ledger failure, deliberately: the flag is written before
 * the posting, so a silently-dropped cash leg would leave the receivable open
 * forever with nothing to retry it — and isFloatCeilingTripped reads that
 * balance, so the ceiling would ratchet shut and halt every payout.
 */
export async function applyFundingCleared(input: {
  transferId: string
}): Promise<ApplyFundingClearedOutcome> {
  // A flag, not a state: recorded for the WAIT_FOR_CLEARING policy. The one
  // sanctioned guarded UPDATE outside the transition RPC.
  const { error: updateError } = await supabaseAdmin
    .from('transfers')
    .update({ funding_cleared: true })
    .eq('id', input.transferId)
  if (updateError) throw new Error(`funding_cleared update failed: ${updateError.message}`)

  // READ AFTER THE UPDATE, NOT BEFORE. This used to load the row first and
  // judge "is the receivable open?" from that stale read, which lost the
  // clearing leg under concurrency: a FUNDED transition committing between the
  // load and the update left this branch believing the row was still
  // PENDING_PAYMENT.
  //
  // The UPDATE above takes the row lock, so it serializes behind a transition
  // that is mid-commit — but this SELECT is its own PostgREST transaction and
  // does NOT wait for one that starts after the update. On its own, this
  // reordering closes only half the window. The other half is closed by
  // applyFundingSucceeded re-reading the flag AFTER its transition commits and
  // running this applier again if it is set. Each side re-reads after its own
  // write; that pair, not either half, is what makes the two agree whichever
  // order they run in, including at the same instant.
  const { data: clearedRow, error: loadError } = await supabaseAdmin
    .from('transfers')
    .select('state, send_amount_minor, fee_amount_minor, margin_minor, refund_payment_ref')
    .eq('id', input.transferId)
    .maybeSingle()
  if (loadError) throw new Error(`funding_cleared load failed: ${loadError.message}`)

  // Skipped when the receivable was never opened or is already closed:
  // PENDING_PAYMENT/PAYMENT_FAILED never posted FUNDED; CANCELED and a
  // VOIDED-mode refund already credited it back. Each describes a pull that was
  // voided and therefore never truly settles, so a cleared event on one is
  // contradictory data — skip rather than drive the receivable negative.
  const row = clearedRow as {
    state: string
    send_amount_minor: number
    fee_amount_minor: number
    margin_minor: number
    refund_payment_ref: string | null
  } | null
  const receivableClosed =
    row === null ||
    row.state === 'PENDING_PAYMENT' ||
    row.state === 'PAYMENT_FAILED' ||
    row.state === 'CANCELED' ||
    (row.state === 'REFUNDED' &&
      (row.refund_payment_ref === null || undoModeForRef(row.refund_payment_ref) === 'voided'))

  if (receivableClosed) return { outcome: 'skipped', state: row?.state ?? 'unknown' }

  await postLedgerTransaction({
    transferId: input.transferId,
    transition: 'funding_cleared',
    description: 'ach cleared: funding receivable settled to cash',
    entries: fundingClearedLedgerEntries(row).map((e) => ({
      accountCode: e.account_code,
      direction: e.direction,
      money: { amountMinor: e.amount_minor, currency: e.currency },
    })),
  })
  return { outcome: 'applied' }
}

// ── Onramp amount guard (#213) ──────────────────────────────────────────────
// The widget's amount field is user-EDITABLE and the preview API offers no
// lock, so a fulfillment event's word alone must never release a payout: a
// sender who edits the amount down would otherwise buy a full MXN delivery
// with pocket change (the PI rail never needed this — its amount is
// server-fixed — and the manual rail has the operator's to-the-cent check).
// USDC micro-units (6 dp) vs the transfer's send+fee in cents; exact match or
// refuse. An ABSENT amount also refuses (fail closed): if a future preview
// version stops carrying it, the rail holds transfers loudly rather than
// paying out unverified.
const ONRAMP_MICRO_PER_MINOR = 10_000

export type OnrampAmountMismatch = {
  outcome: 'amount_mismatch'
  expectedMinor: number
  /** null = the event carried no parseable amount. */
  deliveredAmountMicro: number | null
}

function onrampAmountMismatch(
  transfer: FundingTransferRow,
  deliveredAmountMicro: number | undefined,
): OnrampAmountMismatch | null {
  const expectedMinor = transfer.send_amount_minor + transfer.fee_amount_minor
  if (deliveredAmountMicro === expectedMinor * ONRAMP_MICRO_PER_MINOR) return null
  return {
    outcome: 'amount_mismatch',
    expectedMinor,
    deliveredAmountMicro: deliveredAmountMicro ?? null,
  }
}

/**
 * Onramp fulfillment_processing → FUNDED, with the amount guard in front:
 * verifies the session's delivered amount against send+fee before delegating
 * to the shared applyFundingSucceeded. A mismatch changes NOTHING — the row
 * stays PENDING_PAYMENT (real money may be arriving at the treasury, so this
 * is an ops review case, never an auto-fail; the reconcile sweep is the
 * eventual backstop) — and the caller pages. Replays short-circuit BEFORE the
 * guard: an already-FUNDED row passed verification once, and a late
 * mismatched redelivery must not page over settled history.
 */
export async function applyOnrampFunded(input: {
  transferId: string
  paymentRef: string
  eventId: string
  deliveredAmountMicro?: number
}): Promise<ApplyFundingOutcome | OnrampAmountMismatch> {
  const transfer = await loadFundingTransfer(input.transferId)
  if (!transfer) return { outcome: 'unknown_transfer' }
  if (transfer.state === 'FUNDED') return { outcome: 'replayed' }

  const mismatch = onrampAmountMismatch(transfer, input.deliveredAmountMicro)
  if (mismatch) return mismatch

  return applyFundingSucceeded({
    transferId: input.transferId,
    paymentRef: input.paymentRef,
    eventId: input.eventId,
    actor: 'webhook:funding',
  })
}

export interface ApplyOnrampSettlementResult {
  /** True when THIS call drove PENDING_PAYMENT → FUNDED (the out-of-order
   *  catch-up ran, or the processing webhook simply hadn't landed yet). */
  caughtUp: boolean
  cleared: ApplyFundingClearedOutcome
  /** The float top-up's ledger idempotency key, or null when the cash leg was
   *  skipped and no top-up may be booked. */
  floatTopUpKey: string | null
}

/**
 * Onramp fulfillment_complete (#213): Stripe delivered the sender's USDC to
 * the treasury. Three legs, in order:
 *
 * 1. CATCH-UP — Stripe does not guarantee webhook order, so
 *    fulfillment_complete can arrive while the transfer still sits in
 *    PENDING_PAYMENT (fulfillment_processing lost the race or the delivery).
 *    applyFundingCleared alone would read PENDING_PAYMENT as
 *    "receivable never opened" and skip the cash leg — stranding a receivable
 *    that the late processing webhook then opens with nothing to ever close
 *    it. So: if the row is still PENDING_PAYMENT, drive FUNDED first.
 * 2. The ACH-clears cash leg via applyFundingCleared, exactly as the manual
 *    rail's cleared assertion.
 * 3. IFF the cash leg posted (not skipped — a canceled/refunded row's
 *    receivable is already closed and must not be topped up), book the float
 *    top-up: real USDC just landed in the treasury wallet, which is the same
 *    physical event the ops board's manual top-up records. amountMinor is
 *    send+fee — the session's destination_amount at USDC≈USD par.
 *
 * Every leg replays clean on its existing key: the FUNDED transition on the
 * state guard, the cash leg on the ledger's (transfer_id, transition)
 * uniqueness, the top-up on float_topup:<sessionId>.
 */
export async function applyOnrampSettlement(input: {
  transferId: string
  paymentRef: string
  eventId: string
  deliveredAmountMicro?: number
}): Promise<ApplyOnrampSettlementResult | OnrampAmountMismatch> {
  const transfer = await loadFundingTransfer(input.transferId)

  // Amount guard (#213) ahead of EVERY leg — the catch-up drives FUNDED and
  // the top-up books send+fee, so a mismatched fulfillment_complete must
  // touch nothing. Checked even on an already-FUNDED row: the cash leg and
  // top-up are still pending here, and contradictory amounts between the two
  // fulfillment events are review-case data, not something to book over.
  if (transfer) {
    const mismatch = onrampAmountMismatch(transfer, input.deliveredAmountMicro)
    if (mismatch) return mismatch
  }

  let caughtUp = false
  if (transfer && transfer.state === 'PENDING_PAYMENT') {
    const applied = await applyFundingSucceeded({
      transferId: input.transferId,
      paymentRef: input.paymentRef,
      eventId: input.eventId,
      actor: 'webhook:funding',
      reason: 'onramp fulfillment_complete before processing — catch-up',
    })
    // 'stale' means another actor moved the row mid-flight (canceled, or the
    // processing webhook landed between our read and the RPC) — fall through:
    // applyFundingCleared re-reads and judges the receivable itself.
    caughtUp = applied.outcome === 'applied'
  }

  const cleared = await applyFundingCleared({ transferId: input.transferId })
  if (cleared.outcome !== 'applied') {
    return { caughtUp, cleared, floatTopUpKey: null }
  }

  if (!transfer) {
    // Unreachable: a cleared cash leg proves the row existed. Guarded so a
    // future reorder can't book a top-up with no amount to trust.
    throw new Error(`onramp settlement: cleared posted for unknown transfer ${input.transferId}`)
  }
  const topUp = await recordFloatTopUp({
    amountMinor: transfer.send_amount_minor + transfer.fee_amount_minor,
    externalRef: input.paymentRef,
  })
  return { caughtUp, cleared, floatTopUpKey: topUp.idempotencyKey }
}

// ── Operator-asserted funding ───────────────────────────────────────────────
// The out-of-band counterpart to the funding webhook: an allowlisted operator
// states that a deposit landed on a rail Puente does not operate, and that
// assertion drives the same appliers a signed webhook would. Everything the
// route needs to refuse lives here so ops.ts stays a transport-mapping layer,
// exactly as it is for cancellation resolution.

export type RecordManualFundingResult =
  | { done: true; outcome: 'funded' | 'cleared' | 'cleared_skipped'; state?: string }
  | { done: false; reason: 'transfer_not_found' }
  | { done: false; reason: 'processor_not_manual'; provider: string }
  | { done: false; reason: 'not_pending_payment'; state: string }
  | { done: false; reason: 'already_funded' }
  | { done: false; reason: 'funding_not_initiated' }
  | { done: false; reason: 'amount_mismatch'; expectedMinor: number }
  | { done: false; reason: 'stale' }

/**
 * Record that an out-of-band deposit landed.
 *
 * `kind: 'funded'` opens the receivable and releases the payout; `kind:
 * 'cleared'` settles that receivable to cash when the sender's money actually
 * arrives. Under the pre-funded-float model these are DAYS APART — the payout
 * goes out against Puente's float and the sender's ACH reimburses it later — so
 * they are two operator actions, not one.
 *
 * Refuses unless FUNDING_PROCESSOR is 'manual'. That guard is the whole safety
 * story: under 'stripe' a transfer's funding_payment_ref is a real PaymentIntent
 * whose settlement Stripe owns, and letting an operator hand-wave it to FUNDED
 * would pay out MXN against a charge that may never clear — the same hole the
 * mock lock exists to close. A lost Stripe webhook is a reconciliation problem,
 * not a thing to assert past.
 */
export async function recordManualFunding(input: {
  transferId: string
  kind: 'funded' | 'cleared'
  externalRef: string
  amountMinor: number
  operator: string
}): Promise<RecordManualFundingResult> {
  const { data } = await supabaseAdmin
    .from('transfers')
    .select('id, state, send_amount_minor, fee_amount_minor, funding_payment_ref, funding_processor')
    .eq('id', input.transferId)
    .maybeSingle()
  const transfer = data as {
    id: string
    state: string
    send_amount_minor: number
    fee_amount_minor: number
    funding_payment_ref: string | null
    funding_processor?: string | null
  } | null
  if (!transfer) return { done: false, reason: 'transfer_not_found' }

  // The load-bearing guard, now keyed on the ROW's rail (audit 2026-09-02
  // corner 1): what matters is whether THIS transfer's funding_payment_ref is
  // an out-of-band deposit an operator can vouch for, or a processor-owned
  // pull whose settlement the processor owns. A row stamped under another
  // rail is refused even on a manual deployment; a manual-stamped row stays
  // recordable after the deployment flips. A null stamp (pre-migration row)
  // falls back to the process rail — the previous behaviour.
  const rail = transfer.funding_processor ?? getFundingProcessor().provider
  if (rail !== 'manual') {
    return { done: false, reason: 'processor_not_manual', provider: rail }
  }

  // The operator states an amount and it must match the transfer to the cent.
  // A mismatch means they are looking at the wrong deposit or the wrong
  // transfer — either way the safe move is to refuse rather than fund against
  // a number nobody reconciled.
  const expectedMinor = transfer.send_amount_minor + transfer.fee_amount_minor
  if (input.amountMinor !== expectedMinor) {
    return { done: false, reason: 'amount_mismatch', expectedMinor }
  }

  if (input.kind === 'cleared') {
    const cleared = await applyFundingCleared({ transferId: transfer.id })
    return cleared.outcome === 'applied'
      ? { done: true, outcome: 'cleared' }
      : { done: true, outcome: 'cleared_skipped', state: cleared.state }
  }

  if (transfer.state === 'FUNDED') return { done: false, reason: 'already_funded' }
  if (transfer.state !== 'PENDING_PAYMENT') {
    return { done: false, reason: 'not_pending_payment', state: transfer.state }
  }
  // Minted by initiateFunding at confirm. Its absence means the sender never
  // accepted the disclosure, so there is no transfer to fund yet.
  if (!transfer.funding_payment_ref) return { done: false, reason: 'funding_not_initiated' }

  const applied = await applyFundingSucceeded({
    transferId: transfer.id,
    // Keep the ref minted at confirm — funding_payment_ref stays "the
    // processor's payment id". The real-world deposit id rides in metadata as
    // the operator's evidence.
    paymentRef: transfer.funding_payment_ref,
    // The external deposit IS the event: unique per real-world arrival, which
    // is what makes the transition log auditable back to money that moved.
    eventId: input.externalRef,
    actor: `ops:${input.operator}`,
    reason: 'out-of-band funding recorded by operator',
    metadata: { externalRef: input.externalRef, operator: input.operator, rail: 'out_of_band' },
  })

  switch (applied.outcome) {
    case 'applied':
      return { done: true, outcome: 'funded' }
    case 'replayed':
      return { done: false, reason: 'already_funded' }
    case 'stale':
      return { done: false, reason: 'stale' }
    case 'unknown_transfer':
      return { done: false, reason: 'transfer_not_found' }
  }
}
