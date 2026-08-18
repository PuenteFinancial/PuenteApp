// Operator entry point for out-of-band funding — the CLI half of
// POST /v1/ops/transfers/funding.
//
// With no payment gateway, this is how a transfer reaches FUNDED: the sender
// moves USD on a rail Puente does not operate (a Bridge onramp deposit funded
// by FedNow, wire, or ACH) and an operator asserts that it landed. It runs the
// SAME services/funding-apply.ts code the HTTP route runs, so the money moves
// through the transition RPC with its ledger batch — never a bare UPDATE in the
// SQL editor, which would mark a transfer funded without posting the books or
// releasing the payout.
//
// A script AND a route, same as trigger-refund.ts alongside
// POST /v1/ops/cancellations/resolve: the route is for a future ops UI, this is
// the break-glass path that needs no session token (system-map.md §8, "scripts
// before dashboards").
//
// TWO KINDS, and they happen days apart:
//   --kind funded    the deposit landed; open the receivable and release the
//                    payout. Under the pre-funded-float model the payout draws
//                    on Puente's float, so this is the green light.
//   --kind cleared   the sender's money has now actually reimbursed that float;
//                    settle the receivable to cash. Fired later, sometimes much.
//
// Run `--kind funded` only after confirming the deposit against the treasury
// wallet BALANCE — not that a payment was sent. The ledger records what is true.
//
// Usage:
//   tsx scripts/record-manual-funding.ts <transferId> --kind funded \
//     --ref <bridgeTransferId> --amount <usd> --operator <userId> [--confirm]
//
//   --kind funded|cleared  which assertion this is
//   --ref <id>             the provider-side id of the real deposit — the audit
//                          tie from this assertion back to money that moved
//   --amount <usd>         dollars, e.g. 20 or 20.00. Must equal send + fee to
//                          the cent; a mismatch is refused, not rounded
//   --operator <uuid>      recorded as actor `ops:<id>` on the transition — the
//                          ONLY durable record of who authorized this (scripts
//                          write no audit-plugin rows)
//   --confirm              actually record it; WITHOUT it this is a dry run
//
// This imports src/services/*, so config/env.ts validates the full environment
// and exits on anything missing:
//   doppler run -- pnpm exec tsx scripts/record-manual-funding.ts …  (stg/prod)
//   node --env-file=.env --import tsx scripts/record-manual-funding.ts …  (local)
import { formatMoney } from '@puente/shared'
import { recordManualFunding } from '../src/services/funding-apply.js'
import { stopBoss } from '../src/services/queue.js'
import { getFundingProcessor } from '../src/services/funding/index.js'
import { supabaseAdmin } from '../src/services/supabase.js'
import { parseUsdToMinor } from './record-float-topup.js'

const KNOWN_FLAGS = ['--kind', '--ref', '--amount', '--operator', '--confirm']
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export interface ParsedArgs {
  transferId: string
  kind: 'funded' | 'cleared'
  ref: string
  amountMinor: number
  operator: string
  confirm: boolean
}

export function parseArgs(argv: string[]): ParsedArgs {
  for (const arg of argv) {
    if (arg.startsWith('--') && !KNOWN_FLAGS.includes(arg)) {
      throw new Error(`unknown flag ${arg}. Known: ${KNOWN_FLAGS.join(', ')}`)
    }
  }
  const valueOf = (flag: string): string | undefined => {
    const i = argv.indexOf(flag)
    if (i === -1) return undefined
    const v = argv[i + 1]
    // A flag consuming the NEXT flag as its value is the classic way a mistyped
    // command silently means something else. Refuse instead.
    return v === undefined || v.startsWith('--') ? undefined : v
  }

  // Strictly the FIRST argument. Scanning argv for "the first uuid-shaped
  // token" would happily adopt the --operator uuid when the transfer id is
  // omitted, silently acting on a different id than the operator typed.
  const transferId = argv[0]
  if (!transferId || transferId.startsWith('--') || !UUID_RE.test(transferId)) {
    throw new Error('a transfer id (uuid) is required as the first argument')
  }

  const kind = valueOf('--kind')
  if (kind !== 'funded' && kind !== 'cleared') {
    throw new Error('--kind must be "funded" or "cleared"')
  }

  const ref = valueOf('--ref')
  if (!ref) throw new Error('--ref is required (the provider-side deposit id)')

  const rawAmount = valueOf('--amount')
  if (!rawAmount) throw new Error('--amount is required (dollars, e.g. 20.00)')

  const operator = valueOf('--operator')
  if (!operator || !UUID_RE.test(operator)) {
    throw new Error('--operator is required and must be a user uuid')
  }

  return {
    transferId,
    kind,
    ref,
    amountMinor: parseUsdToMinor(rawAmount),
    operator,
    confirm: argv.includes('--confirm'),
  }
}

/** Read-only preview so the dry run can show what is about to be asserted. */
async function loadPreview(transferId: string) {
  const { data } = await supabaseAdmin
    .from('transfers')
    .select('id, state, send_amount_minor, fee_amount_minor, funding_payment_ref, funding_cleared')
    .eq('id', transferId)
    .maybeSingle()
  return data as {
    id: string
    state: string
    send_amount_minor: number
    fee_amount_minor: number
    funding_payment_ref: string | null
    funding_cleared: boolean
  } | null
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2))
  const provider = getFundingProcessor().provider

  console.log(`processor:  ${provider}`)
  if (provider !== 'manual') {
    // The service refuses too — this is the earlier, friendlier stop.
    console.error(
      `\nRefusing: out-of-band funding requires FUNDING_PROCESSOR=manual (currently ${provider}).`,
    )
    console.error('Under stripe, funding_payment_ref is a real PaymentIntent whose settlement')
    console.error('Stripe owns — asserting past it would pay out against a charge that may')
    console.error('never clear.')
    process.exit(1)
  }

  const transfer = await loadPreview(args.transferId)
  if (!transfer) {
    console.error(`\nNo transfer ${args.transferId}.`)
    process.exit(1)
  }

  const expectedMinor = transfer.send_amount_minor + transfer.fee_amount_minor
  const stated = { amountMinor: args.amountMinor, currency: 'USD' as const }
  const expected = { amountMinor: expectedMinor, currency: 'USD' as const }

  console.log(`transfer:   ${transfer.id}`)
  console.log(`state:      ${transfer.state}`)
  console.log(`cleared:    ${transfer.funding_cleared}`)
  console.log(`expected:   ${formatMoney(expected)} (send + fee)`)
  console.log(`stated:     ${formatMoney(stated)}`)
  console.log(`kind:       ${args.kind}`)
  console.log(`ref:        ${args.ref}`)
  console.log(`operator:   ops:${args.operator}`)

  if (args.amountMinor !== expectedMinor) {
    console.error(`\nAmount mismatch — stated ${formatMoney(stated)}, transfer is ${formatMoney(expected)}.`)
    console.error('Refusing: this usually means the wrong transfer or the wrong deposit.')
    process.exit(1)
  }

  console.log(
    args.kind === 'funded'
      ? '\nWould: open the receivable, post the FUNDED ledger batch, release the payout.'
      : '\nWould: settle the funding receivable to cash (no state change).',
  )

  if (!args.confirm) {
    console.log('\nDRY RUN — nothing recorded. Re-run with --confirm.')
    if (args.kind === 'funded') {
      console.log('Confirm the deposit against the treasury wallet BALANCE first.')
    }
    return
  }

  const result = await recordManualFunding({
    transferId: args.transferId,
    kind: args.kind,
    externalRef: args.ref,
    amountMinor: args.amountMinor,
    operator: args.operator,
  })

  if (result.done) {
    console.log(`\nRecorded: ${result.outcome}${result.state ? ` (state ${result.state})` : ''}`)
    if (result.outcome === 'funded') {
      console.log('The worker picks up payout.submit within ~60s. Watch the transfer reach SUBMITTED.')
    }
    if (result.outcome === 'cleared_skipped') {
      console.log('The receivable was never opened or is already closed — no cash leg posted.')
    }
    return
  }

  console.error(`\nRefused: ${result.reason}`)
  switch (result.reason) {
    case 'not_pending_payment':
      console.error(`Transfer is ${result.state}, not PENDING_PAYMENT.`)
      break
    case 'already_funded':
      console.error('Already funded — nothing to do.')
      break
    case 'funding_not_initiated':
      console.error('No funding reference: the sender has not confirmed this transfer yet.')
      break
    case 'amount_mismatch':
      console.error(`Expected ${result.expectedMinor} minor units.`)
      break
    case 'stale':
      console.error('The transfer moved while being funded. Re-read it and retry.')
      break
  }
  process.exit(1)
}

// The --kind funded path releases the payout through applyFundingSucceeded →
// enqueuePayoutSubmit, which lazily opens a pg-boss pool. Nothing in a one-shot
// process ever closed it, so the command sat at the terminal indefinitely after
// its work was already committed — an operator watching a real payout could not
// tell success from failure without querying the database (#196).
//
// stopBoss() releases the pool; the unref'd watchdog is the backstop for
// anything else still holding the loop (the same idiom worker.ts uses on
// shutdown). Unref'd so it never DELAYS an otherwise-clean exit — it only fires
// if the process is somehow still alive when it comes due. Deliberately not a
// bare process.exit(): exiting while stdout is a pipe can truncate the outcome
// line, which is the one line the operator needs.
async function exitCleanly(code: number): Promise<void> {
  process.exitCode = code
  try {
    await stopBoss()
  } catch (err) {
    console.error(`pg-boss stop failed: ${err instanceof Error ? err.message : String(err)}`)
  }
  setTimeout(() => process.exit(code), 2000).unref()
}

// Only run when invoked directly, so the parser stays unit-testable.
if (process.argv[1]?.includes('record-manual-funding')) {
  main().then(
    () => exitCleanly(0),
    (err: unknown) => {
      console.error(err instanceof Error ? err.message : String(err))
      return exitCleanly(1)
    },
  )
}
