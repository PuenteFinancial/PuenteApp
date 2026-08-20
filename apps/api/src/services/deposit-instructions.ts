import { env } from '../config/env.js'
import { getBridgeDepositInstructions, BridgeApiError } from './bridge.js'
import { parseDecimalToMinor, PayoutValidationError } from './payouts.js'
import { supabaseAdmin } from './supabase.js'

// #199 — attach the out-of-band deposit instructions to a transfer and read
// them back for the pay step. The instructions are PULLED from the Bridge
// onramp transfer by id, never hand-typed: a transposed digit in a routing
// number is the failure mode this design exists to remove. Shared by the ops
// route and the break-glass script (scripts-before-dashboards, same pattern
// as funding-apply.ts).

export interface DepositInstructionsRow {
  transfer_id: string
  bridge_transfer_ref: string
  currency: string
  amount_minor: number
  payment_rail: string
  bank_name: string
  bank_routing_number: string
  bank_account_number: string
  bank_beneficiary_name: string | null
  deposit_message: string
}

export type AttachOutcome =
  | { outcome: 'attached'; row: DepositInstructionsRow }
  | { outcome: 'unknown_transfer' }
  /** Transfer is past PENDING_PAYMENT — instructions would never render. */
  | { outcome: 'not_pending_payment'; state: string }
  /** Bridge's amount does not equal the transfer's total — wrong onramp. */
  | { outcome: 'amount_mismatch'; expectedMinor: number; bridgeMinor: number | null }
  /** Bridge has no (complete) instructions on that transfer id. */
  | { outcome: 'instructions_unavailable' }

/**
 * Fetch instructions from Bridge and upsert them onto the transfer. Amount is
 * verified against the transfer's total to the cent — a mismatch means the
 * wrong onramp id, and storing it would point the sender's money at a deposit
 * Bridge will never match to this transfer. Re-attach overwrites (the operator
 * recreating an expired onramp must be able to swap coordinates); provenance
 * rides in attached_by (null = attached by the system at confirm — slice 3's
 * onramp-prepare job; a uuid = the human who vouched), history in the audit
 * log.
 */
export async function attachDepositInstructions(input: {
  transferId: string
  bridgeTransferId: string
  operator: string | null
}): Promise<AttachOutcome> {
  const { data } = await supabaseAdmin
    .from('transfers')
    .select('id, state, send_amount_minor, fee_amount_minor')
    .eq('id', input.transferId)
    .single()
  const transfer = data as {
    id: string
    state: string
    send_amount_minor: number
    fee_amount_minor: number
  } | null
  if (!transfer) return { outcome: 'unknown_transfer' }
  if (transfer.state !== 'PENDING_PAYMENT') {
    return { outcome: 'not_pending_payment', state: transfer.state }
  }
  const expectedMinor = transfer.send_amount_minor + transfer.fee_amount_minor

  let instructions
  try {
    instructions = await getBridgeDepositInstructions(input.bridgeTransferId)
  } catch (err) {
    if (err instanceof BridgeApiError && (err.statusCode === 502 || err.statusCode === 404)) {
      return { outcome: 'instructions_unavailable' }
    }
    throw err
  }

  if (instructions.currency !== 'usd') {
    return { outcome: 'instructions_unavailable' }
  }

  // Bridge states the onramp amount as a decimal string; strict 2-dp parse
  // (same rule as payout amounts — more precision means our model is wrong).
  let bridgeMinor: number | null = null
  if (instructions.amount !== null) {
    try {
      bridgeMinor = parseDecimalToMinor(instructions.amount)
    } catch (err) {
      if (!(err instanceof PayoutValidationError)) throw err
      return { outcome: 'amount_mismatch', expectedMinor, bridgeMinor: null }
    }
    if (bridgeMinor !== expectedMinor) {
      return { outcome: 'amount_mismatch', expectedMinor, bridgeMinor }
    }
  }

  const row = {
    transfer_id: transfer.id,
    bridge_transfer_ref: input.bridgeTransferId,
    currency: 'USD',
    amount_minor: expectedMinor,
    payment_rail: instructions.paymentRail,
    bank_name: instructions.bankName,
    bank_routing_number: instructions.bankRoutingNumber,
    bank_account_number: instructions.bankAccountNumber,
    bank_beneficiary_name: instructions.bankBeneficiaryName,
    deposit_message: instructions.depositMessage,
    attached_by: input.operator,
  }
  const { data: saved, error } = await supabaseAdmin
    .from('deposit_instructions')
    .upsert(row, { onConflict: 'transfer_id' })
    .select(
      'transfer_id, bridge_transfer_ref, currency, amount_minor, payment_rail, bank_name, ' +
        'bank_routing_number, bank_account_number, bank_beneficiary_name, deposit_message',
    )
    .single()
  if (error || !saved) {
    throw new Error(`deposit instructions upsert failed: ${error?.message ?? 'no row'}`)
  }
  return { outcome: 'attached', row: saved as unknown as DepositInstructionsRow }
}

/** The pay step's read: null when nothing is attached (the copy falls back). */
export async function getDepositInstructions(
  transferId: string,
): Promise<DepositInstructionsRow | null> {
  const { data } = await supabaseAdmin
    .from('deposit_instructions')
    .select(
      'transfer_id, bridge_transfer_ref, currency, amount_minor, payment_rail, bank_name, ' +
        'bank_routing_number, bank_account_number, bank_beneficiary_name, deposit_message',
    )
    .eq('transfer_id', transferId)
    .maybeSingle()
  return (data as DepositInstructionsRow | null) ?? null
}

/** True when the manual processor is live — the only mode that renders these. */
export function depositInstructionsEnabled(): boolean {
  return env.FUNDING_PROCESSOR === 'manual'
}
