// Unfreeze a sender the loss path froze, and release the payout holds that
// freeze left behind.
//
// The freeze is automatic: a chargeback or ACH return sets users.status =
// 'suspended' (services/funding-apply.ts), which stops the whole
// post-onboarding surface and parks the sender's other payouts on
// 'sender_suspended'. Nothing lifts it automatically, and nothing should —
// unlike sender_kyc_pending there is no event that says a person is
// trustworthy again. A human decides, and that decision is what this tool
// records.
//
// A SCRIPT, NOT A BUTTON (2026-09-10). The ops board is transfer-scoped end to
// end and this is a user action, so a button means a new route plus a new web
// surface for something that should fire approximately never; the runbook's
// default answer is that the account stays frozen. See the header of
// src/services/sender-freeze.ts for the full reasoning and the escape hatch —
// this drives a service, so a route later is a thin wrapper, the way
// /ops/transfers/hold-release wraps releaseHold.
//
// Usage:
//   tsx scripts/unfreeze-sender.ts --user <uuid> --operator <uuid> --note "<why>" [--confirm]
//
//   --user <uuid>      the frozen sender (users.id)
//   --operator <uuid>  recorded as actor `ops:<id>` on the ops_actions row
//   --note "<why>"     10-500 chars: what you verified before deciding this
//                      account is safe. Required, never defaulted — an
//                      unfreeze with no stated reason is the row an examiner
//                      asks about.
//   --confirm          actually unfreeze; WITHOUT it this is a dry run
//
// This imports src/services/*, so config/env.ts validates the full environment:
//   doppler run -- pnpm exec tsx scripts/unfreeze-sender.ts …   (staging/prod)
//   node --env-file=.env --import tsx scripts/unfreeze-sender.ts …   (local)
//
// Runbook: docs/runbooks/proposals/funding-reversal.md ("Unfreezing the sender").
import { supabaseAdmin } from '../src/services/supabase.js'
import {
  unfreezeSender,
  listSenderSuspendedHolds,
  listSenderOpenDisputes,
} from '../src/services/sender-freeze.js'

const KNOWN_FLAGS = ['--user', '--operator', '--note', '--confirm']

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

// The board's noteSchema bounds, verbatim: short enough to stay a note, long
// enough to force a sentence.
const NOTE_MIN = 10
const NOTE_MAX = 500

export interface UnfreezeArgs {
  userId: string
  operator: string
  note: string
  confirm: boolean
}

function flagValue(argv: string[], flag: string): string | undefined {
  const i = argv.indexOf(flag)
  if (i === -1) return undefined
  const value = argv[i + 1]
  return value === undefined || value.startsWith('--') ? undefined : value
}

export function parseArgs(argv: string[]): UnfreezeArgs {
  for (const arg of argv) {
    if (arg.startsWith('--') && !KNOWN_FLAGS.includes(arg)) {
      throw new Error(`unknown flag ${arg}. Known: ${KNOWN_FLAGS.join(', ')}`)
    }
  }

  const userId = flagValue(argv, '--user')
  if (!userId) throw new Error('--user <uuid> is required: the frozen sender')
  if (!UUID_RE.test(userId)) throw new Error(`--user must be a UUID, got "${userId}"`)

  // A DEFAULTED actor is worthless in an audit trail (trigger-refund.ts
  // precedent), so this is required, not optional.
  const operator = flagValue(argv, '--operator')
  if (!operator) {
    throw new Error('--operator <uuid> is required: it is recorded as the actor on this unfreeze')
  }
  if (!UUID_RE.test(operator)) throw new Error(`--operator must be a UUID, got "${operator}"`)

  const note = flagValue(argv, '--note')?.trim()
  if (!note) {
    throw new Error('--note "<why>" is required: state what you verified before unfreezing')
  }
  if (note.length < NOTE_MIN || note.length > NOTE_MAX) {
    throw new Error(`--note must be ${NOTE_MIN}-${NOTE_MAX} characters, got ${note.length}`)
  }

  return { userId: userId.toLowerCase(), operator: operator.toLowerCase(), note, confirm: argv.includes('--confirm') }
}

export interface SenderStateRow {
  status: string
}

/**
 * The refusal gate, separated for tests. Refusing here is only a convenience —
 * unfreezeSender's compare-and-swap is the real guard — but it turns a typo'd
 * id into a clear message instead of a puzzling no-op.
 */
export function unfreezeRefusal(row: SenderStateRow | null): string | null {
  if (row === null) return 'no such user'
  if (row.status !== 'suspended') {
    return `status is '${row.status}', not 'suspended' — this tool lifts a freeze, it never grants access`
  }
  return null
}

// stdout is this tool's output surface (eslint.config.js exempts scripts/).
const log = {
  info: (obj: Record<string, unknown>, msg: string) => console.error(msg, obj),
  warn: (obj: Record<string, unknown>, msg: string) => console.error(msg, obj),
  error: (obj: Record<string, unknown>, msg: string) => console.error(msg, obj),
}

async function main(): Promise<void> {
  const { userId, operator, note, confirm } = parseArgs(process.argv.slice(2))

  const { data, error } = await supabaseAdmin
    .from('users')
    .select('status')
    .eq('id', userId)
    .maybeSingle()
  if (error) throw new Error(`user load failed: ${error.message}`)
  const row = data as SenderStateRow | null

  const refusal = unfreezeRefusal(row)
  if (refusal !== null) throw new Error(`refusing ${userId}: ${refusal}`)

  const holds = await listSenderSuspendedHolds(userId)
  const disputes = await listSenderOpenDisputes(userId)

  // Ids and statuses only. No name, no phone, no email: this prints to a
  // terminal and often into a paste in an incident thread.
  console.log(`user ${userId} — status 'suspended'`)
  console.log(`operator: ops:${operator}`)
  console.log(`note: ${note}`)
  console.log(`\nWould set users.status = 'active' and release ${holds.length} sender_suspended hold(s):`)
  for (const transferId of holds) console.log(`  ${transferId}`)
  if (holds.length === 0) {
    console.log('  (none — the sender has no FUNDED transfer held on the freeze)')
  }
  console.log(
    '\nHolds under any OTHER reason are left alone, funding_disputed included: a dispute on a\n' +
      'specific transfer outlives the account freeze and is released on its own judgement.',
  )

  // THE CHECK NO COMPARE-AND-SWAP CAN DO FOR YOU. A second dispute on an
  // already-frozen sender changes nothing about the account: the freeze is
  // idempotent, so no row moves and no new sender_freeze record appears. If one
  // landed while you were investigating the first, the only thing that will
  // catch it is reading this list.
  if (disputes.length > 0) {
    console.log(`\n!! ${disputes.length} OPEN DISPUTE(S) on this account:`)
    for (const transferId of disputes) console.log(`  ${transferId}`)
    console.log(
      'Each is either held on funding_disputed or already booked as FUNDING_REVERSED. Confirm\n' +
        'every one of them is the dispute you investigated. A dispute that arrived AFTER you\n' +
        'started leaves no trace on the account, so nothing else will stop you lifting the freeze\n' +
        'with it outstanding.',
    )
  } else {
    console.log('\nNo open disputes on this account (nothing held on funding_disputed, no FUNDING_REVERSED).')
  }

  if (!confirm) {
    console.log('\nDRY RUN — nothing changed. Re-run with --confirm to unfreeze.')
    return
  }

  const outcome = await unfreezeSender(
    { userId, actor: `ops:${operator}`, note, requestId: null },
    log,
  )

  if (!outcome.done) {
    // The compare-and-swap refused: something moved between the read above and
    // the write. Never forced.
    console.log(`\nRefused: ${outcome.reason}${'status' in outcome ? ` (status is '${outcome.status}')` : ''}.`)
    if (outcome.reason === 'changed_underneath') {
      console.log(
        'The account is STILL suspended, but not the same suspension you just read: the row\n' +
          'changed after this run looked at it. If a second dispute landed, lifting the freeze\n' +
          'would clear a freeze you never investigated. Re-read the sender_freeze rows and decide\n' +
          'again. (An unrelated write to the user row refuses here too, and re-running is safe.)',
      )
    }
    console.log('Nothing changed. Re-read the account and decide again.')
    return
  }

  console.log(`\nUnfroze ${userId}: status 'suspended' → 'active'.`)
  console.log(`Released ${outcome.releasedTransferIds.length} hold(s):`)
  for (const transferId of outcome.releasedTransferIds) console.log(`  ${transferId}`)
  if (outcome.releasedTransferIds.length !== holds.length) {
    console.log(
      '\nThat count differs from the dry run: a hold changed underneath this run (re-held for\n' +
        'another reason, or released by someone else). The compare-and-swap left it alone.',
    )
  }
  console.log(
    `\n   verify: select actor, action, note from public.ops_actions ` +
      `where action = 'sender_unfreeze' order by created_at desc limit 1;`,
  )
}

// Only run when invoked directly, so the parsers stay unit-testable.
if (process.argv[1]?.includes('unfreeze-sender')) {
  main().catch((err: unknown) => {
    console.error(err instanceof Error ? err.message : String(err))
    process.exit(1)
  })
}
