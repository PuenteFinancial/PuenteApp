import * as Sentry from '@sentry/node'
import { env } from '../config/env.js'
import { supabaseAdmin } from './supabase.js'
import { postLedgerTransaction } from './ledger.js'
import { enqueuePayoutSubmit } from './queue.js'
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
    .select('id, state, send_amount_minor, fee_amount_minor')
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
      fundingPaymentRef: input.paymentRef,
    })
  } catch (err) {
    if (err instanceof TransferRpcError && err.code === 'transition_conflict') {
      return { outcome: 'stale' }
    }
    throw err
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
  const { data: clearedRow, error: loadError } = await supabaseAdmin
    .from('transfers')
    .select('state, send_amount_minor, fee_amount_minor, refund_payment_ref')
    .eq('id', input.transferId)
    .maybeSingle()
  if (loadError) throw new Error(`funding_cleared load failed: ${loadError.message}`)

  // A flag, not a state: recorded for the WAIT_FOR_CLEARING policy. The one
  // sanctioned guarded UPDATE outside the transition RPC.
  const { error: updateError } = await supabaseAdmin
    .from('transfers')
    .update({ funding_cleared: true })
    .eq('id', input.transferId)
  if (updateError) throw new Error(`funding_cleared update failed: ${updateError.message}`)

  // Skipped when the receivable was never opened or is already closed:
  // PENDING_PAYMENT/PAYMENT_FAILED never posted FUNDED; CANCELED and a
  // VOIDED-mode refund already credited it back. Each describes a pull that was
  // voided and therefore never truly settles, so a cleared event on one is
  // contradictory data — skip rather than drive the receivable negative.
  const row = clearedRow as {
    state: string
    send_amount_minor: number
    fee_amount_minor: number
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
  const processor = getFundingProcessor()
  if (processor.provider !== 'manual') {
    return { done: false, reason: 'processor_not_manual', provider: processor.provider }
  }

  const { data } = await supabaseAdmin
    .from('transfers')
    .select('id, state, send_amount_minor, fee_amount_minor, funding_payment_ref')
    .eq('id', input.transferId)
    .maybeSingle()
  const transfer = data as {
    id: string
    state: string
    send_amount_minor: number
    fee_amount_minor: number
    funding_payment_ref: string | null
  } | null
  if (!transfer) return { done: false, reason: 'transfer_not_found' }

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
