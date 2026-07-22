import { supabaseAdmin } from './supabase.js'

// Provider-event ingest support for the payment-event.process job (slice 5
// PR 3): the pure Bridge-state → Puente-action map (flows.md §2), the
// idempotent event recorder, and the status mark helpers. One processing path
// serves both arrival sources ('bridge' webhook, 'bridge_poll' synthesized).
//
// The raw payload is service-role-only and MUST NEVER reach application logs
// (decision 6) — nothing here logs, and recordEvent never returns the payload.

// ── Bridge state → Puente action (flows.md §2 map) ──────────────────────────
// Pure, exhaustive over the documented Bridge states, with an explicit
// unknown-state fallthrough so a never-before-seen Bridge state is marked
// 'ignored' by the processor rather than crashing the job. `fail` carries no
// `from`: the transition is state-aware (SUBMITTED or IN_FLIGHT) and the
// processor resolves the current state.
//
// `principalReturned` (slice-6 PR2): Bridge has returned the principal, so the
// processor drives the PAYOUT_FAILED → REFUNDED refund-from-float tail (gated by
// AUTO_REFUND). It's on the TERMINAL return states (returned/refunded) only —
// refund_in_flight is still in progress, so it's a plain fail that just parks
// the transfer at PAYOUT_FAILED until the terminal event arrives.
export type BridgeStateAction =
  | { kind: 'ignore' }
  | { kind: 'transition'; from: 'SUBMITTED'; to: 'IN_FLIGHT' }
  | { kind: 'transition'; from: 'IN_FLIGHT'; to: 'COMPLETED'; ledger: 'completed' }
  | { kind: 'fail'; to: 'PAYOUT_FAILED'; principalReturned?: true; alert?: true }
  | { kind: 'unknown' }

export function mapBridgeState(state: string): BridgeStateAction {
  switch (state) {
    // Already SUBMITTED when these arrive; in_review is a routine transient
    // initial state (poller owns the >1h persistence Sentry alert — not here).
    case 'awaiting_funds':
    case 'funds_received':
    case 'in_review':
      return { kind: 'ignore' }

    case 'payment_submitted':
      return { kind: 'transition', from: 'SUBMITTED', to: 'IN_FLIGHT' }

    // ledger flag tells the processor to attach completedLedgerEntries; the
    // processor also catches up SUBMITTED→IN_FLIGHT→COMPLETED on a missed webhook.
    case 'payment_processed':
      return { kind: 'transition', from: 'IN_FLIGHT', to: 'COMPLETED', ledger: 'completed' }

    // State-aware fail from SUBMITTED or IN_FLIGHT; no ledger (refund postings
    // are slice 6).
    case 'undeliverable':
    case 'error':
    case 'canceled':
      return { kind: 'fail', to: 'PAYOUT_FAILED' }

    // Terminal return: Bridge has sent the principal back → PAYOUT_FAILED and,
    // when AUTO_REFUND is on, drive the refund-from-float tail (bridge_return +
    // REFUNDED batches). ⚠️ Assumes Bridge returns S (quoted principal), not A
    // (actual USDC draw incl. slippage) — sandbox-unverified, slice-7 item.
    case 'returned':
    case 'refunded':
      return { kind: 'fail', to: 'PAYOUT_FAILED', principalReturned: true }

    // Return still in progress: park at PAYOUT_FAILED and WAIT — the terminal
    // returned/refunded event drives the refund. No principalReturned yet.
    case 'refund_in_flight':
      return { kind: 'fail', to: 'PAYOUT_FAILED' }

    // Principal stuck at Bridge — ops Sentry alert (stuck-transfer runbook).
    case 'refund_failed':
      return { kind: 'fail', to: 'PAYOUT_FAILED', alert: true }

    // Never crash on a new Bridge state — the processor marks it 'ignored'.
    default:
      return { kind: 'unknown' }
  }
}

// ── Event recorder ──────────────────────────────────────────────────────────

export interface RecordEventInput {
  source: 'bridge' | 'bridge_poll'
  externalEventId: string
  eventType: string
  transferId?: string | null
  providerRef?: string | null
  payload: unknown
}

/**
 * Insert a provider event into payment_events, deduped on
 * (source, external_event_id). Returns the row id either way and whether THIS
 * call inserted it — inserted=false on a redelivery/re-synthesis of an event
 * already recorded. status is left to the 'received' DB default. The payload
 * is stored raw and is NEVER logged or returned.
 */
export async function recordEvent(
  input: RecordEventInput,
): Promise<{ id: string; inserted: boolean }> {
  // ON CONFLICT DO NOTHING: the conflicting row returns no representation, so
  // a null select result means this call lost the insert race (duplicate).
  const { data: inserted, error: upsertError } = await supabaseAdmin
    .from('payment_events')
    .upsert(
      {
        source: input.source,
        external_event_id: input.externalEventId,
        event_type: input.eventType,
        transfer_id: input.transferId ?? null,
        provider_ref: input.providerRef ?? null,
        payload: input.payload,
      },
      { onConflict: 'source,external_event_id', ignoreDuplicates: true },
    )
    .select('id')
    .maybeSingle()
  if (upsertError) throw new Error(`payment_events insert failed: ${upsertError.message}`)

  if (inserted) return { id: (inserted as { id: string }).id, inserted: true }

  // Duplicate: fetch the existing row's id for the caller (enqueue is a no-op
  // on the already-processed row, but the id keeps one call shape).
  const { data: existing, error: selectError } = await supabaseAdmin
    .from('payment_events')
    .select('id')
    .eq('source', input.source)
    .eq('external_event_id', input.externalEventId)
    .maybeSingle()
  if (selectError) throw new Error(`payment_events lookup failed: ${selectError.message}`)
  if (!existing) {
    throw new Error('payment_events row vanished after conflict — unexpected')
  }
  return { id: (existing as { id: string }).id, inserted: false }
}

// ── Status mark helpers ─────────────────────────────────────────────────────
// Terminal status writes for a processed event; processed_at stamps the
// resolution. The moddatetime trigger moves updated_at.

async function markStatus(
  id: string,
  status: 'processed' | 'ignored' | 'failed',
  error: string | null,
): Promise<void> {
  const { error: updateError } = await supabaseAdmin
    .from('payment_events')
    .update({ status, processed_at: new Date().toISOString(), error })
    .eq('id', id)
  if (updateError) throw new Error(`payment_events mark ${status} failed: ${updateError.message}`)
}

export function markProcessed(id: string): Promise<void> {
  return markStatus(id, 'processed', null)
}

export function markIgnored(id: string, reason?: string): Promise<void> {
  return markStatus(id, 'ignored', reason ?? null)
}

// NOTE: there is deliberately no markFailed. A processing error must leave the
// row 'received' so pg-boss retry, payout.sweep, and poll re-synthesis re-run
// it (each transition is idempotent) — a terminal 'failed' status would strand
// the transfer, since every recovery path skips non-'received' rows. The DB
// still allows 'failed' for a future manual/dead-letter tool.
