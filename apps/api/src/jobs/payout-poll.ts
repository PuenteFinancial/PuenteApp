import * as Sentry from '@sentry/node'
import { supabaseAdmin } from '../services/supabase.js'
import { getBridgeTransfer } from '../services/bridge.js'
import { recordEvent } from '../services/payment-events.js'
import { enqueuePaymentEventProcess } from '../services/queue.js'

// The `payout.poll` reconciliation cron — the missed-webhook backstop and the
// second half of "one processing path for webhook + poll". For every transfer
// still in flight it GETs the Bridge transfer and synthesizes a bridge_poll
// event; recordEvent dedupes on (source, external_event_id), so a state we
// already saw is a no-op. It also owns the stale-`in_review` Sentry alert.

// A transfer sitting in in_review this long past submission is a real
// Bridge-side review/AML hold, not the routine transient initial state.
const IN_REVIEW_ALERT_MS = 60 * 60 * 1000

interface InFlightRow {
  id: string
  provider_transfer_ref: string | null
  submit_attempted_at: string | null
}

export async function pollPayouts(): Promise<number> {
  const { data, error } = await supabaseAdmin
    .from('transfers')
    .select('id, provider_transfer_ref, submit_attempted_at')
    .in('state', ['SUBMITTED', 'IN_FLIGHT'])
  if (error) throw new Error(`payout-poll select failed: ${error.message}`)

  const rows = (data ?? []) as InFlightRow[]
  let synthesized = 0
  const failures: string[] = []

  for (const row of rows) {
    if (!row.provider_transfer_ref) continue // not yet submitted to Bridge — sweep owns it
    try {
      const bridge = await getBridgeTransfer(row.provider_transfer_ref)

      if (bridge.state === 'in_review') {
        maybeAlertStaleReview(row)
        // still record it (dedupes); the processor ignores in_review
      }

      const { id, inserted } = await recordEvent({
        source: 'bridge_poll',
        externalEventId: `${bridge.bridgeTransferId}:${bridge.state}`,
        eventType: bridge.state,
        transferId: row.id,
        providerRef: bridge.bridgeTransferId,
        payload: { state: bridge.state, source_amount: bridge.sourceAmount, synthesized_from: 'payout.poll' },
      })
      if (inserted) {
        await enqueuePaymentEventProcess(id)
        synthesized++
      }
    } catch (err) {
      // One transfer's Bridge fetch failing must not sink the whole sweep.
      failures.push(err instanceof Error ? err.message : String(err))
    }
  }

  if (failures.length > 0) {
    throw new Error(`payout-poll: ${failures.length}/${rows.length} polls failed (first: ${failures[0]})`)
  }
  return synthesized
}

function maybeAlertStaleReview(row: InFlightRow): void {
  const since = row.submit_attempted_at ? new Date(row.submit_attempted_at).getTime() : null
  if (since === null || Date.now() - since < IN_REVIEW_ALERT_MS) return
  Sentry.withScope((scope) => {
    scope.setFingerprint(['payout-in-review-stale', row.id])
    scope.setContext('payout_in_review', {
      transferId: row.id,
      submitAttemptedAt: row.submit_attempted_at,
    })
    Sentry.captureMessage('bridge payout stuck in_review > 1h', 'warning')
  })
}
