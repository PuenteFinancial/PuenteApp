// Operator resolution for a post-submission cancellation request whose payout
// DELIVERED (slice-7 PR6b). The sender asked to cancel a transfer that was
// already on its way; the payout completed anyway; payment-event-process parked
// the transfer at UNDER_REVIEW because the ask was timely. Reg E obliges us to
// make the sender whole even though the recipient keeps the money — the
// accepted, bounded double-pay. Nothing clears that state automatically, by
// design: a post-delivery payment is a human decision.
//
// Two lawful exits, and only these:
//   --refund            pay the sender a CORRECTION PAYMENT and settle REFUNDED
//   --deny --deposited-at <iso>   close an UNTIMELY request; back to COMPLETED
//
// The tool REFUSES to deny a timely request. A timely cancellation on a
// delivered transfer is owed a refund, full stop; if one genuinely must not be
// paid, that is an escalation, not a flag.
//
// It runs the SAME services/ code the rest of the system runs, so the money
// moves through the ledger RPC — never a bare UPDATE in the SQL editor, which
// would mark a transfer refunded without posting the batch or returning funds.
// See docs/runbooks/pending-cancellation.md.
//
// Usage:
//   tsx scripts/resolve-cancellation.ts --list
//   tsx scripts/resolve-cancellation.ts <transferId> --operator <id> --refund [--confirm]
//   tsx scripts/resolve-cancellation.ts <transferId> --operator <id> --deny \
//       --deposited-at <iso8601> [--confirm]
//
//   --list           read-only: print the open review backlog and exit
//   --operator <id>  required; recorded as actor `ops:<id>` on the transition and
//                    as resolved_by on the request — the only durable record of
//                    who decided this
//   --confirm        actually write; WITHOUT it this is a dry run
//   --deposited-at   required with --deny: Bridge's deposit timestamp, read from
//                    the Bridge dashboard (getBridgeTransfer returns only
//                    id/state/sourceAmount). The evidence that delivery preceded
//                    the ask, recorded so the denial is provable later.
//
// This imports src/services/*, so config/env.ts validates the full environment:
//   doppler run -- pnpm exec tsx scripts/resolve-cancellation.ts …   (staging/prod)
//   node --env-file=.env --import tsx scripts/resolve-cancellation.ts …   (local)
//
// A script, not an HTTP surface — nothing here is reachable over the network.
import { formatMoney } from '@puente/shared'
import {
  refundCancellation,
  denyCancellation,
  listPendingReviews,
  type ReviewOutcome,
} from '../src/services/cancellation-review.js'

const KNOWN_FLAGS = ['--list', '--operator', '--confirm', '--refund', '--deny', '--deposited-at']
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

// The resolve variant splits on `action` so the parser's hardest-won runtime
// invariant — `--deposited-at` iff `--deny` — is also the compiler's: a deny
// without a deposit timestamp is unrepresentable, so no consumer can smuggle
// `undefined` into denyCancellation's legal guard (PR6b review fix; the old
// shape needed `args.depositedAt!` at the call site).
export type ParsedArgs =
  | { mode: 'list' }
  | { mode: 'resolve'; action: 'refund'; transferId: string; operator: string; confirm: boolean }
  | {
      mode: 'resolve'
      action: 'deny'
      transferId: string
      operator: string
      confirm: boolean
      depositedAt: string
    }
  | { mode: 'error'; message: string }

/**
 * Pure arg parsing, exported so it can be tested without moving money.
 *
 * Strict on purpose, and for the same reasons trigger-refund.ts is: a money CLI
 * that silently reinterprets a typo is worse than one that refuses. `--refund`
 * and `--deny` are opposite outcomes on the same transfer, so a command that is
 * ambiguous between them must never pick one.
 */
export function parseArgs(argv: string[]): ParsedArgs {
  // A repeated value-taking flag lets its second value both name the thing and
  // (as another flag) smuggle an option past the unknown-option check below.
  for (const flag of ['--operator', '--deposited-at']) {
    if (argv.filter((t) => t === flag).length > 1) {
      return { mode: 'error', message: `${flag} given more than once` }
    }
  }
  const flagValueIndexes = new Set<number>()
  for (const [i, token] of argv.entries()) {
    if (token === '--operator' || token === '--deposited-at') flagValueIndexes.add(i + 1)
  }
  for (const [i, token] of argv.entries()) {
    if (token.startsWith('-') && !KNOWN_FLAGS.includes(token) && !flagValueIndexes.has(i)) {
      return { mode: 'error', message: `unknown option "${token}"` }
    }
  }

  const has = (flag: string): boolean => argv.includes(flag)
  const valueOf = (flag: string): string | undefined => {
    const i = argv.indexOf(flag)
    return i === -1 ? undefined : argv[i + 1]
  }

  if (has('--list')) {
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

  // Opposite outcomes: neither "both" nor "neither" may be guessed at.
  if (has('--refund') && has('--deny')) {
    return { mode: 'error', message: '--refund and --deny are mutually exclusive' }
  }
  if (!has('--refund') && !has('--deny')) {
    return { mode: 'error', message: 'one of --refund or --deny is required' }
  }
  const action = has('--refund') ? 'refund' : 'deny'

  const operator = valueOf('--operator')
  if (operator === undefined || operator.startsWith('-')) {
    return {
      mode: 'error',
      message: '--operator <id> is required: it is recorded as the actor on this resolution',
    }
  }
  if (!/^[a-z0-9._-]{2,32}$/.test(operator)) {
    return {
      mode: 'error',
      message: `invalid --operator "${operator}" — expected 2-32 chars of [a-z0-9._-]`,
    }
  }

  // Lowercase it: ledger idempotency keys are built as `p_transfer_id::text` in
  // the RPC and uuid::text always renders lowercase, so an uppercase id would
  // move money and then fail the key check afterwards.
  const common = {
    transferId: transferId.toLowerCase(),
    operator,
    confirm: has('--confirm'),
  }

  if (action === 'deny') {
    const depositedAt = valueOf('--deposited-at')
    if (depositedAt === undefined || depositedAt.startsWith('-')) {
      return {
        mode: 'error',
        message:
          '--deposited-at <iso8601> is required with --deny: Bridge\'s deposit timestamp is the ' +
          'evidence that delivery preceded the request',
      }
    }
    if (Number.isNaN(Date.parse(depositedAt))) {
      return { mode: 'error', message: `--deposited-at "${depositedAt}" is not a valid timestamp` }
    }
    return { mode: 'resolve', action: 'deny', ...common, depositedAt }
  }

  if (has('--deposited-at')) {
    // Accepting it silently on a refund would imply it was recorded somewhere.
    return { mode: 'error', message: '--deposited-at applies only to --deny' }
  }
  return { mode: 'resolve', action: 'refund', ...common }
}

let step = 0
function begin(label: string): void {
  step++
  console.log(`\n── step ${step}: ${label}`)
}
function pass(msg: string): void {
  console.log(`✓ PASS [${step}] ${msg}`)
}

/** A failed step. Throws so refusal paths are reachable from a test. */
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
  'usage: tsx scripts/resolve-cancellation.ts --list\n' +
  '       tsx scripts/resolve-cancellation.ts <transferId> --operator <id> --refund [--confirm]\n' +
  '       tsx scripts/resolve-cancellation.ts <transferId> --operator <id> --deny ' +
  '--deposited-at <iso8601> [--confirm]'

const usd = (amountMinor: number): string => formatMoney({ amountMinor, currency: 'USD' }, 'en-US')

/** Each refusal says what happened AND what the operator does next. */
function refusalMessage(outcome: Extract<ReviewOutcome, { done: false }>): string {
  switch (outcome.reason) {
    case 'transfer_not_found':
      return 'no transfer with that id — check it against --list'
    case 'not_under_review':
      return (
        `the transfer is ${outcome.state}, not UNDER_REVIEW. Only a transfer the job parked for ` +
        'review may be paid a correction payment — paying a plain COMPLETED transfer would be an ' +
        'unreviewed double payment on a delivery nobody contested.'
      )
    case 'no_pending_request':
      return (
        'there is no open cancellation request on this transfer. The request is the authority for ' +
        'the payment; without one there is nothing to honour.'
      )
    case 'request_precedes_deposit':
      return (
        'this request was made INSIDE the Reg E window AND before the deposit timestamp you ' +
        'supplied — both §1005.34 conditions held, so a full refund is owed and it cannot be ' +
        'denied. Re-run with --refund, or escalate if you believe it must not be paid.'
      )
    case 'deposit_evidence_conflict':
      return (
        `the deposit timestamp you supplied is outside what is physically possible for this ` +
        `transfer: the deposit cannot precede the sender's payment` +
        (outcome.paymentAt ? ` (${outcome.paymentAt})` : '') +
        ` and cannot postdate the moment Bridge told us it had happened` +
        (outcome.depositEvidenceAt ? ` (${outcome.depositEvidenceAt})` : '') +
        '. Nothing was written. Re-read the exact timestamp from the Bridge dashboard.'
      )
    case 'claim_taken':
      return (
        `another run is refunding this transfer right now (claimed at ${outcome.claimedAt} by ` +
        `${outcome.claimedBy ?? 'unknown'}). Nothing was written. Wait and re-check --list.`
      )
    case 'claim_abandoned':
      return (
        `a refund was claimed at ${outcome.claimedAt} by ${outcome.claimedBy ?? 'unknown'} and ` +
        'NEVER COMPLETED. The sender MAY ALREADY HAVE BEEN PAID. Confirm in the funding processor ' +
        'before doing anything else — see docs/runbooks/manual-refund.md, "Abandoned claims".'
      )
  }
}

export async function list(): Promise<void> {
  const rows = await listPendingReviews()
  if (rows.length === 0) {
    console.log('no open cancellation requests — nothing awaiting a decision')
    return
  }
  console.log(`${rows.length} open cancellation request(s):\n`)
  for (const row of rows) {
    console.log(
      `  ${row.transfer_id}  ${usd(row.send_amount_minor + row.fee_amount_minor)}  ` +
        `state=${row.state}  asked=${row.requested_at}  ` +
        (row.within_window
          ? '⚠ IN-WINDOW — owed IF it beat the deposit (see the alert; --refund or --deny with evidence)'
          : 'out-of-window — deny with evidence (--deny)') +
        (row.refund_payment_ref ? '  [disbursement already recorded]' : ''),
    )
  }
  console.log('\nrun with <transferId> --operator <id> --refund|--deny to inspect (dry run by default)')
}

export async function resolve(args: Extract<ParsedArgs, { mode: 'resolve' }>): Promise<void> {
  console.log(
    `cancellation resolution for ${args.transferId}\n` +
      `operator: ops:${args.operator}\n` +
      `action:   ${args.action.toUpperCase()}` +
      (args.action === 'deny' ? `  (Bridge deposited at ${args.depositedAt})` : '') +
      `\nmode:     ${args.confirm ? 'EXECUTE (--confirm)' : 'DRY RUN (no --confirm)'}`,
  )

  // 1) Show the operator what they are about to decide, BEFORE any write — the
  //    timeliness fact is the whole basis of which exit is lawful.
  begin('review the open request')
  const open = (await listPendingReviews()).find((r) => r.transfer_id === args.transferId)
  if (!open) {
    fail('no open cancellation request on this transfer — check it against --list')
  }
  console.log(
    `   asked ${open.requested_at} · ${open.within_window ? 'TIMELY' : 'OUT OF WINDOW'} · ` +
      `state ${open.state} · ${usd(open.send_amount_minor + open.fee_amount_minor)}`,
  )
  if (args.action === 'refund' && !open.within_window) {
    console.log('   ⚠ this request is OUT of the Reg E window — no refund is owed. --deny is the exit.')
  }
  if (args.action === 'deny' && open.within_window) {
    // In-window is only condition (1). Denial can still be lawful if Bridge's
    // deposit preceded the request — which is exactly what --deposited-at is
    // checked against in the service. Tell the operator what will decide it.
    console.log(
      `   ⚠ in-window request — denial is lawful ONLY if the deposit preceded the ask ` +
        `(${open.requested_at}). Your --deposited-at will be checked against it.`,
    )
    if (Date.parse(args.depositedAt) > Date.parse(open.requested_at)) {
      console.log('   ⚠ the timestamp you supplied is AFTER the request — the service will refuse.')
    }
  }
  pass('request loaded')

  // 2) Execute, or stop here on a dry run.
  begin(
    args.confirm
      ? args.action === 'refund'
        ? 'pay the correction payment and settle REFUNDED'
        : 'deny the request and return the transfer to COMPLETED'
      : 'dry run — no writes',
  )
  if (!args.confirm) {
    pass('re-run with --confirm to write. Nothing was written.')
    return
  }

  // The union split on `action` is what makes this narrowing work: in the deny
  // branch depositedAt is a plain string, no assertion needed.
  const outcome =
    args.action === 'refund'
      ? await refundCancellation({ transferId: args.transferId, operator: args.operator })
      : await denyCancellation({
          transferId: args.transferId,
          operator: args.operator,
          depositedAt: args.depositedAt,
        })

  if (!outcome.done) {
    fail(`${args.action} refused: ${outcome.reason} — ${refusalMessage(outcome)}`)
  }
  pass(
    {
      refunded: 'sender paid the correction payment (send + fee) and state settled REFUNDED',
      // The disbursement pre-existed (a prior run crashed after paying) — this
      // run settled the state and closed the request but moved NO money.
      // Confirm the original payment in the funding processor.
      already_disbursed:
        'disbursement already existed — this run settled REFUNDED and closed the request; ' +
        'no money moved. Confirm the original payment in the funding processor.',
      already_refunded:
        'ALREADY REFUNDED before this run — any dangling request was closed; no payment was made by this run',
      denied: 'request denied and closed; the transfer remains COMPLETED',
    }[outcome.outcome],
  )

  // Never claim credit for a run that wrote nothing: the verify query would show
  // a different actor and make the tool look like it lied.
  console.log(
    outcome.outcome === 'already_refunded'
      ? `\n✅ ${args.transferId} was already refunded — this run made no payment`
      : `\n✅ ${args.transferId} resolved by ops:${args.operator}`,
  )
  console.log(
    `   verify: select status, resolution, resolved_by from public.cancellation_requests ` +
      `where transfer_id = '${args.transferId}';`,
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
  // One transfer per run, on purpose: no --all. Looping post-delivery payments
  // from a CLI is how several go out at once.
  await resolve(args)
}

// Run only when this file IS the entrypoint — its test imports the exports
// above, and vitest's own argv[1] is the vitest binary, so nothing executes.
if (process.argv[1]?.endsWith('resolve-cancellation.ts')) {
  main().catch((err: unknown) => {
    console.error(
      err instanceof StepError
        ? `✗ FAIL [${step}] ${err.message}`
        : `✗ FAIL [${step}] uncaught: ${err instanceof Error ? err.stack : String(err)}`,
    )
    process.exit(1)
  })
}
