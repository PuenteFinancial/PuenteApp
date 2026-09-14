// Cancel a FUNDED payout that can never be delivered, and return the sender's
// money.
//
// THE CORNER (staging cleanup 2026-09-14). A transfer is FUNDED and parked on a
// hold whose cause will never resolve — a Bridge destination with no SPEI
// endorsement is the case that found this. The sender's money is collected, the
// payout cannot leave, and nothing in the system could end it:
//
//   · releasing the hold re-holds it on the very next preflight;
//   · POST /v1/ops/transfers/refund only takes PAYOUT_FAILED rows, and this one
//     never reached Bridge to fail;
//   · the sender's own cancel refuses — the Reg E window closed 30 minutes
//     after payment;
//   · reap-sandbox-transfers.ts takes SUBMITTED/IN_FLIGHT, and
//     resolve-cancellation.ts takes delivered UNDER_REVIEW rows.
//
// The only "exit" left was a bare UPDATE in the SQL editor, which moves the
// state without posting a ledger batch and without returning a cent. This runs
// the owning services instead (services/ops-cancel.ts → the ops_cancel_held_transfer
// RPC, the funding processor, and transition_transfer), so the state, the
// transition log and both ledger batches are written by the code that owns
// them and cannot drift from the rest of the system.
//
// A SCRIPT, NOT A BUTTON (the unfreeze-sender.ts precedent). This should fire
// approximately never — the default answer for a held transfer is still to fix
// the cause and release — and a money-moving prod endpoint is the admin console
// the PRD rules out. The service is route-shaped, so a button later is a thin
// wrapper the way /ops/transfers/refund wraps refundPayoutFailure.
//
// Usage:
//   tsx scripts/cancel-held-transfer.ts --list
//   tsx scripts/cancel-held-transfer.ts <transferId> --operator <uuid> \
//       --hold <reason> --note "<why>" [--confirm] [--reclaim]
//
//   --list           read-only: print every held FUNDED transfer and exit
//   --operator <uuid> required; recorded as actor `ops:<uuid>` on both
//                    transitions and on the ops_actions row. A defaulted actor
//                    is worthless in an audit trail.
//   --hold <reason>  the hold you are discharging, as you just read it. It is
//                    the compare-and-swap: a hold that changed underneath you
//                    refuses instead of cancelling.
//   --note "<why>"   10-500 chars: what you verified before concluding this
//                    payout can never be delivered. Required, never defaulted —
//                    a cancel with no stated reason is the row an examiner asks
//                    about.
//   --confirm        actually cancel and refund; WITHOUT it this is a dry run
//   --reclaim        clear an ABANDONED refund claim first. ONLY after
//                    confirming in the processor that no disbursement went out.
//                    Requires --confirm; clears nothing on a live claim.
//
// This imports src/services/*, so config/env.ts validates the full environment:
//   doppler run -- pnpm exec tsx scripts/cancel-held-transfer.ts …   (staging/prod)
//   node --env-file=.env --import tsx scripts/cancel-held-transfer.ts …   (local)
//
// Runbook: docs/runbooks/payout-holds.md ("When a hold can never clear").
import { formatMoney } from '@puente/shared'
import {
  cancelHeldTransfer,
  verifyFundingNotDisputed,
  listHeldTransfers,
  cancelLedgerBatches,
  CANCELABLE_HOLD_REASONS,
  type CancelableHoldReason,
  type OpsCancelOutcome,
} from '../src/services/ops-cancel.js'
import { refundClaimStatus, releaseStaleRefundClaim } from '../src/services/refunds.js'
import { checkPayability } from '../src/services/payouts.js'

const KNOWN_FLAGS = ['--list', '--operator', '--hold', '--note', '--confirm', '--reclaim']
const VALUE_FLAGS = ['--operator', '--hold', '--note']
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

// The board's noteSchema bounds, verbatim: short enough to stay a note, long
// enough to force a sentence.
const NOTE_MIN = 10
const NOTE_MAX = 500

export type ParsedArgs =
  | { mode: 'list' }
  | {
      mode: 'cancel'
      transferId: string
      operator: string
      holdReason: CancelableHoldReason
      note: string
      confirm: boolean
      reclaim: boolean
    }
  | { mode: 'error'; message: string }

/**
 * Pure arg parsing, exported so it can be tested without moving money.
 *
 * Strict on purpose (the trigger-refund.ts lesson): a money CLI that silently
 * reinterprets a typo is worse than one that refuses. `--comfirm` must not
 * quietly become a dry run that exits 0, and `--operator --confirm` must not
 * cancel under the actor `ops:--confirm` — which a lenient parser does, since
 * the same token satisfies both the value slot and the confirm check.
 */
export function parseArgs(argv: string[]): ParsedArgs {
  // A repeated value flag lets its second occurrence both fill a value slot and
  // smuggle an unknown flag past the check below.
  for (const flag of VALUE_FLAGS) {
    if (argv.filter((t) => t === flag).length > 1) {
      return { mode: 'error', message: `${flag} given more than once` }
    }
  }
  const valueIndexes = new Set<number>()
  for (const [i, token] of argv.entries()) {
    if (VALUE_FLAGS.includes(token)) valueIndexes.add(i + 1)
  }
  for (const [i, token] of argv.entries()) {
    if (token.startsWith('-') && !KNOWN_FLAGS.includes(token) && !valueIndexes.has(i)) {
      return { mode: 'error', message: `unknown option "${token}"` }
    }
  }

  const has = (flag: string): boolean => argv.includes(flag)
  const valueOf = (flag: string): string | undefined => {
    const i = argv.indexOf(flag)
    if (i === -1) return undefined
    const value = argv[i + 1]
    // A leading `-` is what stops `--note --confirm` from both supplying the
    // note and authorizing the cancel.
    return value === undefined || value.startsWith('-') ? undefined : value
  }

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

  const operator = valueOf('--operator')
  if (operator === undefined) {
    return {
      mode: 'error',
      message: '--operator <uuid> is required: it is recorded as the actor on this cancel',
    }
  }
  if (!UUID_RE.test(operator)) {
    return { mode: 'error', message: `--operator must be a UUID, got "${operator}"` }
  }

  const hold = valueOf('--hold')
  if (hold === undefined) {
    return {
      mode: 'error',
      message: `--hold <reason> is required: name the hold you just read. One of ${CANCELABLE_HOLD_REASONS.join(', ')}`,
    }
  }
  if (!(CANCELABLE_HOLD_REASONS as readonly string[]).includes(hold)) {
    return {
      mode: 'error',
      // Naming the excluded reasons here, not just the allowed ones: an
      // operator who typed `funding_disputed` needs to know it was refused on
      // purpose and where that row belongs, not merely that it is not in a list.
      message:
        `"${hold}" is not a cancelable hold. This tool discharges ${CANCELABLE_HOLD_REASONS.join(', ')}.\n` +
        '  funding_disputed / sender_suspended  → the loss path owns those rows; refunding a\n' +
        '    sender whose funding is being clawed back pays them twice\n' +
        '    (docs/runbooks/proposals/funding-reversal.md, scripts/unfreeze-sender.ts).\n' +
        '  sender_kyc_pending                   → auto-releases on Bridge approval; cancelling\n' +
        '    one bets against an approval that may be minutes away.',
    }
  }

  const note = valueOf('--note')?.trim()
  if (!note) {
    return {
      mode: 'error',
      message: '--note "<why>" is required: state what you verified before cancelling',
    }
  }
  if (note.length < NOTE_MIN || note.length > NOTE_MAX) {
    return {
      mode: 'error',
      message: `--note must be ${NOTE_MIN}-${NOTE_MAX} characters, got ${note.length}`,
    }
  }

  // --reclaim clears an abandoned claim so the tail can be re-driven; on a dry
  // run there is nothing to re-drive, so accepting it there would imply the
  // claim had been dealt with when nothing was written.
  if (has('--reclaim') && !has('--confirm')) {
    return {
      mode: 'error',
      message: '--reclaim requires --confirm (there is nothing to reclaim on a dry run)',
    }
  }

  return {
    mode: 'cancel',
    // Lowercased for the same reason trigger-refund does it: ledger idempotency
    // keys are built in the RPC as `p_transfer_id::text || ':' || …`, and
    // uuid::text always renders lowercase. An uppercase argument would run the
    // cancel and then fail the key check AFTER the sender was paid.
    transferId: transferId.toLowerCase(),
    operator: operator.toLowerCase(),
    holdReason: hold as CancelableHoldReason,
    note,
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
 * refusal paths — the ones that stop a cancel — are reachable from a test;
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
  'usage: tsx scripts/cancel-held-transfer.ts --list\n' +
  '       tsx scripts/cancel-held-transfer.ts <transferId> --operator <uuid> --hold <reason> --note "<why>" [--confirm] [--reclaim]'

const usd = (amountMinor: number): string => formatMoney({ amountMinor, currency: 'USD' }, 'en-US')

const ageDays = (iso: string | null): string =>
  iso === null ? '—' : `${((Date.now() - new Date(iso).getTime()) / 86_400_000).toFixed(1)}d`

export async function list(): Promise<void> {
  const rows = await listHeldTransfers()
  if (rows.length === 0) {
    console.log('no held transfers — nothing FUNDED is parked on a payout hold')
    return
  }
  console.log(`${rows.length} held FUNDED transfer(s):\n`)
  for (const row of rows) {
    console.log(
      `  ${row.id}  ${usd(row.send_amount_minor + row.fee_amount_minor).padStart(8)}  ` +
        `${row.payout_hold_reason.padEnd(18)}  held ${ageDays(row.payout_held_at)}  ` +
        `cleared=${row.funding_cleared}` +
        // Not cancelable from here, and the message says where it belongs
        // rather than hiding the row — a filtered list reads as "nothing is
        // stuck", which is the one impression this must never leave.
        (row.cancelable ? '' : '  ⛔ NOT cancelable from here — see --hold help') +
        // A set ref means a prior run paid the sender and died before settling:
        // the money is gone but the REFUNDED batch was never posted.
        (row.refund_payment_ref ? '  ⚠ ALREADY DISBURSED — needs settling only' : ''),
    )
  }
  console.log(
    '\nrun with <transferId> --operator <uuid> --hold <reason> --note "<why>" to inspect one (dry run by default)',
  )
}

/** The refusal copy. Each says what happened AND what the operator does next. */
export function refusalMessage(outcome: Extract<OpsCancelOutcome, { done: false }>): string {
  switch (outcome.reason) {
    case 'transfer_not_found':
      return 'no transfer with that id — check it against --list'
    case 'not_funded':
      return (
        `the transfer is ${outcome.state}, not FUNDED — this tool only cancels a payout that ` +
        'has not left. A transfer past FUNDED belongs to the payout-failure tail ' +
        '(scripts/trigger-refund.ts) or the cancellation review (scripts/resolve-cancellation.ts).'
      )
    case 'not_held':
      return (
        'the transfer carries no payout hold — it is on its way to Bridge. Nothing here cancels ' +
        'a healthy payout; if it must be stopped, hold it first and investigate why.'
      )
    case 'hold_not_cancelable':
      return (
        `the hold is "${outcome.actual}", which this tool refuses on purpose. ` +
        'funding_disputed / sender_suspended belong to the loss path (refunding a sender whose ' +
        'funding is being clawed back pays them twice); sender_kyc_pending auto-releases on ' +
        "Bridge's approval webhook."
      )
    case 'hold_reason_mismatch':
      return (
        `the hold is now "${outcome.actual}", not the one you confirmed. It changed underneath ` +
        'you — re-read the transfer and decide again. Nothing was written.'
      )
    case 'funding_disputed':
      return (
        `the funding for this transfer has been CHARGED BACK${outcome.disputeRef ? ` (${outcome.disputeRef})` : ''} — ` +
        `${outcome.detail}. The sender already has their money back through the card network, so ` +
        'there is nothing here to return: refunding would pay them twice, and booking a refund the ' +
        'processor will refuse would leave the ledger claiming a debt that does not exist.\n' +
        (outcome.source === 'provider'
          ? '  The PROVIDER caught this, not our records — so the dispute is not recorded on our\n' +
            '  side at all (no funding_disputed hold, no funding_disputed_at). That is its own\n' +
            '  problem: check whether the charge.dispute.created webhook was handled, and see\n' +
            "  reconciliation's stripe_disputes findings.\n"
          : '') +
        '  This row belongs to the loss path: docs/runbooks/proposals/funding-reversal.md.'
      )
    case 'not_our_cancel':
      return (
        'the transfer is CANCELED, but by the SENDER\'s own cancel — not by this tool. Its books ' +
        'are already square (the FUNDED batch was reversed), so finishing it here would post a ' +
        'second refund batch against a liability that was never recognized. What it is waiting ' +
        'for is the DISBURSEMENT: follow docs/runbooks/manual-refund.md, then settle it to ' +
        'REFUNDED with no ledger.'
      )
    case 'submit_in_progress':
      return (
        'the submit job has claimed this transfer, or a Bridge payout already exists. Cancelling ' +
        'is not ours to do from here — a payout may be in flight. Let it resolve; if it fails, ' +
        'scripts/trigger-refund.ts owns the refund.'
      )
    case 'changed_underneath':
      return (
        `the row moved between the read and the write (state is now ${outcome.state}). Nothing ` +
        'was written and nothing was forced. Re-read and decide again.'
      )
    case 'claim_taken':
      return (
        `another run is refunding this transfer RIGHT NOW (claimed at ${outcome.claimedAt} by ` +
        `${outcome.claimedBy ?? 'unknown'}). Nothing further was written. Wait and re-check; it ` +
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
        '    · it did NOT → re-run this command with --reclaim to clear the claim and finish.'
      )
  }
}

export async function cancel(args: Extract<ParsedArgs, { mode: 'cancel' }>): Promise<void> {
  const { transferId, operator, holdReason, note, confirm, reclaim } = args
  console.log(
    `cancel + refund for ${transferId}\n` +
      `operator: ops:${operator}\n` +
      `hold: ${holdReason}\n` +
      `note: ${note}\n` +
      `mode: ${confirm ? 'EXECUTE (--confirm)' : 'DRY RUN (no --confirm)'}` +
      `${reclaim ? '\nreclaim: YES — will clear an abandoned claim first' : ''}`,
  )

  // 1) Is it still unpayable? The whole premise of this command is that the
  //    payout can never leave, and for a `payability` hold that is a LIVE fact
  //    we can check rather than take on trust. It does not gate the cancel —
  //    the other holds have no equivalent probe, and a destination that turned
  //    payable may still be one the operator has decided against — but an
  //    operator about to refund a sender should see it before --confirm.
  if (holdReason === 'payability') {
    begin('re-check payability (the hold this cancel discharges)')
    const row = (await listHeldTransfers()).find((r) => r.id === transferId)
    if (!row) {
      // Not in the list: gone, no longer FUNDED, no longer held, or already
      // claimed by the submit job. The service refuses with the precise reason;
      // this only says the probe cannot run.
      pass('not in the held list — skipping the probe; the service will say why')
    } else {
      const payability = await checkPayability(row.payout_destination_id)
      if (payability.payable) {
        console.log(
          '⚠ this destination is PAYABLE RIGHT NOW. The hold may simply be stale: releasing it\n' +
            '  (POST /v1/ops/transfers/hold-release) would let the payout go and the sender keep\n' +
            '  their transfer. Only cancel if you have decided this send must not happen.',
        )
        pass('probe says payable — cancelling anyway is a choice, not a cleanup')
      } else {
        pass(`still unpayable: ${payability.reason}`)
      }
    }
  }

  // 2) The dispute interlock, reported before --confirm so an operator sees a
  //    chargeback while deciding rather than as a mid-tail throw. The service
  //    runs it again for real; this is the preview, and it is deliberately the
  //    same function rather than a second implementation that could disagree.
  begin('dispute interlock — is this funding still ours to give back?')
  const candidate = (await listHeldTransfers()).find((r) => r.id === transferId)
  if (!candidate) {
    pass('not in the held list — skipping the probe; the service will say why')
  } else {
    const verdict = await verifyFundingNotDisputed({
      state: 'FUNDED',
      payout_hold_reason: candidate.payout_hold_reason,
      funding_disputed_at: candidate.funding_disputed_at,
      funding_payment_ref: candidate.funding_payment_ref,
      funding_processor: candidate.funding_processor,
    })
    if (verdict.disputed) {
      fail(
        `funding CHARGED BACK — ${verdict.detail}` +
          `${verdict.disputeRef ? ` (${verdict.disputeRef})` : ''}. Nothing was written. ` +
          'This row belongs to the loss path, not here.',
      )
    }
    pass(
      verdict.checked === 'record_and_provider'
        ? 'not disputed — our records and the live provider agree'
        : 'not disputed by our records; this rail exposes no provider check (nothing to dispute)',
    )
  }

  // 3) The claim. Reported BEFORE the dry run returns, so an operator learns a
  //    claim is abandoned while they are still deciding — not after --confirm.
  begin('check the refund claim')
  const claim = await refundClaimStatus(transferId)
  if (claim === null) fail('no transfer with that id — check it against --list')
  if (claim.claimStatus === 'abandoned') {
    console.log(`⚠ claim abandoned: taken at ${claim.claimedAt} by ${claim.claimedBy ?? 'unknown'}`)
  }
  pass(
    {
      unclaimed: 'no claim on this transfer',
      // NOT "a refund is in progress". A claim is never released, so a transfer
      // that already settled keeps the claim of the run that paid it — and the
      // claim alone cannot tell the two apart. Step 3 can, so say so rather
      // than asserting a disbursement is in flight when none is.
      claimed:
        `the refund claim is held by ${claim.claimedBy ?? 'unknown'} since ${claim.claimedAt} — ` +
        'either a run is mid-disbursement, or this transfer already settled (claims are never ' +
        'released). Step 3 says which.',
      abandoned: `claim ABANDONED by ${claim.claimedBy ?? 'unknown'} at ${claim.claimedAt}`,
    }[claim.claimStatus],
  )

  // 3) Execute, or stop here on a dry run.
  begin(confirm ? 'cancel the transfer and refund the sender' : 'dry run — no writes')
  if (!confirm) {
    pass('re-run with --confirm to cancel and refund. Nothing was written.')
    return
  }

  // Guarded in the service to only-if-abandoned, so this cannot yank a live
  // claim from a run that is mid-disbursement — if it clears nothing, the tail
  // refuses again and the operator is told why rather than reported a success.
  if (reclaim) {
    const released = await releaseStaleRefundClaim(transferId)
    console.log(
      released
        ? '   abandoned claim cleared — re-driving the refund'
        : '   nothing to reclaim (the claim is live, or a disbursement was recorded)',
    )
  }

  const outcome = await cancelHeldTransfer(
    { transferId, actor: `ops:${operator}`, holdReason, note, requestId: null },
    log,
  )
  if (!outcome.done) {
    fail(`cancel refused: ${outcome.reason} — ${refusalMessage(outcome)}`)
  }
  if (outcome.outcome === 'awaiting_disbursement') {
    // NOT a success message. The cancel landed and the books say the sender is
    // owed; nobody has paid them.
    console.log(
      `⚠ the transfer is CANCELED and the undo is recorded (${outcome.refundRef}), but the funds\n` +
        '  were collected on a rail we do not operate — a human must send them back. The ledger\n' +
        '  shows the debt open on refunds_payable until they do. A Sentry page has been raised.\n' +
        '  Follow docs/runbooks/manual-refund.md, then the state settles to REFUNDED.',
    )
  } else {
    pass(
      {
        canceled_and_refunded: 'transfer canceled and the sender refunded (send + fee)',
        already_disbursed:
          'the disbursement had already gone out — no second payment; state settled by this run',
        already_settled: 'ALREADY REFUNDED before this run — nothing was written',
      }[outcome.outcome],
    )
  }

  // 4) Prove the batches landed under their distinct keys. Money has moved by
  //    now, so a missing batch is reported loudly — it means the books disagree
  //    with the cash, not that the refund should be retried.
  begin('verify the ledger batches')
  const keys = await cancelLedgerBatches(transferId)
  const expected =
    outcome.outcome === 'awaiting_disbursement'
      ? [`${transferId}:CANCELED`]
      : [`${transferId}:CANCELED`, `${transferId}:REFUNDED`]
  for (const key of expected) {
    if (!keys.includes(key)) {
      fail(
        `missing ledger batch ${key}. The money may already have moved — do NOT re-run blindly; ` +
          'read the ledger for this transfer and follow docs/runbooks/manual-refund.md.',
      )
    }
    console.log(`   ${key}`)
  }
  pass(
    outcome.outcome === 'awaiting_disbursement'
      ? 'CANCELED batch posted (REFUNDED waits on the out-of-band disbursement)'
      : 'both batches posted',
  )

  // Never claim credit for a run that wrote nothing: the verify query below
  // would show a different actor and make the tool look like it lied.
  console.log(
    outcome.outcome === 'already_settled'
      ? `\n✅ ${transferId} was already REFUNDED — this run changed nothing`
      : `\n✅ ${transferId} canceled by ops:${operator}`,
  )
  console.log(
    `   verify: select actor, from_state, to_state, reason from public.transfer_transitions ` +
      `where transfer_id = '${transferId}' order by created_at;`,
  )
}

// stdout is this tool's output surface (eslint.config.js exempts scripts/).
const log = {
  info: (obj: Record<string, unknown>, msg: string) => console.error(msg, obj),
  warn: (obj: Record<string, unknown>, msg: string) => console.error(msg, obj),
  error: (obj: Record<string, unknown>, msg: string) => console.error(msg, obj),
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
  await cancel(args)
}

// Run only when this file IS the entrypoint — its test imports the exports
// above, and vitest's own argv[1] is the vitest binary, so nothing executes.
// endsWith, not includes: `includes(...)` also matches the .test.ts file.
if (process.argv[1]?.endsWith('cancel-held-transfer.ts')) {
  main().catch((err: unknown) => {
    console.error(
      err instanceof StepError
        ? `✗ FAIL [${step}] ${err.message}`
        : `✗ FAIL [${step}] uncaught: ${err instanceof Error ? err.stack : String(err)}`,
    )
    process.exit(1)
  })
}
