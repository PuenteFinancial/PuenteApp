import * as Sentry from '@sentry/node'
import { env } from '../config/env.js'
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

  // slice-6 PR2 self-heal: when AUTO_REFUND is on, also re-poll PAYOUT_FAILED
  // transfers whose refund hasn't landed (provider_transfer_ref set but
  // refund_payment_ref still null) — a missed terminal returned/refunded webhook
  // re-synthesizes here (recordEvent dedupes, so an already-seen state no-ops)
  // and the processor drives the refund. Gated on AUTO_REFUND: with it off the
  // refund never drives, so don't burn Bridge GETs on rows a human owns.
  //
  // LIMITATION (recorded slice-7 item): this recovers only a terminal event not
  // yet recorded — a genuinely missed webhook while AUTO_REFUND is on. A row
  // whose terminal event was already recorded+processed while AUTO_REFUND was
  // OFF (the in-flight sweep caught it, drove PAYOUT_FAILED, and stopped at the
  // gate with a "manual refund required" alert) is NOT re-driven by later
  // flipping AUTO_REFUND on: recordEvent dedupes the re-synthesis on
  // (source, external_event_id). Those parked rows are cleared by the runbook /
  // the deferred ops-trigger surface, not by the flip. Flipping the flag on
  // governs FUTURE failures; the off-era backlog is human-owned.
  if (env.AUTO_REFUND) {
    const { data: refundPending, error: refundError } = await supabaseAdmin
      .from('transfers')
      .select('id, provider_transfer_ref, submit_attempted_at')
      .eq('state', 'PAYOUT_FAILED')
      .not('provider_transfer_ref', 'is', null)
      .is('refund_payment_ref', null)
    if (refundError) throw new Error(`payout-poll refund-pending select failed: ${refundError.message}`)
    rows.push(...((refundPending ?? []) as InFlightRow[]))
  }
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
