// Post a missing ACH-clears cash leg for a transfer whose funding_cleared flag
// is set but whose `funding_cleared` ledger transaction never landed.
//
// How that state arises: applyFundingCleared writes the flag BEFORE the
// posting, so a crash — or the pre-#304 clears-before-funding skip bug — can
// leave the flag set with the receivable still open. The daily reconciliation
// `cleared_postings` check then pages `cleared-without-posting:<id>` every run
// until the leg exists (docs/runbooks/reconciliation.md: corrections are new
// transactions, never edits).
//
//   DR cash_clearing        send+fee   cash settled at Stripe
//   CR funding_receivable   send+fee   the receivable opened at FUNDED
//
// The repair drives applyFundingCleared — the one implementation of the leg —
// rather than hand-building entries. The one thing that applier will NOT
// tolerate being wrong is the transfer id: it sets funding_cleared
// unconditionally, so this script refuses any transfer whose flag is not
// ALREADY set. A repair tool must never be the thing that marks a transfer
// cleared.
//
// Usage:
//   tsx scripts/post-clearing-leg.ts --transfer <uuid> [--confirm]
//
//   --transfer <uuid>  the transfer paged by cleared-without-posting:<uuid>
//   --confirm          actually post; WITHOUT it this is a dry run
//
// This imports src/services/*, so config/env.ts validates the full environment:
//   doppler run -- pnpm exec tsx scripts/post-clearing-leg.ts …   (staging/prod)
//   node --env-file=.env --import tsx scripts/post-clearing-leg.ts …   (local)
//
// A script, not an HTTP surface — nothing here is reachable over the network.
import { formatMoney } from '@puente/shared'
import { supabaseAdmin } from '../src/services/supabase.js'
import { getAccountBalance } from '../src/services/ledger.js'
import { applyFundingCleared } from '../src/services/funding-apply.js'
import { fundingClearedLedgerEntries } from '../src/services/transfers.js'
import { wasFreshPosting } from './record-float-topup.js'

const KNOWN_FLAGS = ['--transfer', '--confirm']

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export function parseArgs(argv: string[]): { transferId: string; confirm: boolean } {
  for (const arg of argv) {
    if (arg.startsWith('--') && !KNOWN_FLAGS.includes(arg)) {
      throw new Error(`unknown flag ${arg}. Known: ${KNOWN_FLAGS.join(', ')}`)
    }
  }
  const i = argv.indexOf('--transfer')
  const transferId = i === -1 ? undefined : argv[i + 1]
  if (!transferId || transferId.startsWith('--')) throw new Error('--transfer is required')
  if (!UUID_RE.test(transferId)) {
    throw new Error(`--transfer must be a UUID, got "${transferId}"`)
  }
  return { transferId: transferId.toLowerCase(), confirm: argv.includes('--confirm') }
}

export interface RepairCandidateRow {
  state: string
  funding_cleared: boolean
  send_amount_minor: number
  fee_amount_minor: number
  margin_minor: number
}

/**
 * The refusal gate, separated for tests. Only a transfer that ALREADY carries
 * the flag is repairable — applyFundingCleared would set it on anything else,
 * turning a typo'd id into a falsely-cleared transfer.
 */
export function repairRefusal(row: RepairCandidateRow | null): string | null {
  if (row === null) return 'no such transfer'
  if (!row.funding_cleared) {
    return 'funding_cleared is NOT set — this tool repairs a set flag missing its ledger leg; it never sets clearing'
  }
  return null
}

async function main(): Promise<void> {
  const { transferId, confirm } = parseArgs(process.argv.slice(2))

  const { data, error } = await supabaseAdmin
    .from('transfers')
    .select('state, funding_cleared, send_amount_minor, fee_amount_minor, margin_minor')
    .eq('id', transferId)
    .maybeSingle()
  if (error) throw new Error(`transfer load failed: ${error.message}`)
  const row = data as RepairCandidateRow | null

  const refusal = repairRefusal(row)
  if (refusal !== null) throw new Error(`refusing ${transferId}: ${refusal}`)
  const transfer = row as RepairCandidateRow

  const { data: existing, error: existingError } = await supabaseAdmin
    .from('ledger_transactions')
    .select('id, posted_at')
    .eq('transfer_id', transferId)
    .eq('transition', 'funding_cleared')
    .maybeSingle()
  if (existingError) throw new Error(`ledger lookup failed: ${existingError.message}`)
  if (existing) {
    const posted = existing as { id: string; posted_at: string }
    console.log(
      `Nothing to repair: funding_cleared already posted (${posted.id} at ${posted.posted_at}).`,
    )
    return
  }

  const entries = fundingClearedLedgerEntries(transfer)
  const total = transfer.send_amount_minor + transfer.fee_amount_minor
  const before = await getAccountBalance('funding_receivable')

  console.log(`transfer ${transferId} — state ${transfer.state}, funding_cleared set, leg missing`)
  console.log(`funding_receivable before: ${formatMoney(before)}`)
  console.log('\nWould post (transition funding_cleared):')
  for (const e of entries) {
    console.log(
      `  ${e.direction.toUpperCase().padEnd(6)} ${e.account_code.padEnd(20)} ${formatMoney({ amountMinor: e.amount_minor, currency: e.currency })}`,
    )
  }

  if (!confirm) {
    console.log('\nDRY RUN — nothing posted. Re-run with --confirm to record it.')
    return
  }

  const outcome = await applyFundingCleared({ transferId })
  if (outcome.outcome === 'skipped') {
    // The applier's own guard: the receivable was never opened or is already
    // closed (void/cancel/refund states) — posting would drive it negative.
    console.log(`\nSkipped by the applier: state ${outcome.state} has no open receivable.`)
    return
  }

  const after = await getAccountBalance('funding_receivable')
  // The clearing leg CREDITS the debit-normal receivable, so fresh = balance
  // fell by exactly the total.
  if (wasFreshPosting(after.amountMinor, before.amountMinor, total)) {
    console.log(`\nPosted ${formatMoney({ amountMinor: total, currency: 'USD' })} clearing leg.`)
  } else {
    console.log('\nApplied, but the balance delta is not the clean amount — the ledger deduped a')
    console.log('concurrent posting, or unrelated activity crossed this run. Verify directly.')
  }
  console.log(`funding_receivable after: ${formatMoney(after)}`)
}

// Only run when invoked directly, so the parsers stay unit-testable.
if (process.argv[1]?.includes('post-clearing-leg')) {
  main().catch((err: unknown) => {
    console.error(err instanceof Error ? err.message : String(err))
    process.exit(1)
  })
}
