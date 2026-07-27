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

const argv = process.argv.slice(2)
const has = (flag: string): boolean => argv.includes(flag)
const argValue = (flag: string): string | undefined => {
  const i = argv.indexOf(flag)
  return i === -1 ? undefined : argv[i + 1]
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

// A function declaration, not a const arrow: TS only narrows through a
// never-returning call when the callee is a plain name with a declared type.
function usage(): never {
  console.error(
    'usage: tsx scripts/trigger-refund.ts --list\n' +
      '       tsx scripts/trigger-refund.ts <transferId> --operator <id> [--confirm]',
  )
  process.exit(1)
}

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
    outcome.already
      ? 'already disbursed on a previous run — state settled, no second disbursement'
      : 'sender refunded (send + fee) and state settled',
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
  console.log(
    `\n✅ ${transferId} refunded by ops:${operator}\n` +
      `   verify: select actor, from_state, to_state from public.transfer_transitions ` +
      `where transfer_id = '${transferId}' order by created_at;`,
  )
}

async function main(): Promise<void> {
  if (has('--list')) {
    await list()
    return
  }

  const transferId = argv[0]
  if (!transferId || transferId.startsWith('--')) usage()

  // A DEFAULTED actor is worthless in an audit trail, so this is required, not
  // optional. The charset keeps it a readable handle and keeps anything odd out
  // of transfer_transitions.actor (DB caps it at 100 chars).
  const operator = argValue('--operator')
  if (!operator) {
    console.error('--operator <id> is required: it is recorded as the actor on this refund')
    process.exit(1)
  }
  if (!/^[a-z0-9._-]{2,32}$/.test(operator)) {
    console.error(`invalid --operator "${operator}" — expected 2-32 chars of [a-z0-9._-]`)
    process.exit(1)
  }

  // One transfer per run, on purpose: no --all. Looping disbursements from a
  // CLI is how ten refunds go out at once.
  await trigger(transferId, operator, has('--confirm'))
}

main().catch((err: unknown) => {
  console.error(`✗ FAIL [${step}] uncaught: ${err instanceof Error ? err.stack : String(err)}`)
  process.exit(1)
})
