// Record a treasury wallet top-up on the ledger.
//
// Every payout CREDITS bridge_wallet_float (the USDC drawn to pay a recipient),
// so without a matching debit when the wallet is funded, that account only ever
// falls: it goes negative on the first payout, and the daily
// bridge_wallet_float reconciliation check opens a discrepancy against the real
// Bridge balance. ledger-rules.md specified this batch from the start; nothing
// implemented it until out-of-band funding made topping up a routine act.
//
//   DR bridge_wallet_float  X   USDC now sitting at Bridge
//   CR cash_clearing        X   cash that left our bank to get it there
//
// Run this AFTER the deposit has actually landed — confirm the wallet balance
// moved, not merely that the payment was sent. The ledger records what is true,
// and a top-up booked against money still in flight overstates the float.
//
// The external reference (the Bridge onramp transfer id) becomes the ledger
// idempotency key, so re-running for the same deposit is a no-op rather than a
// double count.
//
// Usage:
//   tsx scripts/record-float-topup.ts --amount <usd> --ref <externalRef> [--confirm]
//
//   --amount <usd>  dollars, e.g. 100 or 100.00 — converted to minor units
//   --ref <id>      the depositing transfer's provider id (idempotency key)
//   --confirm       actually post; WITHOUT it this is a dry run
//
// This imports src/services/*, so config/env.ts validates the full environment:
//   doppler run -- pnpm exec tsx scripts/record-float-topup.ts …   (staging/prod)
//   node --env-file=.env --import tsx scripts/record-float-topup.ts …   (local)
//
// A script, not an HTTP surface — nothing here is reachable over the network.
import { formatMoney } from '@puente/shared'
import { recordFloatTopUp, floatTopUpLedgerEntries } from '../src/services/payouts.js'
import { getAccountBalance } from '../src/services/ledger.js'

const KNOWN_FLAGS = ['--amount', '--ref', '--confirm']

// Dollars → minor units without float arithmetic: the whole point of the money
// rules is that IEEE-754 never touches an amount. Accepts "100", "100.5",
// "100.50"; rejects anything else rather than guessing.
export function parseUsdToMinor(input: string): number {
  const match = /^(\d{1,12})(?:\.(\d{1,2}))?$/.exec(input.trim())
  if (!match) {
    throw new Error(`--amount must be dollars like 100 or 100.00, got "${input}"`)
  }
  const dollars = BigInt(match[1]!)
  const cents = BigInt((match[2] ?? '').padEnd(2, '0'))
  const minor = dollars * 100n + cents
  if (minor <= 0n) throw new Error('--amount must be greater than zero')
  if (minor > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('--amount is implausibly large')
  return Number(minor)
}

// A re-run dedupes inside the ledger (idempotency key), and the old
// unconditional "Posted" then read as a possible double-post mid-incident
// (#214). The before/after delta the script already fetches is the truth:
// full delta = fresh posting; anything else = the ledger deduped this run.
// Messaging only — concurrent postings could skew the delta, but this is a
// single-operator CLI and the balance lines are printed either way.
export function wasFreshPosting(
  beforeMinor: number,
  afterMinor: number,
  amountMinor: number,
): boolean {
  return afterMinor - beforeMinor === amountMinor
}

export function parseArgs(argv: string[]): {
  amountMinor: number
  ref: string
  confirm: boolean
} {
  for (const arg of argv) {
    if (arg.startsWith('--') && !KNOWN_FLAGS.includes(arg)) {
      throw new Error(`unknown flag ${arg}. Known: ${KNOWN_FLAGS.join(', ')}`)
    }
  }
  const valueOf = (flag: string): string | undefined => {
    const i = argv.indexOf(flag)
    return i === -1 ? undefined : argv[i + 1]
  }
  const rawAmount = valueOf('--amount')
  const ref = valueOf('--ref')
  if (!rawAmount) throw new Error('--amount is required')
  if (!ref || ref.startsWith('--')) throw new Error('--ref is required')
  return { amountMinor: parseUsdToMinor(rawAmount), ref, confirm: argv.includes('--confirm') }
}

async function main(): Promise<void> {
  const { amountMinor, ref, confirm } = parseArgs(process.argv.slice(2))
  const money = { amountMinor, currency: 'USD' as const }

  const before = await getAccountBalance('bridge_wallet_float')
  console.log(`bridge_wallet_float before: ${formatMoney(before)}`)
  console.log(`\nWould post (idempotency key float_topup:${ref}):`)
  for (const e of floatTopUpLedgerEntries(amountMinor)) {
    console.log(`  ${e.direction.toUpperCase().padEnd(6)} ${e.account_code.padEnd(20)} ${formatMoney({ amountMinor: e.amount_minor, currency: e.currency })}`)
  }

  if (!confirm) {
    console.log('\nDRY RUN — nothing posted. Re-run with --confirm to record it.')
    return
  }

  const { idempotencyKey } = await recordFloatTopUp({ amountMinor, externalRef: ref })
  const after = await getAccountBalance('bridge_wallet_float')
  if (wasFreshPosting(before.amountMinor, after.amountMinor, amountMinor)) {
    console.log(`\nPosted ${formatMoney(money)} (${idempotencyKey}).`)
  } else {
    console.log(
      `\nAlready recorded (${idempotencyKey}) — the ledger deduped this re-run; no new posting.`,
    )
  }
  console.log(`bridge_wallet_float after: ${formatMoney(after)}`)
}

// Only run when invoked directly, so the parsers stay unit-testable.
if (process.argv[1]?.includes('record-float-topup')) {
  main().catch((err: unknown) => {
    console.error(err instanceof Error ? err.message : String(err))
    process.exit(1)
  })
}
