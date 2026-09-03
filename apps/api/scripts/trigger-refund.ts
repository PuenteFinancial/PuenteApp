// Operator trigger for the PAYOUT_FAILED → REFUNDED refund tail — the human
// half of the AUTO_REFUND gate (slice-7 PR6a). With AUTO_REFUND off (the prod
// default) a payout failure parks at PAYOUT_FAILED with a `payout-refund-gated`
// Sentry alert and stays there: the poller does not re-drive it, and flipping
// the flag on later does not heal a row whose terminal returned/refunded event
// was ALREADY recorded while the flag was off (recordEvent dedupes the
// re-synthesis). A row still awaiting its first terminal event would be driven
// normally once the flag is on. This script is how the parked rows get cleared.
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
//   --reclaim       clear an ABANDONED refund claim first (slice-7 PR6b-0).
//                   ONLY after confirming in the processor that no disbursement
//                   went out — an abandoned claim means a run died mid-refund
//                   and the sender may already have been paid. Requires
//                   --confirm; clears nothing on a live claim.
//
// This imports src/services/*, so config/env.ts validates the full environment
// and exits on anything missing (SUPABASE_*, BRIDGE_API_KEY, …):
//   doppler run -- pnpm exec tsx scripts/trigger-refund.ts …   (staging/prod)
//   node --env-file=.env --import tsx scripts/trigger-refund.ts …   (local)
//
// A script, not an HTTP surface — nothing here is reachable over the network.
import { formatMoney } from '@puente/shared'
import {
  refundPayoutFailure,
  verifyPrincipalReturned,
  listRefundBacklog,
  refundLedgerBatches,
  refundClaimStatus,
  releaseStaleRefundClaim,
  type RefundOutcome,
} from '../src/services/refunds.js'

const KNOWN_FLAGS = ['--list', '--operator', '--confirm', '--reclaim']
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export type ParsedArgs =
  | { mode: 'list' }
  | {
      mode: 'trigger'
      transferId: string
      operator: string
      confirm: boolean
      reclaim: boolean
    }
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
  // A repeated --operator would let its second value both name the operator and
  // (as `--confirm`) authorize the disbursement, or smuggle an unknown flag past
  // the check below by sitting at a flag-value index.
  if (argv.filter((t) => t === '--operator').length > 1) {
    return { mode: 'error', message: '--operator given more than once' }
  }
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

  // Lowercase it. Postgres accepts an uppercase uuid literal, so the refund
  // itself would run — but ledger idempotency keys are built as
  // `p_transfer_id::text || ':' || p_to_state` in the RPC, and uuid::text always
  // renders lowercase. The step-3 key check would then miss and report FAIL
  // *after* the sender was paid, which is the one outcome this script must
  // never produce.
  // --reclaim clears an abandoned claim so a refund can be re-driven; on a dry
  // run there is no refund to re-drive, so accepting it there would imply the
  // claim had been dealt with when nothing was written.
  if (has('--reclaim') && !has('--confirm')) {
    return { mode: 'error', message: '--reclaim requires --confirm (there is nothing to reclaim on a dry run)' }
  }

  return {
    mode: 'trigger',
    transferId: transferId.toLowerCase(),
    operator,
    confirm: has('--confirm'),
    reclaim: has('--reclaim'),
  }
}

let step = 0
function begin(label: string): void {
  step++
  console.log(`\n── step ${step}: ${label}`)
}
function pass(msg: string): void {
  console.log(`✓ PASS [${step}] ${msg}`)
}

/**
 * A failed step. Throws rather than calling process.exit directly so the
 * refusal paths — the ones that stop a refund — are reachable from a test;
 * main() turns it into the non-zero exit.
 */
export class StepError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'StepError'
  }
}
function fail(msg: string): never {
  throw new StepError(msg)
}

const USAGE =
  'usage: tsx scripts/trigger-refund.ts --list\n' +
  '       tsx scripts/trigger-refund.ts <transferId> --operator <id> [--confirm] [--reclaim]'

const usd = (amountMinor: number): string => formatMoney({ amountMinor, currency: 'USD' }, 'en-US')

export async function list(): Promise<void> {
  const rows = await listRefundBacklog()
  if (rows.length === 0) {
    console.log('no parked refunds — nothing at PAYOUT_FAILED awaiting a manual refund')
    return
  }
  console.log(`${rows.length} parked refund(s) awaiting a manual trigger:\n`)
  for (const row of rows) {
    console.log(
      // `created` is the transfer's creation stamp, NOT the time it failed —
      // transfers has no failed_at column (the failure time lives in
      // transfer_transitions). Labelled honestly so nobody triages on it.
      `  ${row.id}  ${usd(row.send_amount_minor + row.fee_amount_minor)}  ` +
        `bridge=${row.provider_transfer_ref ?? '—'}  created=${row.created_at}` +
        // #254: never reached Bridge. No principal left, so the tail posts no
        // bridge_return; the interlock passes on `not_submitted`.
        (row.provider_transfer_ref === null ? '  ◦ PRE-SUBMIT — never reached Bridge' : '') +
        // A set ref means a prior run paid the sender and died before settling:
        // the money is gone but {id}:REFUNDED was never posted, so the ledger is
        // currently WRONG about this transfer. Re-running finishes it.
        (row.refund_payment_ref ? '  ⚠ ALREADY DISBURSED — needs settling only' : '') +
        // The claim, rendered rather than left as a timestamp to subtract by
        // eye — this is the signal that explains a claim_taken/claim_abandoned
        // refusal, and with AUTO_REFUND off it is the ONLY place an abandoned
        // claim surfaces (the job's alert cannot fire while the flag is off).
        (row.claimStatus === 'claimed'
          ? `  ⏳ claim in progress by ${row.refund_claimed_by ?? '?'} since ${row.refund_claimed_at}`
          : '') +
        (row.claimStatus === 'abandoned'
          ? `  ⚠ CLAIM ABANDONED by ${row.refund_claimed_by ?? '?'} at ${row.refund_claimed_at}` +
            ' — a disbursement MAY have gone out; confirm in the processor, then --reclaim'
          : ''),
    )
  }
  console.log('\nrun with <transferId> --operator <id> to inspect one (dry run by default)')
}

/** The refusal copy. Each says what happened AND what the operator does next. */
function refusalMessage(outcome: Extract<RefundOutcome, { done: false }>): string {
  switch (outcome.reason) {
    case 'claim_taken':
      return (
        `another run is refunding this transfer RIGHT NOW (claimed at ${outcome.claimedAt} by ` +
        `${outcome.claimedBy ?? 'unknown'}). Nothing was written. Wait and re-check --list; it ` +
        'should settle on its own.'
      )
    case 'claim_abandoned':
      return (
        `a refund was claimed at ${outcome.claimedAt} by ${outcome.claimedBy ?? 'unknown'} and ` +
        'NEVER COMPLETED. The sender MAY ALREADY HAVE BEEN PAID — the claim is released only ' +
        'when a disbursement is recorded, and no ref was recorded here.\n' +
        '  Confirm in the funding processor whether a refund went out for this transfer:\n' +
        '    · it DID   → do NOT reclaim. The money is out; escalate per ' +
        'docs/runbooks/manual-refund.md so the state is settled without a second payment.\n' +
        '    · it did NOT → re-run this command with --reclaim to clear the claim and refund.'
      )
    case 'not_payout_failed':
      return `the transfer is ${outcome.state}, not PAYOUT_FAILED — only a failed payout can be refunded`
    case 'transfer_not_found':
      return 'no transfer with that id — check it against --list'
  }
}

export async function trigger(
  transferId: string,
  operator: string,
  confirm: boolean,
  reclaim = false,
): Promise<void> {
  console.log(
    `refund trigger for ${transferId}\n` +
      `operator: ops:${operator}\n` +
      `mode: ${confirm ? 'EXECUTE (--confirm)' : 'DRY RUN (no --confirm)'}` +
      `${reclaim ? '\nreclaim: YES — will clear an abandoned claim first' : ''}`,
  )

  // 1) The principal-returned interlock. bridge_return books
  //    DR cash_clearing / CR due_from_bridge — it ASSERTS Bridge sent our cash
  //    back. Two independent sources must agree before we may post it.
  begin('verify Bridge returned the principal (recorded event + live Bridge)')
  const verdict = await verifyPrincipalReturned(transferId)
  // #254: a row that never reached SUBMITTED has nothing at Bridge to return,
  // and the tail posts no bridge_return for it — so there is no assertion for
  // this interlock to guard. Passing is correct, not lax. Remembered so the
  // ledger check below expects the right batches.
  let preSubmit = false
  if (verdict.returned) {
    pass(`principal returned (event=${verdict.eventType}, bridge=${verdict.bridgeState})`)
  } else if (verdict.reason === 'not_submitted') {
    preSubmit = true
    pass('never submitted to Bridge — nothing left, nothing to return; bridge_return is skipped')
  } else {
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

  // 2) The claim. Reported BEFORE the dry run returns, so an operator learns a
  //    claim is abandoned while they are still deciding — not after --confirm.
  begin('check the refund claim')
  const claim = await refundClaimStatus(transferId)
  if (claim === null) fail('no transfer with that id — check it against --list')
  if (claim.claimStatus === 'abandoned') {
    console.log(
      `⚠ claim abandoned: taken at ${claim.claimedAt} by ${claim.claimedBy ?? 'unknown'}`,
    )
  }
  pass(
    {
      unclaimed: 'no claim on this transfer',
      claimed: `a refund is IN PROGRESS (${claim.claimedBy ?? 'unknown'} since ${claim.claimedAt})`,
      abandoned: `claim ABANDONED by ${claim.claimedBy ?? 'unknown'} at ${claim.claimedAt}`,
    }[claim.claimStatus],
  )

  // 3) Execute, or stop here on a dry run.
  begin(confirm ? 'refund the sender and settle REFUNDED' : 'dry run — no writes')
  if (!confirm) {
    pass('interlock satisfied; re-run with --confirm to disburse. Nothing was written.')
    return
  }

  // --reclaim clears the claim so the tail below can take a fresh one. Guarded
  // in the service to only-if-abandoned, so this cannot yank a live claim from a
  // run that is mid-disbursement — if it clears nothing, the tail refuses again
  // and the operator is told why rather than being reported a success.
  if (reclaim) {
    const released = await releaseStaleRefundClaim(transferId)
    console.log(
      released
        ? '   abandoned claim cleared — re-driving the refund'
        : '   nothing to reclaim (the claim is live, or a disbursement was recorded)',
    )
  }

  const outcome = await refundPayoutFailure({
    transferId,
    actor: `ops:${operator}`,
    reason: 'operator-triggered refund — AUTO_REFUND off',
  })
  if (!outcome.done) {
    fail(`refund refused: ${outcome.reason} — ${refusalMessage(outcome)}`)
  }
  pass(
    {
      refunded: 'sender refunded (send + fee) and state settled',
      already_disbursed:
        'the disbursement had already gone out — no second payment; state settled by this run',
      already_settled: 'ALREADY REFUNDED before this run — nothing was written',
    }[outcome.outcome],
  )

  // 3) Prove the batches landed under their distinct keys — both on a
  //    submitted row, REFUNDED alone on a pre-submit one (#254).
  begin('verify the ledger batches')
  const batches = await refundLedgerBatches(transferId)
  const keys = batches.map((b) => b.idempotency_key)
  const expectedKeys = preSubmit
    ? [`${transferId}:REFUNDED`]
    : [`${transferId}:bridge_return`, `${transferId}:REFUNDED`]
  for (const expected of expectedKeys) {
    if (!keys.includes(expected)) fail(`missing ledger batch ${expected}`)
    console.log(`   ${expected}`)
  }
  pass(preSubmit ? 'REFUNDED batch posted (no bridge_return — pre-submit)' : 'both refund batches posted')

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
  await trigger(args.transferId, args.operator, args.confirm, args.reclaim)
}

// Run only when this file IS the entrypoint — its test imports the exports
// above, and vitest's own argv[1] is the vitest binary, so nothing executes.
if (process.argv[1]?.endsWith('trigger-refund.ts')) {
  main().catch((err: unknown) => {
    // A StepError is an expected refusal: print the message, not a stack.
    console.error(
      err instanceof StepError
        ? `✗ FAIL [${step}] ${err.message}`
        : `✗ FAIL [${step}] uncaught: ${err instanceof Error ? err.stack : String(err)}`,
    )
    process.exit(1)
  })
}
