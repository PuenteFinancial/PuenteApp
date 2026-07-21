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

const RPC_CODES: readonly TransferRpcCode[] = [
  'quote_not_found',
  'quote_consumed',
  'quote_expired',
  'transfer_not_found',
  'transition_conflict',
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
  fx_rate: number
  funding_source_type: string
  funding_cleared: boolean
  disclosure_accepted_at: string | null
  payment_at: string | null
  cancelable_until: string | null
  funding_payment_ref: string | null
  provider_transfer_ref: string | null
  payout_hold_reason: string | null
  payout_held_at: string | null
  submit_attempted_at: string | null
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

// The FUNDED batch (ledger-rules.md): recognize the receivable, the payable
// to the recipient, and Puente's fee revenue. Zero-fee transfers omit the fee
// line — the ledger rejects zero-amount entries.
export function fundedLedgerEntries(transfer: {
  send_amount_minor: number
  fee_amount_minor: number
}): LedgerEntryJson[] {
  const total = transfer.send_amount_minor + transfer.fee_amount_minor
  const entries: LedgerEntryJson[] = [
    { account_code: 'funding_receivable', direction: 'debit', amount_minor: total, currency: 'USD' },
    {
      account_code: 'transfer_payable',
      direction: 'credit',
      amount_minor: transfer.send_amount_minor,
      currency: 'USD',
    },
  ]
  if (transfer.fee_amount_minor > 0) {
    entries.push({
      account_code: 'fee_revenue',
      direction: 'credit',
      amount_minor: transfer.fee_amount_minor,
      currency: 'USD',
    })
  }
  return entries
}

// The COMPLETED batch (ledger-rules.md): Bridge confirmed the SPEI deposit —
// extinguish the payable to the recipient against what Bridge owed us.
// S = quoted send principal; slippage was already recognized at SUBMITTED.
export function completedLedgerEntries(transfer: {
  send_amount_minor: number
}): LedgerEntryJson[] {
  return [
    {
      account_code: 'transfer_payable',
      direction: 'debit',
      amount_minor: transfer.send_amount_minor,
      currency: 'USD',
    },
    {
      account_code: 'due_from_bridge',
      direction: 'credit',
      amount_minor: transfer.send_amount_minor,
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
    completedAt: row.completed_at,
    createdAt: row.created_at,
  }
}
