import * as Sentry from '@sentry/node'
import { supabaseAdmin } from '../services/supabase.js'
import { transitionTransfer, completedLedgerEntries, TransferRpcError } from '../services/transfers.js'
import { mapBridgeState, markProcessed, markIgnored } from '../services/payment-events.js'

// The `payment-event.process` job — the ONE path that turns a recorded Bridge
// event (webhook OR poll-synthesized) into a transfer transition + ledger post.
// Idempotent throughout: the event row is claimed by status, transitions are
// replay-no-ops, and ledger posts are keyed {transferId}:{toState}. A crash
// re-runs the whole thing safely; a duplicate event (webhook + poll for the
// same state) resolves once and no-ops thereafter.

interface EventRow {
  id: string
  source: string
  event_type: string // the Bridge STATE string (recorded by ingest/poll)
  transfer_id: string | null
  provider_ref: string | null
  status: string
}

interface TransferRow {
  id: string
  state: string
  send_amount_minor: number
}

// States a fail event can legally advance from. COMPLETED is absent on
// purpose: a fail arriving after we already completed must never reverse it
// (that would be a slice-6 refund, ledger-posted, not a silent state move).
const FAILABLE_STATES = new Set(['SUBMITTED', 'IN_FLIGHT', 'UNDER_REVIEW'])

// The linear payout happy-path. A forward (success) event for a transfer that
// has left this path (e.g. PAYOUT_FAILED) is a contradictory Bridge sequence.
const FORWARD_STATES = new Set(['SUBMITTED', 'IN_FLIGHT', 'COMPLETED'])

// Benign RPC outcomes: another actor (the other arrival path, or a later
// event) already advanced the row. The event is still successfully processed.
const benign = (err: unknown) =>
  err instanceof TransferRpcError &&
  (err.code === 'transition_conflict' || err.code === 'transfer_not_found')

export async function processPaymentEvent(paymentEventId: string): Promise<void> {
  const { data: eventData, error: eventError } = await supabaseAdmin
    .from('payment_events')
    .select('id, source, event_type, transfer_id, provider_ref, status')
    .eq('id', paymentEventId)
    .maybeSingle()
  if (eventError) throw new Error(`payment-event load failed: ${eventError.message}`)
  const event = eventData as EventRow | null
  if (!event) return // vanished — nothing to do
  if (event.status !== 'received') return // already processed/ignored/failed — replay

  try {
    await route(event)
  } catch (err) {
    if (benign(err)) {
      // Row moved past this event concurrently — the event did its job.
      await markProcessed(event.id)
      return
    }
    // Retryable failure: leave status 'received' and rethrow. Marking the row
    // 'failed' here would defeat every recovery path — pg-boss retry, the
    // payout.sweep re-enqueue, and poll re-synthesis all skip a non-'received'
    // row, stranding the transfer (e.g. mid catch-up at IN_FLIGHT with the
    // COMPLETED ledger unposted). The worker handler reports the throw to
    // Sentry; the queue retry + 5-min sweep re-run this cleanly (each step is
    // idempotent) until it succeeds.
    throw err
  }
}

async function route(event: EventRow): Promise<void> {
  const action = mapBridgeState(event.event_type)

  if (action.kind === 'ignore') {
    await markIgnored(event.id)
    return
  }
  if (action.kind === 'unknown') {
    await markIgnored(event.id, `unmapped bridge state: ${event.event_type}`)
    return
  }

  const transfer = await resolveTransfer(event)
  if (!transfer) {
    // Out-of-order / unknown reference — mark ignored, not failed: a retry
    // won't resolve it, and the poller re-synthesizes once the transfer exists.
    await markIgnored(event.id, 'no transfer for event')
    return
  }

  if (action.kind === 'transition') {
    await drive(transfer, action.to)
    await markProcessed(event.id)
    return
  }

  // action.kind === 'fail'
  if (action.alert) {
    Sentry.withScope((scope) => {
      scope.setFingerprint(['payout-refund-failed'])
      scope.setContext('payout_failed', { transferId: transfer.id, state: event.event_type })
      Sentry.captureMessage('bridge refund_failed — principal stuck', 'error')
    })
  }
  await failTransfer(transfer, event.event_type)
  await markProcessed(event.id)
}

// Resolve our transfer for the event: the ingest path usually set transfer_id;
// otherwise fall back to the Bridge transfer id (provider_ref) against
// provider_transfer_ref (the plan's client_reference_id → provider_ref chain).
async function resolveTransfer(event: EventRow): Promise<TransferRow | null> {
  const load = async (column: 'id' | 'provider_transfer_ref', value: string) => {
    const { data, error } = await supabaseAdmin
      .from('transfers')
      .select('id, state, send_amount_minor')
      .eq(column, value)
      .maybeSingle()
    if (error) throw new Error(`payment-event transfer load failed: ${error.message}`)
    return (data as TransferRow | null) ?? null
  }
  if (event.transfer_id) {
    const byId = await load('id', event.transfer_id)
    if (byId) return byId
  }
  if (event.provider_ref) return load('provider_transfer_ref', event.provider_ref)
  return null
}

// Drive the transfer forward to `target` along SUBMITTED → IN_FLIGHT →
// COMPLETED, posting the COMPLETED ledger batch and catching up a missed
// IN_FLIGHT step. Every transition is replay-safe (already-there = no-op).
async function drive(transfer: TransferRow, target: 'IN_FLIGHT' | 'COMPLETED'): Promise<void> {
  const current = (await currentState(transfer.id)) ?? transfer.state

  // A success event for a transfer already off the forward path (PAYOUT_FAILED,
  // CANCELED, …) is a contradictory Bridge sequence — surface it to ops rather
  // than silently absorbing (symmetric to the fail-after-terminal guard).
  if (!FORWARD_STATES.has(current)) {
    Sentry.withScope((scope) => {
      scope.setFingerprint(['payout-success-after-terminal'])
      scope.setContext('payout_success', { transferId: transfer.id, current, target })
      Sentry.captureMessage('bridge success event on a non-forward transfer state', 'warning')
    })
    return
  }

  if (target === 'IN_FLIGHT') {
    if (current === 'SUBMITTED') {
      await step(transfer.id, 'SUBMITTED', 'IN_FLIGHT')
    }
    // already IN_FLIGHT or beyond → nothing to do (linear, never backwards)
    return
  }

  // target === 'COMPLETED': catch up the IN_FLIGHT hop if the webhook was missed
  if (current === 'SUBMITTED') {
    await step(transfer.id, 'SUBMITTED', 'IN_FLIGHT')
  }
  const afterCatchup = (await currentState(transfer.id)) ?? current
  if (afterCatchup === 'IN_FLIGHT') {
    await step(transfer.id, 'IN_FLIGHT', 'COMPLETED', completedLedgerEntries(transfer))
  }
  // already COMPLETED → replay no-op handled by the RPC
}

async function failTransfer(transfer: TransferRow, bridgeState: string): Promise<void> {
  const current = (await currentState(transfer.id)) ?? transfer.state
  if (current === 'PAYOUT_FAILED') return // already failed — benign
  if (!FAILABLE_STATES.has(current)) {
    // A fail after COMPLETED (or another terminal): never reverse it here.
    Sentry.withScope((scope) => {
      scope.setFingerprint(['payout-fail-after-terminal'])
      scope.setContext('payout_fail', { transferId: transfer.id, current, bridgeState })
      Sentry.captureMessage('bridge fail event on a non-failable transfer state', 'warning')
    })
    return
  }
  await step(transfer.id, current, 'PAYOUT_FAILED')
}

async function currentState(transferId: string): Promise<string | null> {
  const { data, error } = await supabaseAdmin
    .from('transfers')
    .select('state')
    .eq('id', transferId)
    .maybeSingle()
  if (error) throw new Error(`payment-event state read failed: ${error.message}`)
  return (data as { state: string } | null)?.state ?? null
}

async function step(
  transferId: string,
  fromState: string,
  toState: string,
  ledgerEntries?: ReturnType<typeof completedLedgerEntries>,
): Promise<void> {
  await transitionTransfer({
    transferId,
    fromState,
    toState,
    actor: 'worker:payment-event',
    reason: `bridge ${toState.toLowerCase()}`,
    ...(ledgerEntries
      ? { ledgerDescription: `transfer ${toState} — bridge confirmed`, ledgerEntries }
      : {}),
  })
}
