import * as Sentry from '@sentry/node'
import { env } from '../config/env.js'
import { supabaseAdmin } from '../services/supabase.js'
import {
  transitionTransfer,
  completedLedgerEntries,
  fxRateToWire,
  TransferRpcError,
} from '../services/transfers.js'
import { refundPayoutFailure } from '../services/refunds.js'
import { buildReceiptDisclosure } from '../services/disclosures.js'
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
  user_id: string
  state: string
  send_amount_minor: number
  // slice-6 PR3 receipt: the remaining snapshot terms the receipt is built from.
  // (The refund tail's own inputs — refund_payment_ref, funding_payment_ref,
  // idempotency_key — live in services/refunds.ts, which re-reads them itself.)
  fee_amount_minor: number
  receive_amount_minor: number
  fx_rate: number
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
  // slice-6 PR2: Bridge returned the principal → drive the refund-from-float
  // tail (gated). Before markProcessed so a throw leaves the event 'received'
  // for pg-boss retry / poll self-heal to re-run — every step is idempotent.
  if (action.principalReturned) {
    await driveRefund(transfer, event)
  }
  await markProcessed(event.id)
}

// The PAYOUT_FAILED → REFUNDED refund-from-float tail itself lives in
// services/refunds.ts (slice-7 PR6a) — ONE implementation shared with the
// operator CLI, so the automated path and the by-hand path cannot diverge.
// What stays here is the POLICY GATE: AUTO_REFUND (mechanism now / policy via
// flag — same as WAIT_FOR_CLEARING and the float ceiling). OFF (prod default)
// stops at PAYOUT_FAILED + an ops alert and a human refunds via
// scripts/trigger-refund.ts; ON drives the full path. The gate is deliberately
// at this call site rather than inside the service: a `force` parameter on a
// money-moving service would make the policy invisible to the next caller.
// Any throw propagates (non-benign) to leave the event 'received' for retry.
async function driveRefund(transfer: TransferRow, event: EventRow): Promise<void> {
  if (!env.AUTO_REFUND) {
    // failTransfer alerts + no-ops a fail-after-COMPLETED, so re-read before
    // alerting: "manual refund required" must never fire for a transfer that
    // actually delivered. (On the ON path the service does this re-read itself.)
    const current = (await currentState(transfer.id)) ?? transfer.state
    if (current !== 'PAYOUT_FAILED') return

    Sentry.withScope((scope) => {
      scope.setFingerprint(['payout-refund-gated', transfer.id])
      scope.setContext('payout_refund_gated', {
        transferId: transfer.id,
        bridgeState: event.event_type,
        // point the alert at its own fix
        runbook: 'docs/runbooks/manual-refund.md',
      })
      Sentry.captureMessage(
        'payout failed, principal returned — AUTO_REFUND off, manual refund required',
        'warning',
      )
    })
    return
  }

  const outcome = await refundPayoutFailure({
    transferId: transfer.id,
    actor: 'worker:payment-event',
    reason: 'refund completed — sender made whole',
  })

  // A refusal means the sender was NOT refunded, and the caller marks the event
  // 'processed' either way — so nothing retries and nothing else would ever
  // notice. Every other contradictory-sequence branch in this file pages ops
  // (payout-success-after-terminal, payout-fail-after-terminal); the one that
  // holds the sender's money must not be the silent one. Reachable when the row
  // moves between failTransfer and the service's re-read.
  if (!outcome.done) {
    Sentry.withScope((scope) => {
      scope.setFingerprint(['payout-refund-refused', transfer.id])
      scope.setContext('payout_refund_refused', {
        transferId: transfer.id,
        reason: outcome.reason,
        bridgeState: event.event_type,
        runbook: 'docs/runbooks/manual-refund.md',
      })
      Sentry.captureMessage(
        'refund tail refused — transfer not refunded, sender still owed',
        'error',
      )
    })
  }
}

// Resolve our transfer for the event: the ingest path usually set transfer_id;
// otherwise fall back to the Bridge transfer id (provider_ref) against
// provider_transfer_ref (the plan's client_reference_id → provider_ref chain).
async function resolveTransfer(event: EventRow): Promise<TransferRow | null> {
  const load = async (column: 'id' | 'provider_transfer_ref', value: string) => {
    const { data, error } = await supabaseAdmin
      .from('transfers')
      .select(
        'id, user_id, state, send_amount_minor, fee_amount_minor, ' +
          'receive_amount_minor, fx_rate',
      )
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

  // slice-6 PR3: write the Reg E receipt. Before markProcessed (the caller marks
  // after drive returns), so a crash between the COMPLETED ledger post and the
  // receipt leaves the event 'received' and self-heals on retry. writeReceipt
  // re-reads state and no-ops unless COMPLETED, and the upsert is idempotent.
  await writeReceipt(transfer)
}

// Write the Reg E receipt for a delivered transfer, idempotently. Guards on the
// live state — a concurrent fail could move the row off COMPLETED between drive's
// catch-up steps, and a receipt must exist only for a delivered transfer.
async function writeReceipt(transfer: TransferRow): Promise<void> {
  const current = await currentState(transfer.id)
  if (current !== 'COMPLETED') return

  // Presented language = the user's preference (the same source the prepayment
  // disclosure used at creation); both renderings are stored in content.
  const { data: userData, error: userError } = await supabaseAdmin
    .from('users')
    .select('preferred_language')
    .eq('id', transfer.user_id)
    .maybeSingle()
  if (userError) throw new Error(`payment-event receipt user load failed: ${userError.message}`)
  const locale =
    (userData as { preferred_language?: string } | null)?.preferred_language === 'en' ? 'en' : 'es'

  // Built from the transfer's IMMUTABLE snapshot terms = the delivered amounts
  // (Bridge fixes destination.amount in MXN, so the recipient got exactly this).
  const receipt = buildReceiptDisclosure(
    {
      sendMinor: transfer.send_amount_minor,
      feeMinor: transfer.fee_amount_minor,
      receiveMinor: transfer.receive_amount_minor,
      fxRate: fxRateToWire(transfer.fx_rate),
    },
    locale,
    env.CANCEL_WINDOW_MINUTES,
  )

  // One receipt per transfer: ON CONFLICT (transfer_id, type) DO NOTHING. A
  // replay / catch-up / crash-retry writes it exactly once, and the no-op insert
  // never trips the disclosures append-only trigger (before update/delete). A
  // real error rethrows to leave the event 'received' for retry.
  const { error } = await supabaseAdmin.from('disclosures').upsert(
    {
      transfer_id: transfer.id,
      type: 'receipt',
      locale: receipt.locale,
      content: receipt.content,
    },
    { onConflict: 'transfer_id,type', ignoreDuplicates: true },
  )
  if (error) throw new Error(`payment-event receipt upsert failed: ${error.message}`)
}

async function failTransfer(transfer: TransferRow, bridgeState: string): Promise<void> {
  const current = (await currentState(transfer.id)) ?? transfer.state
  // Already at a refund-tail terminal — a late/duplicate fail or return event is
  // benign, not a contradictory sequence. REFUNDED matters since PR2 made it
  // reachable from PAYOUT_FAILED: a duplicate returned/refunded (webhook + poll,
  // or a post-REFUNDED retry) lands here on REFUNDED and must NOT trip the
  // post-delivery-reversal loss alert below — they share this fingerprint, and a
  // routine refund duplicate would train ops to ignore a real money-loss signal.
  if (current === 'PAYOUT_FAILED' || current === 'REFUNDED') return
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
