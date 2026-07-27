// Operator trigger for the PAYOUT_FAILED → REFUNDED refund tail — the human
// half of the AUTO_REFUND gate (slice-7 PR6a). With AUTO_REFUND off (the prod
// default) a payout failure parks at PAYOUT_FAILED with a `payout-refund-gated`
// Sentry alert and stays there: the poller does not re-drive it, and flipping
// the flag on later does NOT heal the backlog (recordEvent dedupes the
// re-synthesized terminal event). This script is how those rows get cleared.
//
// It runs the SAME services/refunds.ts code the job runs, so the money moves
// through the ledger RPC — never a bare UPDATE in the SQL editor, which would
// mark a transfer refunded without posting the batches or returning the funds.
// See docs/runbooks/manual-refund.md.
//
// Usage:
//   tsx scripts/trigger-refund.ts --list
//   tsx scripts/trigger-refund.ts <transferId> --operator <id> [--confirm]
//
//   --list          read-only: print the parked backlog and exit
//   --operator <id> required for execution; recorded as actor `ops:<id>` in
//                   transfer_transitions — the ONLY durable record of who did
//                   this (jobs and scripts write no audit-plugin rows)
//   --confirm       actually disburse; WITHOUT it this is a dry run
//
// This imports src/services/*, so config/env.ts validates the full environment
// and exits on anything missing (SUPABASE_*, BRIDGE_API_KEY, …):
//   doppler run -- pnpm exec tsx scripts/trigger-refund.ts …   (staging/prod)
//   node --env-file=.env --import tsx scripts/trigger-refund.ts …   (local)
//
// A script, not an HTTP surface: zero production attack surface.
import {
  refundPayoutFailure,
  verifyPrincipalReturned,
  listRefundBacklog,
  refundLedgerBatches,
} from '../src/services/refunds.js'

const KNOWN_FLAGS = ['--list', '--operator', '--confirm']
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export type ParsedArgs =
  | { mode: 'list' }
  | { mode: 'trigger'; transferId: string; operator: string; confirm: boolean }
  | { mode: 'error'; message: string }

/**
 * Pure arg parsing, exported so it can be tested without executing a refund.
 *
 * Strict on purpose. A money CLI that silently reinterprets a typo is worse
 * than one that refuses: `--comfirm` must not quietly become a dry run that
 * exits 0, and `--operator --confirm` must not disburse under the actor
 * `ops:--confirm` (both of which a lenient parser does — `--confirm` matches
 * the operator charset, and the same token satisfies the confirm check).
 */
export function parseArgs(argv: string[]): ParsedArgs {
  const flagValueIndexes = new Set<number>()
  for (const [i, token] of argv.entries()) {
    if (token === '--operator') flagValueIndexes.add(i + 1)
  }
  for (const [i, token] of argv.entries()) {
    if (token.startsWith('-') && !KNOWN_FLAGS.includes(token) && !flagValueIndexes.has(i)) {
      return { mode: 'error', message: `unknown option "${token}"` }
    }
  }

  const has = (flag: string): boolean => argv.includes(flag)
  const operatorIndex = argv.indexOf('--operator')
  const operator = operatorIndex === -1 ? undefined : argv[operatorIndex + 1]

  if (has('--list')) {
    // --list is read-only; pairing it with execution flags is a confused
    // command, not a request to do both.
    if (argv.length > 1) return { mode: 'error', message: '--list takes no other arguments' }
    return { mode: 'list' }
  }

  const transferId = argv[0]
  if (!transferId || transferId.startsWith('-')) {
    return { mode: 'error', message: 'a transfer id is required' }
  }
  if (!UUID_RE.test(transferId)) {
    return { mode: 'error', message: `"${transferId}" is not a transfer id (expected a UUID)` }
  }

  // A DEFAULTED actor is worthless in an audit trail, so this is required, not
  // optional. Rejecting a leading `-` is what stops `--operator --confirm` from
  // both naming the operator and confirming the disbursement.
  if (operator === undefined || operator.startsWith('-')) {
    return {
      mode: 'error',
      message: '--operator <id> is required: it is recorded as the actor on this refund',
    }
  }
  if (!/^[a-z0-9._-]{2,32}$/.test(operator)) {
    return { mode: 'error', message: `invalid --operator "${operator}" — expected 2-32 chars of [a-z0-9._-]` }
  }

  return { mode: 'trigger', transferId, operator, confirm: has('--confirm') }
}

let step = 0
function begin(label: string): void {
  step++
  console.log(`\n── step ${step}: ${label}`)
}
function pass(msg: string): void {
  console.log(`✓ PASS [${step}] ${msg}`)
}
function fail(msg: string): never {
  console.error(`✗ FAIL [${step}] ${msg}`)
  process.exit(1)
}

const USAGE =
  'usage: tsx scripts/trigger-refund.ts --list\n' +
  '       tsx scripts/trigger-refund.ts <transferId> --operator <id> [--confirm]'

const usd = (minor: number): string => `$${(minor / 100).toFixed(2)}`

async function list(): Promise<void> {
  const rows = await listRefundBacklog()
  if (rows.length === 0) {
    console.log('no parked refunds — nothing at PAYOUT_FAILED awaiting a manual refund')
    return
  }
  console.log(`${rows.length} parked refund(s) awaiting a manual trigger:\n`)
  for (const row of rows) {
    console.log(
      `  ${row.id}  ${usd(row.send_amount_minor + row.fee_amount_minor)}  ` +
        `bridge=${row.provider_transfer_ref ?? '—'}  failed-since=${row.created_at}`,
    )
  }
  console.log('\nrun with <transferId> --operator <id> to inspect one (dry run by default)')
}

async function trigger(transferId: string, operator: string, confirm: boolean): Promise<void> {
  console.log(
    `refund trigger for ${transferId}\n` +
      `operator: ops:${operator}\n` +
      `mode: ${confirm ? 'EXECUTE (--confirm)' : 'DRY RUN (no --confirm)'}`,
  )

  // 1) The principal-returned interlock. bridge_return books
  //    DR cash_clearing / CR due_from_bridge — it ASSERTS Bridge sent our cash
  //    back. Two independent sources must agree before we may post it.
  begin('verify Bridge returned the principal (recorded event + live Bridge)')
  const verdict = await verifyPrincipalReturned(transferId)
  if (!verdict.returned) {
    if (verdict.reason === 'bridge_disagrees' && verdict.bridgeState === 'refund_failed') {
      fail(
        'bridge reports refund_failed — the principal is STUCK AT BRIDGE, not returned. ' +
          'Refunding from float here would book an unreconciled receivable under a ledger ' +
          'rule that does not exist. Escalate per docs/runbooks/manual-refund.md.',
      )
    }
    fail(
      `principal not confirmed returned (${verdict.reason}` +
        `${verdict.bridgeState ? `, bridge=${verdict.bridgeState}` : ''}` +
        `${verdict.eventType ? `, event=${verdict.eventType}` : ''}) — refusing to refund`,
    )
  }
  pass(`principal returned (event=${verdict.eventType}, bridge=${verdict.bridgeState})`)

  // 2) Execute, or stop here on a dry run.
  begin(confirm ? 'refund the sender and settle REFUNDED' : 'dry run — no writes')
  if (!confirm) {
    pass('interlock satisfied; re-run with --confirm to disburse. Nothing was written.')
    return
  }

  const outcome = await refundPayoutFailure({
    transferId,
    actor: `ops:${operator}`,
    reason: 'operator-triggered refund — AUTO_REFUND off',
  })
  if (!outcome.done) {
    fail(`refund refused: ${outcome.reason} (only a transfer at PAYOUT_FAILED can be refunded)`)
  }
  pass(
    {
      refunded: 'sender refunded (send + fee) and state settled',
      already_disbursed:
        'the disbursement had already gone out — no second payment; state settled by this run',
      already_settled: 'ALREADY REFUNDED before this run — nothing was written',
    }[outcome.outcome],
  )

  // 3) Prove both batches landed under their distinct keys.
  begin('verify the ledger batches')
  const batches = await refundLedgerBatches(transferId)
  const keys = batches.map((b) => b.idempotency_key)
  for (const expected of [`${transferId}:bridge_return`, `${transferId}:REFUNDED`]) {
    if (!keys.includes(expected)) fail(`missing ledger batch ${expected}`)
    console.log(`   ${expected}`)
  }
  pass('both refund batches posted')

  // Never claim credit for a run that wrote nothing: the verify query below
  // would show a different actor and make the tool look like it lied.
  console.log(
    outcome.outcome === 'already_settled'
      ? `\n✅ ${transferId} was already REFUNDED — this run changed nothing`
      : `\n✅ ${transferId} refunded by ops:${operator}`,
  )
  console.log(
    `   verify: select actor, from_state, to_state from public.transfer_transitions ` +
      `where transfer_id = '${transferId}' order by created_at;`,
  )
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2))
  if (args.mode === 'error') {
    console.error(`${args.message}\n\n${USAGE}`)
    process.exit(1)
  }
  if (args.mode === 'list') {
    await list()
    return
  }
  // One transfer per run, on purpose: no --all. Looping disbursements from a
  // CLI is how ten refunds go out at once.
  await trigger(args.transferId, args.operator, args.confirm)
}

// Only run when invoked as the CLI — the parser above is imported by its test.
if (process.argv[1]?.includes('trigger-refund')) {
  main().catch((err: unknown) => {
    console.error(`✗ FAIL [${step}] uncaught: ${err instanceof Error ? err.stack : String(err)}`)
    process.exit(1)
  })
}
