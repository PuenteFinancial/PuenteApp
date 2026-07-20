import { supabaseAdmin } from '../services/supabase.js'
import { transitionTransfer, TransferRpcError } from '../services/transfers.js'

// A PENDING_PAYMENT older than this never got its funding webhook — the
// processor either failed silently or the user abandoned checkout.
const STALE_AFTER_MS = 30 * 60 * 1000

// Codes that mean another actor moved the row between our select and the
// RPC — the row is already handled, not an error.
const BENIGN_CODES = new Set(['transition_conflict', 'transfer_not_found'])

// Cron sweep (`transfer.reconcile-pending`): stale PENDING_PAYMENT →
// PAYMENT_FAILED. No ledger entries on purpose — a stuck PENDING_PAYMENT has
// zero postings (the FUNDED batch never ran), so this is a dead row, not
// lost money. Returns the count actually transitioned.
export async function reconcilePendingTransfers(): Promise<number> {
  const cutoff = new Date(Date.now() - STALE_AFTER_MS).toISOString()
  const { data, error } = await supabaseAdmin
    .from('transfers')
    .select('id')
    .eq('state', 'PENDING_PAYMENT')
    .lt('created_at', cutoff)
  if (error) throw new Error(`reconcile-pending select failed: ${error.message}`)

  const rows = (data ?? []) as { id: string }[]
  let transitioned = 0
  const failures: string[] = []
  for (const row of rows) {
    try {
      await transitionTransfer({
        transferId: row.id,
        fromState: 'PENDING_PAYMENT',
        toState: 'PAYMENT_FAILED',
        actor: 'worker:reconcile-pending',
        reason: 'funding_not_received_within_30_minutes',
      })
      transitioned++
    } catch (err) {
      if (err instanceof TransferRpcError && BENIGN_CODES.has(err.code)) continue
      failures.push(err instanceof Error ? err.message : String(err))
    }
  }

  // Throw only after every row got its attempt: pg-boss retries the batch,
  // and already-transitioned rows are no-ops on replay.
  if (failures.length > 0) {
    throw new Error(
      `reconcile-pending: ${failures.length}/${rows.length} transitions failed (first: ${failures[0]})`,
    )
  }
  return transitioned
}
