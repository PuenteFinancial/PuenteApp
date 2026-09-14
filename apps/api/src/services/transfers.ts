import crypto from 'node:crypto'
import { supabaseAdmin } from './supabase.js'
import { formatRate4 } from './quotes.js'

// The ONLY callers of the slice-4 RPCs. State never changes through a bare
// UPDATE: create_transfer_from_quote and transition_transfer own atomicity
// (state + transition log + ledger batch in one DB transaction).

export type TransferRpcCode =
  | 'quote_not_found'
  | 'quote_consumed'
  | 'quote_expired'
  | 'transfer_not_found'
  | 'transition_conflict'
  | 'transfer_not_cancelable'

const RPC_CODES: readonly TransferRpcCode[] = [
  'quote_not_found',
  'quote_consumed',
  'quote_expired',
  'transfer_not_found',
  'transition_conflict',
  'transfer_not_cancelable',
]

export class TransferRpcError extends Error {
  constructor(public readonly code: TransferRpcCode) {
    super(code)
    this.name = 'TransferRpcError'
  }
}

function throwMapped(message: string, context: string): never {
  const code = RPC_CODES.find((c) => message.includes(c))
  if (code) throw new TransferRpcError(code)
  throw new Error(`${context} failed: ${message}`)
}

export interface TransferRow {
  id: string
  user_id: string
  payout_destination_id: string
  quote_id: string
  state: string
  send_amount_minor: number
  send_currency: string
  receive_amount_minor: number
  receive_currency: string
  fee_amount_minor: number
  fee_currency: string
  margin_minor: number
  fx_rate: number
  funding_source_type: string
  funding_cleared: boolean
  disclosure_accepted_at: string | null
  payment_at: string | null
  cancelable_until: string | null
  idempotency_key: string
  funding_payment_ref: string | null
  // Audit corner 1: the rail that funded this row; null on pre-migration
  // rows (readers fall back to env via processorNameFor).
  funding_processor?: string | null
  provider_transfer_ref: string | null
  refund_payment_ref: string | null
  refunded_at: string | null
  payout_hold_reason: string | null
  payout_held_at: string | null
  submit_attempted_at: string | null
  // Set when the sender asks to cancel a transfer already on its way to payout
  // (slice-7 PR6b). A FLAG ORTHOGONAL TO STATE, not a state: the payout keeps
  // advancing while a request is pending, and the request resolves separately.
  cancellation_requested_at: string | null
  // Set-once when the sender taps "I've sent the payment" on the pay step
  // (funding-ops slice 4). Same orthogonal-flag posture as the cancellation
  // request: a signal to ops, never a state change or a release.
  payment_claimed_at: string | null
  completed_at: string | null
  created_at: string
}

export interface DisclosureRow {
  id: string
  transfer_id: string
  type: string
  locale: string
  content: Record<string, unknown>
  presented_at: string
}

export interface LedgerEntryJson {
  account_code: string
  direction: 'debit' | 'credit'
  amount_minor: number
  currency: 'USD'
}

// ── The three money identities (#193) ────────────────────────────────────────
// Two generations of rows share these builders. Pre-merge rows carry their
// revenue in fee_amount_minor (margin_minor = 0); merged-rate rows carry it in
// margin_minor (fee_amount_minor = 0, send_amount_minor = the full charge).
// Every batch below is written against three identities that are exact for
// BOTH generations:
//   total     = send + fee      (what the customer pays)
//   revenue   = fee + margin    (Puente's take → fee_revenue)
//   principal = send − margin   (owed to the recipient → transfer_payable,
//                                and the S that due_from_bridge tracks)
// At equal bps the resulting batches are byte-identical across generations —
// the economics-neutrality requirement of #193.

interface TransferAmounts {
  send_amount_minor: number
  fee_amount_minor: number
  margin_minor: number
}

const revenueMinor = (t: TransferAmounts): number => t.fee_amount_minor + t.margin_minor
const principalMinor = (t: TransferAmounts): number => t.send_amount_minor - t.margin_minor

// The FUNDED batch (ledger-rules.md): recognize the receivable, the payable
// to the recipient, and Puente's revenue (fee + margin). Zero-revenue
// transfers omit the fee_revenue line — the ledger rejects zero-amount entries.
export function fundedLedgerEntries(transfer: TransferAmounts): LedgerEntryJson[] {
  const total = transfer.send_amount_minor + transfer.fee_amount_minor
  const entries: LedgerEntryJson[] = [
    { account_code: 'funding_receivable', direction: 'debit', amount_minor: total, currency: 'USD' },
    {
      account_code: 'transfer_payable',
      direction: 'credit',
      amount_minor: principalMinor(transfer),
      currency: 'USD',
    },
  ]
  if (revenueMinor(transfer) > 0) {
    entries.push({
      account_code: 'fee_revenue',
      direction: 'credit',
      amount_minor: revenueMinor(transfer),
      currency: 'USD',
    })
  }
  return entries
}

// The ACH CLEARS batch (ledger-rules.md): the sender's ACH actually settled, so
// the receivable opened at FUNDED becomes cash we hold. Independent of the
// transfer's own lifecycle — a transfer can clear before, during or long after
// its payout — which is why it is keyed on its own `FUNDING_CLEARED` transition
// rather than a state change.
//
// WHY THIS EXISTS (2026-08-03): it was specified in ledger-rules.md from the
// start but never implemented, and its absence was not merely an accounting gap.
// `funding_receivable` is what the float ceiling reads (isFloatCeilingTripped),
// so with nothing ever relieving it the balance tracked CUMULATIVE LIFETIME
// VOLUME instead of outstanding float — a one-way ratchet that would trip the
// ceiling permanently and halt every payout once lifetime volume crossed it,
// with no self-healing. Confirmed on a live stack: two transfers COMPLETED with
// funding_cleared=true and the balance still held their full amount.
//
// Timing caveat: Stripe settles in BATCHES (one bank payout covers many charges,
// net of fees), so posting per-transfer on the cleared event approximates the
// moment cash truly lands. The amount is exact; only the timing is approximate.
// Reconciling `cash_clearing` against the real Stripe balance needs the
// balance-transaction ingest (reconciliation.md "Known gaps").
// Total-only: the receivable opened at FUNDED is the full charge regardless
// of how the revenue inside it is labeled, so margin never appears here.
export function fundingClearedLedgerEntries(transfer: TransferAmounts): LedgerEntryJson[] {
  const total = transfer.send_amount_minor + transfer.fee_amount_minor
  return [
    { account_code: 'cash_clearing', direction: 'debit', amount_minor: total, currency: 'USD' },
    { account_code: 'funding_receivable', direction: 'credit', amount_minor: total, currency: 'USD' },
  ]
}

// The CANCELED batch (ledger-rules.md "ACH not yet in flight"): a clean reversal
// of the FUNDED batch. At FUNDED-pre-claim nothing has moved — no payout, no
// float fronted — so the sender's uncleared ACH is *voided* and the FUNDED
// receivable/payable/revenue lines are booked back exactly. The revenue is NOT
// earned on a cancel, so its credit reverses too. Nets to zero; mirrors
// fundedLedgerEntries line-for-line with directions flipped (zero-revenue omits
// the fee line — the ledger rejects zero-amount entries). CANCELED→REFUNDED then
// posts NO ledger: reversing the receivable already zeroed the books.
export function canceledLedgerEntries(transfer: TransferAmounts): LedgerEntryJson[] {
  const total = transfer.send_amount_minor + transfer.fee_amount_minor
  const entries: LedgerEntryJson[] = [
    {
      account_code: 'transfer_payable',
      direction: 'debit',
      amount_minor: principalMinor(transfer),
      currency: 'USD',
    },
  ]
  if (revenueMinor(transfer) > 0) {
    entries.push({
      account_code: 'fee_revenue',
      direction: 'debit',
      amount_minor: revenueMinor(transfer),
      currency: 'USD',
    })
  }
  entries.push({
    account_code: 'funding_receivable',
    direction: 'credit',
    amount_minor: total,
    currency: 'USD',
  })
  return entries
}

// The COMPLETED batch (ledger-rules.md): Bridge confirmed the SPEI deposit —
// extinguish the payable to the recipient against what Bridge owed us.
// S = quoted principal (send − margin); slippage was already recognized at
// SUBMITTED.
export function completedLedgerEntries(transfer: TransferAmounts): LedgerEntryJson[] {
  const principal = principalMinor(transfer)
  return [
    {
      account_code: 'transfer_payable',
      direction: 'debit',
      amount_minor: principal,
      currency: 'USD',
    },
    {
      account_code: 'due_from_bridge',
      direction: 'credit',
      amount_minor: principal,
      currency: 'USD',
    },
  ]
}

// The PAYOUT_FAILED → REFUNDED refund-from-float tail (slice-6 PR2,
// ledger-rules.md "Bridge returns principal"). Two DISTINCT posting keys are
// mandatory — the UNIQUE(transfer_id, transition) index rejects a second row
// under one key — so this is split into the bridge_return batch (posted
// stand-alone, no state change) and the REFUNDED batch (posted with the
// PAYOUT_FAILED → REFUNDED transition).

// bridge_return: Bridge sent the quoted principal S back to our cash; the
// due_from_bridge claim opened at SUBMITTED settles. (⚠️ assumes Bridge returns
// S, not the actual USDC draw A incl. slippage — slice-7 verification item; the
// fx_slippage recognized at SUBMITTED stays realized, never reversed here.)
export function bridgeReturnLedgerEntries(transfer: TransferAmounts): LedgerEntryJson[] {
  const principal = principalMinor(transfer)
  return [
    {
      account_code: 'cash_clearing',
      direction: 'debit',
      amount_minor: principal,
      currency: 'USD',
    },
    {
      account_code: 'due_from_bridge',
      direction: 'credit',
      amount_minor: principal,
      currency: 'USD',
    },
  ]
}

// REFUNDED: recognize and pay the sender's refund in one batch — full amount
// incl. fee, per Reg E (fee refunded on payout failure). Collapses ledger-rules'
// refunds_payable recognize-then-pay pair (it would net to zero instantly, the
// refund being paid from float the same moment) straight to cash_clearing. Nets
// to zero; zero-fee omits the fee line (the ledger rejects zero-amount entries).
export function refundedLedgerEntries(transfer: TransferAmounts): LedgerEntryJson[] {
  const total = transfer.send_amount_minor + transfer.fee_amount_minor
  const entries: LedgerEntryJson[] = [
    {
      account_code: 'transfer_payable',
      direction: 'debit',
      amount_minor: principalMinor(transfer),
      currency: 'USD',
    },
  ]
  if (revenueMinor(transfer) > 0) {
    entries.push({
      account_code: 'fee_revenue',
      direction: 'debit',
      amount_minor: revenueMinor(transfer),
      currency: 'USD',
    })
  }
  entries.push({
    account_code: 'cash_clearing',
    direction: 'credit',
    amount_minor: total,
    currency: 'USD',
  })
  return entries
}

// UNDER_REVIEW → REFUNDED entered from COMPLETED: the post-delivery CORRECTION
// PAYMENT (slice-7 PR6b, ledger-rules.md). Structurally different from
// refundedLedgerEntries even though the sender receives the same amount.
//
// That one REVERSES an obligation we still owed: the payout failed, so
// transfer_payable was still open and the debit closes it. Here the transfer
// DELIVERED — transfer_payable was already discharged by the COMPLETED batch and
// there is nothing to reverse. Paying the sender again is a NEW expense against
// Puente, so it debits an expense account, and the original COMPLETED entries
// are never touched. We do not rewrite delivered history.
//
// Its own account rather than loss_funding_reversed: that bucket is a
// credit/fraud loss (an ACH return after delivery), while this is a compliance
// cost (honouring a timely cancellation on a delivered transfer). Mixing them
// means the ledger cannot answer "what did Reg E cost us" without a per-transfer
// join, and the accounts get harder to separate the longer we wait.
//
// The fee rides with it: the sender is made whole, so send + fee both come back.
// Nets to zero.
export function correctionRefundLedgerEntries(transfer: TransferAmounts): LedgerEntryJson[] {
  const total = transfer.send_amount_minor + transfer.fee_amount_minor
  return [
    {
      account_code: 'loss_cancellation_correction',
      direction: 'debit',
      amount_minor: total,
      currency: 'USD',
    },
    {
      account_code: 'cash_clearing',
      direction: 'credit',
      amount_minor: total,
      currency: 'USD',
    },
  ]
}

// ── PR-S2: the VOIDED variants ───────────────────────────────────────────────
// Under real ACH timing the refund tails usually fire while the funding PI is
// still `processing` (settlement ~T+4, payout failures within minutes), and the
// Stripe adapter then makes the sender whole by CANCELING the pull — no cash
// ever moves. The refunded-mode batches would book cash that never existed:
// refundedLedgerEntries credits cash_clearing S+F for a disbursement that never
// left, and leaves funding_receivable open for an ACH that will never clear.
// Callers pick the batch by FundingUndo.mode / undoModeForRef (funding/index.ts).

// REFUNDED entered from PAYOUT_FAILED, undo mode `voided`: the sender is made
// whole by never being debited, so the FUNDED batch simply reverses — the same
// entries as a FUNDED-window cancel, reached through a different door. The
// bridge_return batch (posted separately) is unchanged: Bridge really did send
// the payout principal back to our cash regardless of how the sender was made
// whole. Nets to zero.
export function voidRefundLedgerEntries(transfer: TransferAmounts): LedgerEntryJson[] {
  return canceledLedgerEntries(transfer)
}

// UNDER_REVIEW → REFUNDED (the post-delivery correction), undo mode `voided`:
// the sender was never debited, so there is no cash credit — the compliance
// loss is recognized against the funding_receivable that will now never
// collect (the pull was canceled). Same P&L as correctionRefundLedgerEntries
// (loss S+F, fee stands as booked); only the credited ASSET differs: a real
// refund pays cash out and lets the receivable settle on its own clearing leg,
// a void writes the receivable off directly. Nets to zero.
export function correctionVoidLedgerEntries(transfer: TransferAmounts): LedgerEntryJson[] {
  const total = transfer.send_amount_minor + transfer.fee_amount_minor
  return [
    {
      account_code: 'loss_cancellation_correction',
      direction: 'debit',
      amount_minor: total,
      currency: 'USD',
    },
    {
      account_code: 'funding_receivable',
      direction: 'credit',
      amount_minor: total,
      currency: 'USD',
    },
  ]
}

// ── The ops cancel of an undeliverable payout (2026-09-14) ──────────────────
//
// A FUNDED transfer parked on an operator-actionable hold that can never clear
// — a destination Bridge will not pay to, a quote too stale to ever pass the
// drift gate — is canceled by an operator and the sender is made whole
// (services/ops-cancel.ts). It walks the SAME two edges as a sender cancel,
// FUNDED → CANCELED → REFUNDED, and posts DIFFERENT batches on them.
//
// WHY NOT canceledLedgerEntries. That batch reverses the FUNDED batch, which is
// only correct while the sender's pull is still UNCLEARED — true by
// construction inside the 30-minute Reg E window, where the sender cancel
// lives. These rows are days or weeks old and `funding_cleared` has already
// posted DR cash_clearing / CR funding_receivable. Reversing FUNDED on top of
// that credits a receivable that is already settled — driving it NEGATIVE,
// which reconciliation's open-item guard flags as an arithmetic impossibility —
// while the cash we actually hold sits unaccounted for. Both staging rows this
// was built for are exactly that shape (cleared, receivable at zero,
// transfer_payable open), so this is a measured fact, not a hypothetical.
//
// So the exit uses the RECOGNIZE-THEN-PAY pair docs/ledger-rules.md has
// specified since the beginning under the CANCELED heading "ACH already in
// flight — keep funding_receivable open; owe refund from float". It was never
// implemented because nothing reached that case until now.
//
// Splitting it across the two transitions is what makes the state order safe.
// The CANCELED leg must commit BEFORE the processor is called — while the state
// still reads FUNDED a hold release could let the sweep submit a payout for a
// transfer we are refunding — but the batch that pays the sender cannot be
// chosen until the processor says HOW it made them whole (PR-S2). Recognizing
// the debt at CANCELED needs no such knowledge, so the order works out: cancel
// first, learn the mode, then pay.
//
// It also gives an honest resting state. A row that stops at CANCELED (an
// out-of-band rail where a human still has to send the money) shows exactly
// what is true: refunds_payable open, sender not yet paid.

// CANCELED, refund owed: we no longer owe the recipient a delivery, and the fee
// is not earned on a transfer that never went — but the sender has not been
// paid yet, so the obligation moves to them rather than vanishing.
// Zero-revenue transfers omit the fee line (the ledger rejects zero-amount
// entries) and still post two entries. Nets to zero.
export function cancelRefundOwedLedgerEntries(transfer: TransferAmounts): LedgerEntryJson[] {
  const total = transfer.send_amount_minor + transfer.fee_amount_minor
  const entries: LedgerEntryJson[] = [
    {
      account_code: 'transfer_payable',
      direction: 'debit',
      amount_minor: principalMinor(transfer),
      currency: 'USD',
    },
  ]
  if (revenueMinor(transfer) > 0) {
    entries.push({
      account_code: 'fee_revenue',
      direction: 'debit',
      amount_minor: revenueMinor(transfer),
      currency: 'USD',
    })
  }
  entries.push({
    account_code: 'refunds_payable',
    direction: 'credit',
    amount_minor: total,
    currency: 'USD',
  })
  return entries
}

// CANCELED → REFUNDED, undo mode `refunded`: the funding had settled, so a real
// disbursement pays the recognized debt out of the cash we are holding.
export function refundOwedPaidLedgerEntries(transfer: TransferAmounts): LedgerEntryJson[] {
  const total = transfer.send_amount_minor + transfer.fee_amount_minor
  return [
    { account_code: 'refunds_payable', direction: 'debit', amount_minor: total, currency: 'USD' },
    { account_code: 'cash_clearing', direction: 'credit', amount_minor: total, currency: 'USD' },
  ]
}

// CANCELED → REFUNDED, undo mode `voided`: the pull was canceled before it
// settled, so the sender is made whole by never being debited and no cash
// moves. The debt is discharged against the receivable that will now never
// collect. Same amount, different asset — the same distinction PR-S2 draws
// between refundedLedgerEntries and voidRefundLedgerEntries.
//
// Reaching this arm means the whole chain nets to the same place a plain
// FUNDED-batch reversal would have: funding_receivable back to zero, nothing
// else touched. It is the long way round to the same books, which is the price
// of not having to know the mode at cancel time.
export function refundOwedVoidedLedgerEntries(transfer: TransferAmounts): LedgerEntryJson[] {
  const total = transfer.send_amount_minor + transfer.fee_amount_minor
  return [
    { account_code: 'refunds_payable', direction: 'debit', amount_minor: total, currency: 'USD' },
    {
      account_code: 'funding_receivable',
      direction: 'credit',
      amount_minor: total,
      currency: 'USD',
    },
  ]
}

// ── The loss path: COMPLETED -> FUNDING_REVERSED (docs/ledger-rules.md) ──────
//
// A dispute or ACH return AFTER the pesos were delivered. Unlike every other
// exit in this file, nothing here can be undone: the recipient has the money,
// the obligation was already discharged by the COMPLETED batch, and the funds
// we collected are being taken back. So this is not a reversal of anything —
// it is recognizing a loss.
//
// POLICY (2026-09-10): book the STRAIGHT LOSS at dispute creation rather than
// opening a user receivable and writing it off later. The ledger is
// append-only, so if we win the dispute or recover the money, a correcting
// CREDIT reverses this batch on its own transition — honest, and it avoids
// carrying per-sender receivable bookkeeping at this scale. ledger-rules.md
// names both options; this is the one we chose.
//
// Amount is send + fee, the whole sum we collected. A partial dispute would
// over-book, which is why the handler records the provider's own reason and
// pages: at this volume a mismatch is a human's call, not a silent proration.
//
// Two variants, exactly like the refund pair above, and picking the wrong one
// invents money. They differ ONLY in the asset credited:

// The funding CLEARED: real cash landed in cash_clearing and is now being
// pulled back out. Nets to zero.
export function fundingReversedLedgerEntries(transfer: TransferAmounts): LedgerEntryJson[] {
  const total = transfer.send_amount_minor + transfer.fee_amount_minor
  return [
    {
      account_code: 'loss_funding_reversed',
      direction: 'debit',
      amount_minor: total,
      currency: 'USD',
    },
    {
      account_code: 'cash_clearing',
      direction: 'credit',
      amount_minor: total,
      currency: 'USD',
    },
  ]
}

// The funding NEVER cleared: an ACH returned while the pull was still in
// flight, so no cash ever reached cash_clearing. Crediting it would claim a
// withdrawal from money we never held, and would leave funding_receivable open
// for a pull that will now never settle. The receivable is written off
// directly instead. Same P&L, different asset. Nets to zero.
export function fundingReversedVoidLedgerEntries(transfer: TransferAmounts): LedgerEntryJson[] {
  const total = transfer.send_amount_minor + transfer.fee_amount_minor
  return [
    {
      account_code: 'loss_funding_reversed',
      direction: 'debit',
      amount_minor: total,
      currency: 'USD',
    },
    {
      account_code: 'funding_receivable',
      direction: 'credit',
      amount_minor: total,
      currency: 'USD',
    },
  ]
}

export async function createTransferFromQuote(input: {
  quoteId: string
  userId: string
  locale: 'en' | 'es'
  disclosureContent: Record<string, unknown>
}): Promise<{ transfer: TransferRow; disclosure: DisclosureRow }> {
  const { data, error } = await supabaseAdmin.rpc('create_transfer_from_quote', {
    p_quote_id: input.quoteId,
    p_user_id: input.userId,
    // the future Bridge-submission key — minted once, at creation
    p_transfer_idempotency_key: crypto.randomUUID(),
    p_disclosure_locale: input.locale,
    p_disclosure_content: input.disclosureContent,
  })
  if (error) throwMapped(error.message, 'create_transfer_from_quote')
  const result = data as { transfer: TransferRow; disclosure: DisclosureRow } | null
  if (!result?.transfer || !result.disclosure) {
    throw new Error('create_transfer_from_quote failed: no result returned')
  }
  return result
}

export async function transitionTransfer(input: {
  transferId: string
  fromState: string
  toState: string
  actor: string
  reason?: string
  metadata?: Record<string, unknown>
  ledgerDescription?: string
  ledgerEntries?: LedgerEntryJson[]
  paymentAt?: Date
  cancelableUntil?: Date
  fundingPaymentRef?: string
  providerTransferRef?: string
}): Promise<TransferRow> {
  const { data, error } = await supabaseAdmin.rpc('transition_transfer', {
    p_transfer_id: input.transferId,
    p_from_state: input.fromState,
    p_to_state: input.toState,
    p_actor: input.actor,
    p_reason: input.reason ?? null,
    p_metadata: input.metadata ?? {},
    p_ledger_description: input.ledgerDescription ?? null,
    p_ledger_entries: input.ledgerEntries ?? null,
    p_payment_at: input.paymentAt?.toISOString() ?? null,
    p_cancelable_until: input.cancelableUntil?.toISOString() ?? null,
    p_funding_payment_ref: input.fundingPaymentRef ?? null,
    p_provider_transfer_ref: input.providerTransferRef ?? null,
  })
  if (error) throwMapped(error.message, 'transition_transfer')
  const row = (Array.isArray(data) ? data[0] : data) as TransferRow | undefined
  if (!row) throw new Error('transition_transfer failed: no row returned')
  return row
}

// The cancel side of the payout-vs-cancel race (slice 6). A dedicated RPC, not
// transition_transfer, because its guarded UPDATE carries the extra race guard
// (submit_attempted_at IS NULL) + the Reg E window check, and it is the
// serialization point against the submit job's claim — exactly one guarded
// UPDATE commits, so a Bridge-payout-exists-but-CANCELED row is structurally
// impossible. Maps 'transfer_not_cancelable' (lost the race, or window expired)
// and 'transfer_not_found'; a CANCELED replay is a no-op returning the row.
export async function cancelTransfer(input: {
  transferId: string
  actor: string
  reason?: string
  ledgerDescription?: string
  ledgerEntries: LedgerEntryJson[]
}): Promise<TransferRow> {
  const { data, error } = await supabaseAdmin.rpc('cancel_transfer', {
    p_transfer_id: input.transferId,
    p_actor: input.actor,
    p_reason: input.reason ?? null,
    p_ledger_description: input.ledgerDescription ?? null,
    p_ledger_entries: input.ledgerEntries,
  })
  if (error) throwMapped(error.message, 'cancel_transfer')
  const row = (Array.isArray(data) ? data[0] : data) as TransferRow | undefined
  if (!row) throw new Error('cancel_transfer failed: no row returned')
  return row
}

// The OPERATOR's cancel of a held, undeliverable payout (2026-09-14). A sibling
// of cancelTransfer, not a flag on it: it keeps that function's binding race
// guard (`submit_attempted_at IS NULL`) and drops the Reg E window, which is
// the sender's statutory right and has no business gating an admission that a
// payout cannot be delivered. In exchange it adds the guard that bounds it —
// `payout_hold_reason = p_hold_reason`, so it can only ever touch a row an
// operator is already holding for exactly the reason they confirmed — and
// clears the hold in the same statement.
//
// Maps 'transfer_not_cancelable' (the state moved, the hold changed, or the
// submit job claimed it) and 'transfer_not_found'; an already-CANCELED row is a
// replay no-op returning the row. The caller re-reads to say WHICH — see
// services/ops-cancel.ts.
export async function opsCancelHeldTransfer(input: {
  transferId: string
  /** `ops:<operator uuid>` */
  actor: string
  /** The hold the operator confirmed — the compare-and-swap, never inferred. */
  holdReason: string
  reason?: string
  ledgerDescription?: string
  ledgerEntries: LedgerEntryJson[]
}): Promise<TransferRow> {
  const { data, error } = await supabaseAdmin.rpc('ops_cancel_held_transfer', {
    p_transfer_id: input.transferId,
    p_actor: input.actor,
    p_hold_reason: input.holdReason,
    p_reason: input.reason ?? null,
    p_ledger_description: input.ledgerDescription ?? null,
    p_ledger_entries: input.ledgerEntries,
  })
  if (error) throwMapped(error.message, 'ops_cancel_held_transfer')
  const row = (Array.isArray(data) ? data[0] : data) as TransferRow | undefined
  if (!row) throw new Error('ops_cancel_held_transfer failed: no row returned')
  return row
}

// numeric(12,4) → exact 4-dp wire string; same argument as quotes.ts:
// the double round-trips exactly at this precision, and the round+BigInt
// path never does float arithmetic on an amount.
export function fxRateToWire(fxRate: number): string {
  return formatRate4(BigInt(Math.round(fxRate * 10_000)))
}

export function toApiTransfer(row: TransferRow) {
  return {
    id: row.id,
    quoteId: row.quote_id,
    payoutDestinationId: row.payout_destination_id,
    state: row.state,
    totalAmount: {
      amountMinor: row.send_amount_minor + row.fee_amount_minor,
      currency: row.send_currency,
    },
    sendAmount: { amountMinor: row.send_amount_minor, currency: row.send_currency },
    feeAmount: { amountMinor: row.fee_amount_minor, currency: row.fee_currency },
    receiveAmount: { amountMinor: row.receive_amount_minor, currency: row.receive_currency },
    fxRate: fxRateToWire(row.fx_rate),
    fundingSourceType: row.funding_source_type,
    fundingCleared: row.funding_cleared,
    disclosureAcceptedAt: row.disclosure_accepted_at,
    paymentAt: row.payment_at,
    cancelableUntil: row.cancelable_until,
    cancellationRequestedAt: row.cancellation_requested_at,
    paymentClaimedAt: row.payment_claimed_at,
    providerTransferRef: row.provider_transfer_ref,
    completedAt: row.completed_at,
    createdAt: row.created_at,
  }
}
