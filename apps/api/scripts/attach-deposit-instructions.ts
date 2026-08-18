// Operator entry point for #199 — the CLI half of
// POST /v1/ops/transfers/deposit-instructions.
//
// Pulls the deposit coordinates (bank name, routing, account, reference code)
// from a hand-created Bridge onramp transfer and attaches them to a Puente
// transfer, so the pay step renders them instead of relying on a text message.
// PULLED, never typed: a transposed digit in a routing number is the failure
// mode this design removes. The amount on the Bridge onramp must equal the
// transfer's total to the cent, or this refuses — a mismatch means the wrong
// onramp id, and the sender's money would land somewhere Bridge won't match.
//
// Run AFTER creating the onramp at Bridge and BEFORE telling the sender to pay.
// Re-running refreshes the stored coordinates (upsert) — do that if the onramp
// was recreated.
//
// Usage:
//   tsx scripts/attach-deposit-instructions.ts <transferId> \
//     --bridge-transfer <onrampId> --operator <userId> [--confirm]
//
//   --bridge-transfer <id>  the Bridge ONRAMP transfer id (the deposit, not
//                           the payout) whose source_deposit_instructions to
//                           attach
//   --operator <uuid>       recorded on the row as attached_by — the durable
//                           record of who attached (scripts write no
//                           audit-plugin rows)
//   --confirm               actually attach; WITHOUT it this is a dry run that
//                           fetches from Bridge and prints what would be stored
import { formatMoney } from '@puente/shared'
import { attachDepositInstructions } from '../src/services/deposit-instructions.js'
import { getBridgeDepositInstructions, BridgeApiError } from '../src/services/bridge.js'
import { supabaseAdmin } from '../src/services/supabase.js'

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export interface AttachArgs {
  transferId: string
  bridgeTransferId: string
  operator: string
  confirm: boolean
}

export function parseArgs(argv: string[]): AttachArgs {
  const positional: string[] = []
  let bridgeTransferId = ''
  let operator = ''
  let confirm = false
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!
    if (arg === '--confirm') confirm = true
    else if (arg === '--bridge-transfer') bridgeTransferId = argv[++i] ?? ''
    else if (arg === '--operator') operator = argv[++i] ?? ''
    else if (arg.startsWith('--')) throw new Error(`Unknown flag: ${arg}`)
    else positional.push(arg)
  }
  const transferId = positional[0] ?? ''
  if (!UUID_RE.test(transferId)) throw new Error('First argument must be the transfer id (uuid)')
  if (!UUID_RE.test(bridgeTransferId)) {
    throw new Error('--bridge-transfer must be the Bridge onramp transfer id (uuid)')
  }
  if (!UUID_RE.test(operator)) throw new Error('--operator must be a user uuid')
  return { transferId, bridgeTransferId, operator, confirm }
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2))

  const { data } = await supabaseAdmin
    .from('transfers')
    .select('id, state, send_amount_minor, fee_amount_minor')
    .eq('id', args.transferId)
    .single()
  const transfer = data as {
    id: string
    state: string
    send_amount_minor: number
    fee_amount_minor: number
  } | null
  if (!transfer) {
    console.error('Transfer not found.')
    process.exit(1)
  }
  const expected = {
    amountMinor: transfer.send_amount_minor + transfer.fee_amount_minor,
    currency: 'USD' as const,
  }

  let preview
  try {
    preview = await getBridgeDepositInstructions(args.bridgeTransferId)
  } catch (err) {
    if (err instanceof BridgeApiError) {
      console.error(`Bridge refused (${err.statusCode}): no complete deposit instructions there.`)
      console.error('Is that the ONRAMP id (the deposit), not the payout?')
      process.exit(1)
    }
    throw err
  }

  console.log(`transfer:   ${transfer.id}`)
  console.log(`state:      ${transfer.state}`)
  console.log(`expected:   ${formatMoney(expected)} (send + fee)`)
  console.log(`onramp:     ${args.bridgeTransferId}`)
  console.log(`rail:       ${preview.paymentRail}`)
  console.log(`bank:       ${preview.bankName}`)
  console.log(`routing:    ${preview.bankRoutingNumber}`)
  console.log(`account:    ····${preview.bankAccountNumber.slice(-4)}`)
  console.log(`reference:  ${preview.depositMessage}`)
  console.log(`amount:     ${preview.amount ?? '(not stated)'} ${preview.currency}`)

  if (!args.confirm) {
    console.log('\nDRY RUN — nothing attached. Re-run with --confirm.')
    return
  }

  const result = await attachDepositInstructions({
    transferId: args.transferId,
    bridgeTransferId: args.bridgeTransferId,
    operator: args.operator,
  })

  switch (result.outcome) {
    case 'attached':
      console.log('\nAttached. The pay step now renders these coordinates.')
      return
    case 'unknown_transfer':
      console.error('\nRefused: transfer not found.')
      break
    case 'not_pending_payment':
      console.error(`\nRefused: transfer is ${result.state}, not PENDING_PAYMENT.`)
      break
    case 'amount_mismatch':
      console.error(
        `\nRefused: onramp amount ${result.bridgeMinor ?? '(unparseable)'} ≠ transfer total ${result.expectedMinor}.`,
      )
      console.error('Wrong onramp id? The sender would wire money Bridge cannot match.')
      break
    case 'instructions_unavailable':
      console.error('\nRefused: Bridge has no complete deposit instructions on that transfer.')
      break
  }
  process.exit(1)
}

// Only run when invoked directly, so the parser stays unit-testable. No
// pg-boss in this path (attach never touches the queue), so a plain return
// exits cleanly — the #196 fix is not needed here.
if (process.argv[1]?.includes('attach-deposit-instructions')) {
  main().catch((err: unknown) => {
    console.error(err instanceof Error ? err.message : String(err))
    process.exit(1)
  })
}
