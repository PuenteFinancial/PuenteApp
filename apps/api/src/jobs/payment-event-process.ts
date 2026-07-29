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
import { pendingCancellationFor } from '../services/cancellations.js'
import { buildReceiptDisclosure } from '../services/disclosures.js'
import {
  mapBridgeState,
  markProcessed,
  markIgnored,
  earliestDepositEvidenceAt,
} from '../services/payment-events.js'

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
// UNDER_REVIEW is absent for the SAME reason (PR6b review fix): since PR6b its
// only writer is the cancellation routing on a DELIVERED transfer — the
// COMPLETED batch is posted and the receipt written. Treating it as failable
// let a late Bridge fail event silently drive UNDER_REVIEW → PAYOUT_FAILED and
// (AUTO_REFUND on) run the payout-failure tail against delivered books:
// bridge_return + REFUNDED batches that assume the SUBMITTED shape, and the
// Reg E request closed with a false "payout failed" resolution. A fail event
// here is a contradictory sequence like any other post-delivery fail — it
// PAGES (payout-fail-after-terminal) and a human resolves through the review
// exits, which post the correct correction ledger if a refund is really owed.
const FAILABLE_STATES = new Set(['SUBMITTED', 'IN_FLIGHT'])

// The linear payout happy-path. A forward (success) event for a transfer that
// has left this path (e.g. PAYOUT_FAILED) is a contradictory Bridge sequence.
const FORWARD_STATES = new Set(['SUBMITTED', 'IN_FLIGHT', 'COMPLETED'])

// States in which the sender is owed nothing further — the money was delivered,
// returned, or never taken. A refund-tail refusal on one of these is not a
// money-stuck event, so it must not raise the "sender still owed" page.
const SETTLED_STATES = new Set([
  'COMPLETED',
  'CANCELED',
  'REFUNDED',
  'PAYMENT_FAILED',
  'FUNDING_REVERSED',
])

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
    // false = the refund has NOT happened (a claim refusal). Leave the event
    // 'received' so payout-sweep keeps re-driving it; retiring it here is what
    // would strand the sender with no alert (see driveRefund).
    const resolved = await driveRefund(transfer, event)
    if (!resolved) return
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
//
// Returns whether the event may be RETIRED. `false` means "not resolved yet —
// leave the row 'received' so payout-sweep re-drives it"; the only such cases
// are the two claim refusals, where the refund provably has not happened.
async function driveRefund(transfer: TransferRow, event: EventRow): Promise<boolean> {
  if (!env.AUTO_REFUND) {
    // failTransfer alerts + no-ops a fail-after-COMPLETED, so re-read before
    // alerting: "manual refund required" must never fire for a transfer that
    // actually delivered. (On the ON path the service does this re-read itself.)
    const current = (await currentState(transfer.id)) ?? transfer.state
    if (current !== 'PAYOUT_FAILED') return true

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
    // Retire the event: with the flag off a human owns this row via the runbook,
    // and re-driving it every 5 minutes would re-alert without changing anything.
    return true
  }

  const outcome = await refundPayoutFailure({
    transferId: transfer.id,
    actor: 'worker:payment-event',
    reason: 'refund completed — sender made whole',
  })

  // The refund claim (slice-7 PR6b-0) produces two refusals of its own. Both
  // mean THE REFUND HAS NOT HAPPENED YET, so neither may retire the event — the
  // caller skips markProcessed on a `false` return and the row stays 'received'
  // for payout-sweep to re-drive (it selects only status='received', :37).
  //
  // Retiring the event here strands the sender, deterministically. The sequence:
  // the processor throws (the claim stands, by design), the event stays
  // 'received', pg-boss retries ~15s later, and that retry loses the claim to
  // ITS OWN dead claim — 15s is far inside CLAIM_STALE_AFTER_MS, so it reads as
  // `claim_taken`. Marking processed there would drop the row out of the sweep's
  // selection, and nothing else re-drives it: payout-poll only enqueues when
  // recordEvent reports `inserted`, so it fires at most once per (source,state),
  // not repeatedly. `refundPayoutFailure` would then never run again, the claim
  // would never age into `claim_abandoned`, and the alert below would never
  // fire — sender unpaid, zero open alerts, the pg-boss job green.
  //
  // The two are still not the same SIGNAL:
  //   claim_taken     — a live claim; another run is disbursing right now.
  //     Silent: healthy concurrency, and the sweep re-drive resolves it to
  //     `already_settled` (done → processed) once the winner finishes.
  //   claim_abandoned — a claim past CLAIM_STALE_AFTER_MS that never finished.
  //     Alerts, because the response differs in kind: the sender may ALREADY
  //     have been paid, so it cannot be auto-retried and needs a human to check
  //     the processor before `--reclaim`. Fingerprinted per transfer, so the
  //     sweep's repeated re-drives collapse into one issue; it keeps firing
  //     until a human resolves it, which is the point.
  if (!outcome.done && (outcome.reason === 'claim_taken' || outcome.reason === 'claim_abandoned')) {
    if (outcome.reason === 'claim_abandoned') {
      Sentry.withScope((scope) => {
        scope.setFingerprint(['payout-refund-claim-abandoned', transfer.id])
        scope.setContext('payout_refund_claim_abandoned', {
          transferId: transfer.id,
          claimedAt: outcome.claimedAt,
          claimedBy: outcome.claimedBy,
          runbook: 'docs/runbooks/manual-refund.md',
        })
        // 'error', matching payout-refund-refused below rather than the routine
        // payout-refund-gated warning: both mean a sender may still be owed and
        // a human must act. A page that reads as advisory defeats the branch.
        Sentry.captureMessage(
          'refund claim abandoned — a disbursement may have gone out; ops must confirm before reclaiming',
          'error',
        )
      })
    }
    return false
  }

  // A refusal means the sender was NOT refunded, and the caller marks the event
  // 'processed' either way — so nothing retries and nothing else would ever
  // notice. Every other contradictory-sequence branch in this file pages ops
  // (payout-success-after-terminal, payout-fail-after-terminal); the one that
  // holds the sender's money must not be the silent one.
  //
  // Reachable two ways: the row moved between failTransfer and the service's
  // re-read, OR failTransfer declined to move it at all — a returned/refunded
  // event on an already-COMPLETED transfer, which the fail-after-terminal
  // branch has already alerted on. Only page when the sender could actually
  // still be owed: at COMPLETED the money was delivered, and at the other
  // SETTLED_STATES it was already returned or never taken, so a "sender still
  // owed" page there is false and would train ops to ignore the real one.
  if (!outcome.done && !(outcome.reason === 'not_payout_failed' && SETTLED_STATES.has(outcome.state))) {
    Sentry.withScope((scope) => {
      scope.setFingerprint(['payout-refund-refused', transfer.id])
      scope.setContext('payout_refund_refused', {
        transferId: transfer.id,
        reason: outcome.reason,
        ...(outcome.reason === 'not_payout_failed' ? { observedState: outcome.state } : {}),
        bridgeState: event.event_type,
        runbook: 'docs/runbooks/manual-refund.md',
      })
      Sentry.captureMessage(
        'refund tail refused — transfer not refunded, sender still owed',
        'error',
      )
    })
  }
  // Everything reaching here is terminal for the event: either the tail settled
  // it, or it refused for a reason a re-drive cannot change (wrong state, no
  // such transfer) and ops has been paged where that could still owe a sender.
  return true
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

  // slice-7 PR6b, tail 2 of the cancellation story. AFTER the receipt: the
  // transfer DID deliver and the receipt is the record of that; routing to
  // UNDER_REVIEW first would make writeReceipt's COMPLETED guard skip it.
  await routeCancellationOnDelivery(transfer)
}

/**
 * The earliest moment we can EVIDENCE the deposit (shared query in
 * services/payment-events.ts — denyCancellation bounds the operator's cited
 * timestamp against the same evidence).
 *
 * The actual SPEI deposit happened AT OR BEFORE this — Bridge deposited, then
 * told us — so comparing the request against it errs in the SENDER'S favour: a
 * request earlier than our evidence might still postdate the true deposit, and
 * that ambiguous sliver stays on the owed path for a human holding Bridge's
 * authoritative timestamp to resolve. What it can never do is deny a request
 * the reg entitles. Falls back to now() (= "no evidence, treat the request as
 * first") if no event is found, which should be unreachable — reaching
 * COMPLETED requires processing exactly such an event.
 */
async function earliestDepositEvidence(transferId: string): Promise<string> {
  return (await earliestDepositEvidenceAt(transferId)) ?? new Date().toISOString()
}

/**
 * The sender asked to cancel, and the payout COMPLETED anyway.
 *
 * §1005.34 owes the refund only when BOTH conditions held at the moment the
 * request was received: (1) within 30 minutes of payment (`within_window`,
 * frozen at record time) AND (2) the funds not yet deposited. Condition (2) is
 * the one an instant rail makes decisive — SPEI deposits in seconds while the
 * window runs 30 minutes, so most in-window cancels arrive AFTER the deposit
 * and are owed nothing. Three buckets:
 *
 *   out of window          → owed nothing; alert; a human denies on the record.
 *   in window, request strictly AFTER our earliest deposit evidence
 *                          → owed nothing (the deposit had already happened when
 *                            they asked); alert; a human confirms the exact
 *                            deposit time in the Bridge dashboard and denies
 *                            with it as evidence. The transfer STAYS COMPLETED.
 *   in window, request AT OR BEFORE our earliest deposit evidence
 *                          → the true race: the ask may genuinely have beaten
 *                            the deposit. Owed posture: route to `UNDER_REVIEW`
 *                            for the correction payment — the accepted, bounded
 *                            double-pay, now confined to a seconds-wide sliver.
 *                            A tie is ambiguous by construction (Date.parse
 *                            truncates Postgres µs to ms, and evidence lags the
 *                            true deposit), and ambiguity breaks toward the
 *                            sender — review, never auto-deny (PR6b review fix:
 *                            was `>=`, which sent ties to the not-owed bucket).
 *
 * Denial is never automatic in any bucket, and no bucket flips a delivered
 * transfer's state for a request we will not honour.
 *
 * Never throws. `drive` has already posted the COMPLETED ledger batch and
 * written the receipt; a failure to route must not undo delivery or strand the
 * event. It pages instead — and because a claim refusal is the only thing that
 * leaves the event 'received', this is genuinely the last chance, which is why
 * the owed-path alert is an error rather than a warning.
 */
async function routeCancellationOnDelivery(transfer: TransferRow): Promise<void> {
  try {
    const request = await pendingCancellationFor(transfer.id)
    if (!request) return

    if (!request.within_window) {
      Sentry.withScope((scope) => {
        scope.setFingerprint(['cancellation-out-of-window', transfer.id])
        scope.setContext('cancellation_out_of_window', {
          transferId: transfer.id,
          requestedAt: request.requested_at,
          requestedState: request.requested_state,
          runbook: 'docs/runbooks/pending-cancellation.md',
        })
        Sentry.captureMessage(
          'cancellation request on a delivered transfer, OUT of the Reg E window — ' +
            'no automatic refund is owed; a human must deny it on the record',
          'warning',
        )
      })
      return
    }

    // Condition (2): was the deposit already done when they asked? Compare
    // against our EARLIEST evidence of it, so ambiguity breaks toward the
    // sender (see earliestDepositEvidence).
    const depositEvidenceAt = await earliestDepositEvidence(transfer.id)
    if (Date.parse(request.requested_at) > Date.parse(depositEvidenceAt)) {
      Sentry.withScope((scope) => {
        scope.setFingerprint(['cancellation-after-deposit', transfer.id])
        scope.setContext('cancellation_after_deposit', {
          transferId: transfer.id,
          requestedAt: request.requested_at,
          depositEvidenceAt,
          runbook: 'docs/runbooks/pending-cancellation.md',
        })
        Sentry.captureMessage(
          'cancellation request arrived after the deposit — no refund is owed; confirm the ' +
            'exact deposit time in the Bridge dashboard and deny with it as evidence',
          'warning',
        )
      })
      return
    }

    await transitionTransfer({
      transferId: transfer.id,
      fromState: 'COMPLETED',
      toState: 'UNDER_REVIEW',
      actor: 'system',
      reason: 'timely pre-deposit cancellation on a delivered transfer — correction payment owed',
      metadata: {
        cancellationRequestId: request.id,
        requestedAt: request.requested_at,
        depositEvidenceAt,
      },
      // NO ledger. Nothing has moved yet; the correction payment posts when the
      // operator executes it. UNDER_REVIEW is a holding state, not an event.
    })

    Sentry.withScope((scope) => {
      scope.setFingerprint(['cancellation-correction-owed', transfer.id])
      scope.setContext('cancellation_correction_owed', {
        transferId: transfer.id,
        requestedAt: request.requested_at,
        depositEvidenceAt,
        deadline: '3 business days from requestedAt',
        runbook: 'docs/runbooks/pending-cancellation.md',
      })
      Sentry.captureMessage(
        'timely PRE-DEPOSIT cancellation on a delivered transfer — full refund owed; ' +
          'run resolve-cancellation.ts within 3 business days',
        'error',
      )
    })
  } catch (err) {
    Sentry.withScope((scope) => {
      scope.setFingerprint(['cancellation-route-failed', transfer.id])
      scope.setContext('cancellation_route_failed', {
        transferId: transfer.id,
        // The page is the ONLY place this error surfaces (the catch is the
        // sanctioned swallow), so it must carry the reason — a PostgREST or
        // service message, ids and constraint names, no PII.
        error: err instanceof Error ? err.message : String(err),
        runbook: 'docs/runbooks/pending-cancellation.md',
      })
      Sentry.captureMessage(
        'failed to route a cancellation request on a delivered transfer — ' +
          'check for a pending request by hand',
        'error',
      )
    })
  }
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
