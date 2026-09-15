// Acknowledge a reconciliation finding — record that a human looked at it and it is understood,
// so it stops paging until a stated date.
//
// WHEN THIS IS THE RIGHT TOOL. A finding is real, you have investigated it, and there is nothing
// left to do: the cause is history rather than a defect, or the money question is already settled.
// The check will keep firing every 6 hours regardless, because every check is a stateless diff
// with no memory, and some windows are long — stripe_disputes looks back 60 days. The worked
// example is the three 2026-09-10 staging disputes, which went unrecorded because they PREDATE
// the loss path that records them (#310, #313). Nothing can fix that, and they page until
// 2026-11-09.
//
// WHEN IT IS NOT. If the finding names something still open — money in flight, a balance that
// does not reconcile, a transfer nobody has decided about — acknowledging it buys silence you
// will regret. The page is not the problem; it is the only thing watching. Fatal checks cannot be
// acknowledged at all and this tool refuses them.
//
// A SCRIPT, NOT A BUTTON, on the same reasoning as unfreeze-sender.ts: the ops board is
// transfer-scoped end to end and a finding is keyed on (check, key), most checks not being
// transfer-scoped at all. This drives a service, so a route later is a thin wrapper.
//
// Usage:
//   tsx scripts/acknowledge-finding.ts --list
//   tsx scripts/acknowledge-finding.ts --check <name> --key <finding-key> \
//       --operator <uuid> --note "<why>" --days <n> [--confirm]
//   tsx scripts/acknowledge-finding.ts --revoke <ack-uuid> --operator <uuid> --note "<why>" [--confirm]
//
//   --check <name>     the check's registry name (services/reconciliation.ts buildChecks)
//   --key <string>     the finding key, verbatim from the Sentry title after the em dash
//   --operator <uuid>  recorded as actor `ops:<id>` on the acknowledgement and the ops_actions row
//   --note "<why>"     10-500 chars: what you verified, and why this needs no action
//   --days <n>         1-90. There is no "forever" — a permanent acknowledgement is a permanent
//                      blind spot, so the worst case of a wrong call is bounded and self-healing
//   --confirm          actually write; WITHOUT it this is a dry run
//
// This imports src/services/*, so config/env.ts validates the full environment:
//   doppler run -- pnpm exec tsx scripts/acknowledge-finding.ts …   (staging/prod)
//   node --env-file=.env --import tsx scripts/acknowledge-finding.ts …   (local)
//
// Runbook: docs/runbooks/reconciliation.md ("Acknowledging a finding").
import {
  acknowledgeFinding,
  findAcknowledgeRefusal,
  listAcknowledgements,
  revokeAcknowledgement,
  MAX_ACK_DAYS,
  NOTE_MIN,
  NOTE_MAX,
  type Acknowledgement,
} from '../src/services/reconciliation-ack.js'
import { recordOpsAction } from '../src/services/ops-actions.js'

const KNOWN_FLAGS = ['--list', '--check', '--key', '--revoke', '--operator', '--note', '--days', '--confirm']

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export type AckArgs =
  | { mode: 'list' }
  | {
      mode: 'ack'
      checkName: string
      findingKey: string
      operator: string
      note: string
      days: number
      confirm: boolean
    }
  | { mode: 'revoke'; id: string; operator: string; note: string; confirm: boolean }

function flagValue(argv: string[], flag: string): string | undefined {
  const i = argv.indexOf(flag)
  if (i === -1) return undefined
  const value = argv[i + 1]
  return value === undefined || value.startsWith('--') ? undefined : value
}

export function parseArgs(argv: string[]): AckArgs {
  for (const arg of argv) {
    if (arg.startsWith('--') && !KNOWN_FLAGS.includes(arg)) {
      throw new Error(`unknown flag ${arg}. Known: ${KNOWN_FLAGS.join(', ')}`)
    }
  }
  if (argv.includes('--list')) return { mode: 'list' }

  // A DEFAULTED actor is worthless in an audit trail (trigger-refund.ts precedent), and silencing
  // an alarm is exactly the row an examiner asks about. Required in both writing modes.
  const operator = flagValue(argv, '--operator')
  if (!operator) {
    throw new Error('--operator <uuid> is required: it is recorded as the actor on this action')
  }
  if (!UUID_RE.test(operator)) throw new Error(`--operator must be a UUID, got "${operator}"`)

  const note = flagValue(argv, '--note')?.trim()
  if (!note) throw new Error('--note "<why>" is required: state what you verified')
  if (note.length < NOTE_MIN || note.length > NOTE_MAX) {
    throw new Error(`--note must be ${NOTE_MIN}-${NOTE_MAX} characters, got ${note.length}`)
  }

  const confirm = argv.includes('--confirm')
  const revokeId = flagValue(argv, '--revoke')
  if (revokeId !== undefined) {
    if (!UUID_RE.test(revokeId)) throw new Error(`--revoke must be a UUID, got "${revokeId}"`)
    return { mode: 'revoke', id: revokeId.toLowerCase(), operator: operator.toLowerCase(), note, confirm }
  }

  const checkName = flagValue(argv, '--check')
  if (!checkName) throw new Error('--check <name> is required (or --list, or --revoke <uuid>)')
  const findingKey = flagValue(argv, '--key')
  if (!findingKey) throw new Error('--key <finding-key> is required: the key the page names')

  const daysRaw = flagValue(argv, '--days')
  if (daysRaw === undefined) {
    throw new Error(`--days <n> is required (1-${MAX_ACK_DAYS}): an acknowledgement always expires`)
  }
  const days = Number(daysRaw)
  if (!Number.isInteger(days) || days < 1 || days > MAX_ACK_DAYS) {
    throw new Error(`--days must be a whole number 1-${MAX_ACK_DAYS}, got "${daysRaw}"`)
  }

  return {
    mode: 'ack',
    checkName,
    findingKey,
    operator: operator.toLowerCase(),
    note,
    days,
    confirm,
  }
}

// stdout is this tool's output surface (eslint.config.js exempts scripts/).
const log = {
  error: (obj: Record<string, unknown>, msg: string) => console.error(msg, obj),
}

function describe(ack: Acknowledgement, nowMs: number): string {
  const state =
    ack.revokedAt !== null
      ? `revoked ${ack.revokedAt}`
      : Date.parse(ack.expiresAt) <= nowMs
        ? `EXPIRED ${ack.expiresAt}`
        : `active until ${ack.expiresAt}`
  return `  ${ack.id}  ${ack.checkName} — ${ack.findingKey}\n      ${state}  by ${ack.actor}\n      "${ack.note}"`
}

function reportRefusal(
  refusal: Awaited<ReturnType<typeof findAcknowledgeRefusal>> & object,
  checkName: string,
  nowMs: number,
): void {
  if (refusal.reason === 'unknown_check') {
    console.log(`\nRefused: no check named "${checkName}".`)
    console.log(
      'A typo here would write a row that silences nothing and reads, forever after, as though\n' +
        'someone had handled the finding. Known checks:',
    )
    for (const name of refusal.known) console.log(`  ${name}`)
    return
  }
  if (refusal.reason === 'fatal_check') {
    console.log(
      `\nRefused: ${checkName} is a FATAL check and cannot be acknowledged.\n` +
        'These are the invariants the whole book rests on. If one fires, the answer is a human,\n' +
        'now — not a note and a date.',
    )
    return
  }
  if (refusal.reason === 'already_acknowledged') {
    console.log('\nRefused: an acknowledgement is already in force for this finding:')
    console.log(describe(refusal.existing, nowMs))
    console.log('\nRead that note before deciding this is handled. Revoke it first to replace it.')
    return
  }
  console.log(`\nRefused: ${refusal.reason}. Nothing changed.`)
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2))
  const nowMs = Date.now()

  if (args.mode === 'list') {
    const rows = await listAcknowledgements()
    if (rows.length === 0) {
      console.log('No acknowledgements recorded.')
      return
    }
    console.log(`${rows.length} acknowledgement(s), newest first:\n`)
    for (const ack of rows) console.log(describe(ack, nowMs) + '\n')
    return
  }

  if (args.mode === 'revoke') {
    console.log(`Would revoke acknowledgement ${args.id} — the finding pages again from the next run.`)
    console.log(`operator: ops:${args.operator}`)
    console.log(`note: ${args.note}`)
    if (!args.confirm) {
      console.log('\nDRY RUN — nothing changed. Re-run with --confirm to revoke.')
      return
    }
    const outcome = await revokeAcknowledgement({ id: args.id, nowMs })
    if (!outcome.done) {
      console.log(`\nRefused: ${outcome.reason}. Nothing changed.`)
      return
    }
    await recordOpsAction(
      {
        actor: `ops:${args.operator}`,
        action: 'reconciliation_ack_revoke',
        transferId: null,
        reason: 'acknowledgement_revoked',
        note: args.note,
        before: {
          acknowledgementId: outcome.acknowledgement.id,
          checkName: outcome.acknowledgement.checkName,
          findingKey: outcome.acknowledgement.findingKey,
          expiresAt: outcome.acknowledgement.expiresAt,
        },
        after: { revokedAt: outcome.acknowledgement.revokedAt },
        requestId: null,
      },
      log,
    )
    console.log(`\nRevoked ${outcome.acknowledgement.id}. ${outcome.acknowledgement.checkName} — ` +
      `${outcome.acknowledgement.findingKey} pages again from the next run.`)
    return
  }

  // REFUSE BEFORE PRINTING THE PREVIEW, so a dry run and a --confirm run reach the same verdict.
  // These used to run only after the dry-run return, which meant `--check stripe_disputez` or a
  // fatal check previewed as though it would work and was rejected only once you committed. A
  // preview that does not run the real decision is worse than none, because it is believed.
  const refusal = await findAcknowledgeRefusal({
    checkName: args.checkName,
    findingKey: args.findingKey,
    note: args.note,
    days: args.days,
    nowMs,
  })
  if (refusal !== null) {
    reportRefusal(refusal, args.checkName, nowMs)
    process.exitCode = 1
    return
  }

  console.log(`check:  ${args.checkName}`)
  console.log(`key:    ${args.findingKey}`)
  console.log(`silent: ${args.days} day(s) from now`)
  console.log(`operator: ops:${args.operator}`)
  console.log(`note: ${args.note}`)
  console.log(
    '\nThis silences the page, not the condition. The check keeps running and the run row keeps\n' +
      'counting this finding under acknowledged_count — if it is still there when the\n' +
      'acknowledgement expires, it pages again on its own.',
  )

  if (!args.confirm) {
    console.log('\nDRY RUN — nothing changed. Re-run with --confirm to acknowledge.')
    return
  }

  const outcome = await acknowledgeFinding({
    checkName: args.checkName,
    findingKey: args.findingKey,
    actor: `ops:${args.operator}`,
    note: args.note,
    days: args.days,
    nowMs,
  })

  if (!outcome.done) {
    // Reachable despite the check above when someone acknowledges the same finding in the gap.
    reportRefusal(outcome.refusal, args.checkName, nowMs)
    process.exitCode = 1
    return
  }

  await recordOpsAction(
    {
      actor: `ops:${args.operator}`,
      action: 'reconciliation_ack',
      transferId: null,
      reason: 'finding_acknowledged',
      note: args.note,
      before: { checkName: args.checkName, findingKey: args.findingKey },
      after: {
        acknowledgementId: outcome.acknowledgement.id,
        expiresAt: outcome.acknowledgement.expiresAt,
      },
      requestId: null,
    },
    log,
  )

  console.log(`\nAcknowledged ${outcome.acknowledgement.id}.`)
  console.log(`${args.checkName} — ${args.findingKey} is silent until ${outcome.acknowledgement.expiresAt}.`)
  console.log(
    `\n   verify: select actor, action, note from public.ops_actions ` +
      `where action = 'reconciliation_ack' order by created_at desc limit 1;`,
  )
}

// Only run when invoked directly, so the parsers stay unit-testable.
if (process.argv[1]?.includes('acknowledge-finding')) {
  main().catch((err: unknown) => {
    console.error(err instanceof Error ? err.message : String(err))
    process.exit(1)
  })
}
