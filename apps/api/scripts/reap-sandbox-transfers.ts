// Reap abandoned Bridge SANDBOX test sends.
//
// Bridge sandbox accepts a payout and then never delivers it. The transfer sits
// in SUBMITTED forever, and because it is genuinely non-terminal, every watcher
// is right to keep flagging it: stuck-watch pages it, transfer_aging flags it,
// and the ops page lists it as money in flight. Three such rows produced the
// top issues in the 2026-09-01 Sentry quota burn — one sat in SUBMITTED for 7.1
// days. The alerting side of that is now bounded; this is the other half,
// clearing the rows so nothing has to be bounded around them.
//
// WHAT IT DOES, per candidate:
//   1) SUBMITTED|IN_FLIGHT -> PAYOUT_FAILED. No ledger batch, mirroring
//      payment-event-process's failTransfer: the principal is still at Bridge
//      (due_from_bridge is open) and the reversal belongs to the refund tail.
//   2) refundPayoutFailure() — the OWNING code — posts bridge_return (closing
//      due_from_bridge), disburses under the refund claim, and settles REFUNDED.
//
// The book then says these test sends never delivered, which is true. Nothing
// here reimplements a ledger batch; every posting is made by the code that owns
// it, so a change to the refund tail cannot leave this script behind.
//
// NOT for a transfer that never reached Bridge. Those never opened
// due_from_bridge, so the bridge_return batch would push it negative — the
// 2026-08-28 cleanup hit exactly this and skipped the batch by hand. Such rows
// are already PAYOUT_FAILED (not SUBMITTED/IN_FLIGHT), so they are outside this
// script's candidate set by construction; refund them with trigger-refund.ts.
//
// Usage:
//   tsx scripts/reap-sandbox-transfers.ts [--older-than-days <n>] [--confirm]
//
//   --older-than-days <n>  minimum age in the current state; default 3
//   --confirm              actually reap; WITHOUT it this is a dry run
//
//   node --env-file=.env --import tsx scripts/reap-sandbox-transfers.ts
//
// A script, not an HTTP surface — nothing here is reachable over the network.
import { env } from '../src/config/env.js'
import { supabaseAdmin } from '../src/services/supabase.js'
import { transitionTransfer } from '../src/services/transfers.js'
import { refundPayoutFailure } from '../src/services/refunds.js'

const KNOWN_FLAGS = ['--older-than-days', '--confirm']
const REAPABLE_STATES = ['SUBMITTED', 'IN_FLIGHT'] as const
const ACTOR = 'ops:sandbox-reaper'
const SANDBOX_HOST = 'api.sandbox.bridge.xyz'

// ── the gate ────────────────────────────────────────────────────────────────
// This script drives transfers to terminal states and posts ledger batches. On
// the live rail those are real customer funds, so the gate is on the RAIL
// ITSELF, not on an environment label:
//
//  * SENTRY_ENVIRONMENT is optional (config/env.ts), so its ABSENCE must never
//    be read as "not production" — an unset label is unknown, not safe.
//  * BRIDGE_API_BASE defaults to https://api.bridge.xyz — the LIVE base. An
//    unset value is production, not a safe blank.
//
// So: refuse unless the configured Bridge host is exactly the sandbox host.
// Compared as a parsed hostname rather than a substring, because
// "https://api.bridge.xyz/?x=sandbox" and "sandbox.example.com" both contain
// the word and neither is Bridge sandbox.
export function sandboxRailRefusal(bridgeApiBase: string): string | null {
  let hostname: string
  try {
    hostname = new URL(bridgeApiBase).hostname
  } catch {
    return `BRIDGE_API_BASE is not a valid URL (${bridgeApiBase})`
  }
  if (hostname !== SANDBOX_HOST) {
    return (
      `refusing to run: BRIDGE_API_BASE points at "${hostname}", not the Bridge sandbox ` +
      `(${SANDBOX_HOST}). This script fails and refunds transfers — on the live rail that is ` +
      `real customer money. If you meant to clear a live transfer, use trigger-refund.ts, ` +
      `which is built for that and asks for the transfer explicitly.`
    )
  }
  return null
}

export function parseArgs(argv: string[]): { olderThanDays: number; confirm: boolean } {
  for (const arg of argv) {
    if (arg.startsWith('-') && !KNOWN_FLAGS.includes(arg)) {
      throw new Error(`unknown flag "${arg}"`)
    }
  }
  let olderThanDays = 3
  const flagIndex = argv.indexOf('--older-than-days')
  if (flagIndex !== -1) {
    const raw = argv[flagIndex + 1]
    // A missing value must not silently take the default, and `--older-than-days
    // --confirm` must not consume the confirm token as its value (trigger-refund's
    // lesson: a lenient parser lets a flag authorize itself).
    if (raw === undefined || raw.startsWith('-')) {
      throw new Error('--older-than-days needs a value, e.g. --older-than-days 3')
    }
    if (!/^\d{1,4}$/.test(raw)) {
      throw new Error(`--older-than-days must be a whole number of days, got "${raw}"`)
    }
    olderThanDays = Number(raw)
    if (olderThanDays < 1) throw new Error('--older-than-days must be at least 1')
  }
  return { olderThanDays, confirm: argv.includes('--confirm') }
}

interface Candidate {
  id: string
  state: string
  provider_transfer_ref: string | null
  send_amount_minor: number
  submit_attempted_at: string | null
  created_at: string
}

async function main(): Promise<void> {
  const refusal = sandboxRailRefusal(env.BRIDGE_API_BASE)
  if (refusal) {
    console.error(`\n${refusal}\n`)
    process.exit(1)
  }

  const { olderThanDays, confirm } = parseArgs(process.argv.slice(2))
  const cutoff = new Date(Date.now() - olderThanDays * 24 * 60 * 60_000).toISOString()

  const { data, error } = await supabaseAdmin
    .from('transfers')
    .select('id, state, provider_transfer_ref, send_amount_minor, submit_attempted_at, created_at')
    .in('state', [...REAPABLE_STATES])
    .lt('submit_attempted_at', cutoff)
  if (error || data == null) {
    throw new Error(`candidate select failed: ${error?.message ?? 'no rows returned'}`)
  }
  const candidates = data as Candidate[]

  console.log(`\nBridge rail: ${env.BRIDGE_API_BASE} (sandbox — gate passed)`)
  console.log(`Candidates in ${REAPABLE_STATES.join('/')} claimed before ${cutoff}: ${candidates.length}`)
  for (const c of candidates) {
    const ageDays = ((Date.now() - new Date(c.submit_attempted_at ?? c.created_at).getTime()) / 86_400_000).toFixed(1)
    console.log(
      `  ${c.id}  ${c.state.padEnd(9)}  $${(c.send_amount_minor / 100).toFixed(2).padStart(8)}  ` +
        `${ageDays}d  bridge=${c.provider_transfer_ref ?? 'NONE'}`,
    )
  }
  if (candidates.length === 0) {
    console.log('\nNothing to reap.')
    return
  }

  if (!confirm) {
    console.log('\nDRY RUN — nothing changed. Re-run with --confirm to fail and refund these.')
    return
  }

  let reaped = 0
  const failures: string[] = []
  for (const c of candidates) {
    try {
      // Re-read under the transition's own optimistic guard rather than trusting
      // the snapshot: a poll or webhook can land between the select and here,
      // and transitionTransfer's fromState check is what makes that safe.
      await transitionTransfer({
        transferId: c.id,
        fromState: c.state,
        toState: 'PAYOUT_FAILED',
        actor: ACTOR,
        reason: `sandbox reaper: no delivery ${olderThanDays}d after submission — Bridge sandbox does not settle payouts`,
      })
      const outcome = await refundPayoutFailure({
        transferId: c.id,
        actor: ACTOR,
        reason: 'sandbox reaper: abandoned test send, principal returned to sender',
      })
      if (!outcome.done) {
        failures.push(`${c.id}: refund refused (${JSON.stringify(outcome)})`)
        continue
      }
      reaped++
      console.log(`[reaped] ${c.id} → PAYOUT_FAILED → ${JSON.stringify(outcome)}`)
    } catch (err) {
      failures.push(`${c.id}: ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  console.log(`\nReaped ${reaped}/${candidates.length}.`)
  if (failures.length > 0) {
    // Loud, and non-zero: a partial reap that exits 0 reads as a clean sweep.
    console.error(`\n${failures.length} failed:`)
    for (const f of failures) console.error(`  ${f}`)
    process.exit(1)
  }
}

// Only run when invoked directly, so the gate and the parser stay unit-testable.
// endsWith, not includes: `includes('reap-sandbox-transfers')` also matches
// reap-sandbox-transfers.test.ts, which would run the whole script on import.
if (process.argv[1]?.endsWith('reap-sandbox-transfers.ts')) {
  main().catch((err: unknown) => {
    console.error(err instanceof Error ? err.message : String(err))
    process.exit(1)
  })
}
