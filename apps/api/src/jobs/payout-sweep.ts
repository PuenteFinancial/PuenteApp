import { supabaseAdmin } from '../services/supabase.js'
import { enqueuePayoutSubmit, enqueuePaymentEventProcess } from '../services/queue.js'

// The 1-min healing sweep (`payout.sweep`) — the safety net that makes
// enqueue-after-commit sound without a transactional outbox (plan decision 3):
// any FUNDED row whose enqueue was lost, and any recorded payment event whose
// processing job was lost, gets re-enqueued here. Duplicate enqueues collapse
// via the stately singletonKey; duplicate runs are RPC/dedupe no-ops.

// A claim this old with no provider ref means the claimant died before (or
// during) the Bridge POST — safe to re-enter via the idempotent recovery path.
const STALE_CLAIM_MS = 10 * 60 * 1000
// 'received' events normally process within seconds; older than this means
// the enqueue was lost (or the worker was down).
const STALE_EVENT_MS = 5 * 60 * 1000

export async function sweepPayouts(): Promise<number> {
  const now = Date.now()
  const staleClaimCutoff = new Date(now - STALE_CLAIM_MS).toISOString()
  const staleEventCutoff = new Date(now - STALE_EVENT_MS).toISOString()

  // FUNDED, unheld, and either never claimed or stale-claimed with no Bridge
  // ref (claimed + ref means the transition is what's missing — the poller's
  // job, not a resubmission). Rides transfers_funded_created_at_idx.
  const { data: transfers, error: transfersError } = await supabaseAdmin
    .from('transfers')
    .select('id')
    .eq('state', 'FUNDED')
    .is('payout_hold_reason', null)
    .or(
      `submit_attempted_at.is.null,and(submit_attempted_at.lt.${staleClaimCutoff},provider_transfer_ref.is.null)`,
    )
  if (transfersError) throw new Error(`payout-sweep transfers select failed: ${transfersError.message}`)

  const { data: events, error: eventsError } = await supabaseAdmin
    .from('payment_events')
    .select('id')
    .eq('status', 'received')
    .lt('received_at', staleEventCutoff)
  if (eventsError) throw new Error(`payout-sweep events select failed: ${eventsError.message}`)

  let enqueued = 0
  const failures: string[] = []
  for (const row of (transfers ?? []) as { id: string }[]) {
    try {
      await enqueuePayoutSubmit(row.id)
      enqueued++
    } catch (err) {
      failures.push(err instanceof Error ? err.message : String(err))
    }
  }
  for (const row of (events ?? []) as { id: string }[]) {
    try {
      await enqueuePaymentEventProcess(row.id)
      enqueued++
    } catch (err) {
      failures.push(err instanceof Error ? err.message : String(err))
    }
  }

  // Every row got its attempt; surface the failure so the next tick retries.
  if (failures.length > 0) {
    throw new Error(`payout-sweep: ${failures.length} enqueue(s) failed (first: ${failures[0]})`)
  }
  return enqueued
}
