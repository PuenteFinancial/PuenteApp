import * as Sentry from '@sentry/node'
import { env } from '../config/env.js'
import { supabaseAdmin } from '../services/supabase.js'
import { transitionTransfer, TransferRpcError } from '../services/transfers.js'
import {
  checkPayability,
  computeDriftBps,
  isFloatCeilingTripped,
  minorToDecimal,
  parseDecimalToMinor,
  submittedLedgerEntries,
  PayoutValidationError,
} from '../services/payouts.js'
import { createBridgePayout, getExchangeRate, BridgeApiError } from '../services/bridge.js'
import { enqueuePaymentEventProcess } from '../services/queue.js'
import { assessTransferRisk, assessUnclearedCap, hasClearedHistory } from '../services/risk.js'
import { registerPendingDestinations } from '../services/destination-registration.js'

// The payout submission job (`payout.submit`) — the ONLY code path that asks
// Bridge to move money. Ordering is load → cheap gates → claim → Bridge POST →
// transition, and every step is a safe re-entry point: the claim is a guarded
// UPDATE (one winner), the Bridge POST is idempotent (transfers.idempotency_key
// + byte-identical body), and the transition RPC is a replay no-op. A crash at
// any point is healed by pg-boss retry or the 1-min payout.sweep.
//
// Hold semantics: a hold (payout_hold_reason) means "ops must look" — the row
// stays FUNDED and the sweep skips it until the runbook clears the hold
// (docs/runbooks/payout-holds.md). A tripped float ceiling deliberately sets
// NO hold: the sweep keeps retrying as the aggregate balance drains
// (self-healing backpressure, plan decision 4).

interface SubmitTransferRow {
  id: string
  user_id: string
  quote_id: string
  payout_destination_id: string
  state: string
  send_amount_minor: number
  margin_minor: number
  receive_amount_minor: number
  funding_cleared: boolean
  idempotency_key: string
  provider_transfer_ref: string | null
  payout_hold_reason: string | null
  submit_attempted_at: string | null
  // Nullable in the type even though prod writes acceptance strictly before
  // funding initiation: the dev fire-funding-webhook script can drive an
  // unconfirmed transfer to FUNDED, and the uncleared-cap ordering must not
  // crash on it (null → symmetric count, no olderThan).
  disclosure_accepted_at: string | null
}

// Bridge states the PR-3 event processor does nothing with — no point
// synthesizing a catch-up event for them after a fresh submission.
const NO_CATCHUP_STATES = new Set(['', 'awaiting_funds', 'funds_received'])

const holdFingerprint = (reason: string) => ['payout-hold', reason]

// Places a hold — but only on a FUNDED row that has none. Never overwrites an
// existing hold and never touches a row that has already moved on.
async function placeHold(
  transferId: string,
  reason: 'fx_drift' | 'payability' | 'submit_error' | 'velocity_review',
  context: Record<string, unknown>,
): Promise<void> {
  const { data, error } = await supabaseAdmin
    .from('transfers')
    .update({ payout_hold_reason: reason, payout_held_at: new Date().toISOString() })
    .eq('id', transferId)
    .eq('state', 'FUNDED')
    .is('payout_hold_reason', null)
    .select('id')
  if (error) throw new Error(`payout-submit hold update failed: ${error.message}`)
  // 0 rows = another actor held or moved the row first — their signal stands;
  // alerting here would double-report a hold that never landed.
  if ((data ?? []).length === 0) return
  Sentry.withScope((scope) => {
    scope.setFingerprint(holdFingerprint(reason))
    scope.setContext('payout_hold', { transferId, reason, ...context })
    Sentry.captureMessage(`payout hold placed: ${reason}`, 'warning')
  })
}

// The atomic claim (docs/transfer-state-machine.md): exactly one winner per
// transfer, serialized against the slice-6 cancel guard by row locking.
async function claimForSubmission(transferId: string): Promise<boolean> {
  const { data, error } = await supabaseAdmin
    .from('transfers')
    .update({ submit_attempted_at: new Date().toISOString() })
    .eq('id', transferId)
    .eq('state', 'FUNDED')
    .is('payout_hold_reason', null)
    .is('submit_attempted_at', null)
    .select('id')
  if (error) throw new Error(`payout-submit claim failed: ${error.message}`)
  return (data ?? []).length === 1
}

// Returns 1 when a Bridge submission was made this run, 0 otherwise.
export async function submitPayout(transferId: string): Promise<number> {
  const { data: transferData, error: transferError } = await supabaseAdmin
    .from('transfers')
    .select(
      'id, user_id, quote_id, payout_destination_id, state, send_amount_minor, margin_minor, receive_amount_minor, funding_cleared, idempotency_key, provider_transfer_ref, payout_hold_reason, submit_attempted_at, disclosure_accepted_at',
    )
    .eq('id', transferId)
    .maybeSingle()
  if (transferError) throw new Error(`payout-submit load failed: ${transferError.message}`)
  const transfer = transferData as SubmitTransferRow | null

  // Not FUNDED (or gone): nothing to submit — replays and races land here.
  if (!transfer || transfer.state !== 'FUNDED') return 0
  // Held: ops owns it until the runbook clears the hold.
  if (transfer.payout_hold_reason !== null) return 0

  // Crash recovery: a prior run claimed but died between claim and transition.
  // Guards are deliberately SKIPPED — a Bridge payout may already exist, and
  // the only safe move is the idempotent re-POST (same key, byte-identical
  // body → Bridge returns the existing transfer).
  const isRecovery = transfer.submit_attempted_at !== null

  let providerAccountRef: string
  let driftBps: number | undefined

  if (!isRecovery) {
    // funding_cleared gate — config-off pass-through (recorded, not gated on
    // until the risk engine flips WAIT_FOR_CLEARING).
    if (env.WAIT_FOR_CLEARING && !transfer.funding_cleared) return 0

    // First-transfer hold (slice-8 O3, ships OFF): an unproven sender — no
    // cleanly cleared send yet — waits for their OWN clearing before the MXN
    // leaves. Same silent-skip shape as WAIT_FOR_CLEARING (deliberate policy
    // mode, not an anomaly, so no Sentry): no hold reason, and the 1-min sweep
    // resumes the row when its funding_cleared lands. Flag first: OFF must cost
    // zero extra queries.
    if (
      env.FIRST_TRANSFER_HOLD &&
      !transfer.funding_cleared &&
      !(await hasClearedHistory(transfer.user_id))
    ) {
      return 0
    }

    let payability = await checkPayability(transfer.payout_destination_id)

    // Self-heal the deferred-registration window. A sender who added their
    // recipient before verifying (the normal path under KYC-at-first-send)
    // has destinations whose Bridge account is registered when their customer
    // is created — but that backfill is best-effort, and a Bridge hiccup there
    // would otherwise strand this payout on a hold no retry could clear.
    // Registering here closes that gap: it is the same call the backfill makes,
    // and it runs ONLY for the one reason it can fix, never as a blanket retry.
    if (!payability.payable && payability.reason === 'provider_account_ref_missing') {
      // Swallowed on purpose: a sender with no Bridge customer yet, or a
      // Bridge outage, must fall through to the ordinary payability hold —
      // never throw, or pg-boss would retry a money job over a condition
      // retrying cannot fix.
      try {
        const customerId = await loadBridgeCustomerId(transfer.user_id)
        await registerPendingDestinations(transfer.user_id, customerId)
        payability = await checkPayability(transfer.payout_destination_id)
      } catch {
        // Fall through to the hold below, which already carries the Sentry
        // signal. No event of its own: a sender with no Bridge customer yet
        // is the ORDINARY pre-verification state, not an anomaly, and paging
        // on it would bury the holds that do need a human.
      }
    }

    if (!payability.payable) {
      await placeHold(transfer.id, 'payability', { reason: payability.reason })
      return 0
    }
    providerAccountRef = payability.providerAccountRef

    // Float ceiling: NO hold on purpose — sweep retries as the balance drains.
    const float = await isFloatCeilingTripped()
    if (float.tripped) {
      Sentry.withScope((scope) => {
        scope.setFingerprint(['float-ceiling'])
        scope.setContext('float_ceiling', {
          balanceMinor: float.balanceMinor,
          ceilingMinor: float.ceilingMinor,
        })
        Sentry.captureMessage('float ceiling tripped — payout submission paused', 'warning')
      })
      return 0
    }

    // Uncleared-cap backstop (slice-8 O3): the authoritative catch for the
    // same-instant commit race that slipped the confirm-time gate. Self-heal,
    // NOT a hold — unlike the velocity count below, the blocker drains on its
    // own (its funding clears within ~T+4 or it unwinds), so the sweep retries
    // until the slot frees; a hold would demand ops action for a wait that
    // resolves itself. olderThan makes the race deterministic: the older
    // committed send submits, the newer waits for it — a symmetric count would
    // block both forever. The Sentry warning (fingerprint per transfer, so each
    // waiting row is one issue) surfaces the wait in case the blocker never
    // clears — then it's the payout-holds runbook's no-hold-reason case.
    const unclearedCap = await assessUnclearedCap({
      userId: transfer.user_id,
      excludeTransferId: transfer.id,
      olderThan: transfer.disclosure_accepted_at
        ? { acceptedAt: transfer.disclosure_accepted_at, transferId: transfer.id }
        : null,
    })
    if (!unclearedCap.ok) {
      Sentry.withScope((scope) => {
        scope.setFingerprint(['uncleared-cap-wait', transfer.id])
        scope.setContext('uncleared_cap', {
          transferId: transfer.id,
          blockerTransferId: unclearedCap.blockerTransferId,
        })
        Sentry.captureMessage('uncleared cap reached — payout submission waiting', 'warning')
      })
      return 0
    }

    // Per-user velocity backstop (slice-7 PR5): the authoritative catch for the
    // rare same-instant commit race that slipped the confirm-time gate. This is
    // the last gate before the irreversible MXN payout, so holding here prevents
    // delivery even though the ACH pull already happened. excludeTransferId omits
    // this transfer (already committed + funded) so it never counts itself.
    // A trip places a HOLD, not a self-heal: unlike the aggregate float ceiling
    // (which drains as ACH settles), a per-user velocity count does NOT drain on
    // its own — a completed send keeps counting for the whole window — so a
    // self-heal would strand a funded transfer for up to a full window with no ops
    // signal. The hold surfaces it for release-or-refund (payout-holds runbook).
    const risk = await assessTransferRisk({
      userId: transfer.user_id,
      sendAmountMinor: transfer.send_amount_minor,
      excludeTransferId: transfer.id,
    })
    if (!risk.ok) {
      await placeHold(transfer.id, 'velocity_review', { velocityReason: risk.reason })
      return 0
    }

    // FX submission backstop (plan decision 7). A rate-fetch failure throws —
    // never submit on unknown drift; pg-boss retries.
    const { data: quoteData, error: quoteError } = await supabaseAdmin
      .from('quotes')
      .select('source_rate, created_at')
      .eq('id', transfer.quote_id)
      .maybeSingle()
    if (quoteError || !quoteData) {
      throw new Error(`payout-submit quote load failed: ${quoteError?.message ?? 'not found'}`)
    }
    const quote = quoteData as { source_rate: number; created_at: string }
    const live = await getExchangeRate('usd', 'mxn')
    // numeric(18,8) arrives as a JSON number; String() is exact here (rates
    // are ~2 digits + ≤8dp, far inside double precision, never exponent form)
    // and computeDriftBps re-validates the grammar.
    driftBps = computeDriftBps(live.buyRate, String(quote.source_rate))
    const quoteAgeMinutes = (Date.now() - new Date(quote.created_at).getTime()) / 60_000
    if (driftBps > env.FX_MAX_DRIFT_BPS || quoteAgeMinutes > env.FX_MAX_QUOTE_AGE_MINUTES) {
      await placeHold(transfer.id, 'fx_drift', {
        driftBps,
        quoteAgeMinutes: Math.round(quoteAgeMinutes),
      })
      return 0
    }

    if (!(await claimForSubmission(transfer.id))) return 0 // raced: someone else won
  } else {
    // Recovery re-POST must reuse the original destination ref to keep the
    // body byte-identical. Raw read — payability was gated pre-claim.
    const { data: destData, error: destError } = await supabaseAdmin
      .from('payout_destinations')
      .select('provider_account_ref')
      .eq('id', transfer.payout_destination_id)
      .maybeSingle()
    if (destError) throw new Error(`payout-submit destination load failed: ${destError.message}`)
    const ref = (destData as { provider_account_ref: string | null } | null)?.provider_account_ref
    if (!ref) {
      await placeHold(transfer.id, 'submit_error', { cause: 'recovery_missing_account_ref' })
      return 0
    }
    providerAccountRef = ref
  }

  if (!env.BRIDGE_TREASURY_WALLET_ID) {
    throw new Error('payout-submit: BRIDGE_TREASURY_WALLET_ID is not set')
  }

  let result
  try {
    result = await createBridgePayout({
      idempotencyKey: transfer.idempotency_key,
      clientReferenceId: transfer.id,
      onBehalfOf: await loadBridgeCustomerId(transfer.user_id),
      sourceWalletId: env.BRIDGE_TREASURY_WALLET_ID,
      destinationExternalAccountId: providerAccountRef,
      destinationAmountMxn: minorToDecimal(transfer.receive_amount_minor),
    })
  } catch (err) {
    if (err instanceof BridgeApiError && err.statusCode >= 400 && err.statusCode < 500) {
      if (err.statusCode === 400) {
        // Sandbox-verified: sync 400 = wallet drained or concurrent-payout
        // serialization — NO Bridge transfer was created, so retry is safe.
        //
        // Safe, but not safe FOREVER. The self-heal premise is that the blocker
        // drains on its own; a treasury simply too small for the payout never
        // refills, so the 1-min sweep re-enters the recovery path indefinitely
        // and every pass captures an exception with no hold for ops to act on.
        // Staging 2026-08-25: one $100 test send against a 47 USDC sandbox
        // wallet looped 23.5h — 1,378 Sentry events, ended only by a manual
        // unwind. Past the ceiling, treat it like every other 4xx: hold, and
        // let the runbook own it.
        //
        // Measured from submit_attempted_at (the FIRST claim, never cleared),
        // so this bounds the whole episode, not one attempt. It is null on the
        // first pass — claimForSubmission stamps the row after this snapshot
        // was read — so a first-attempt 400 always retries.
        const attemptingSince = transfer.submit_attempted_at
          ? Date.parse(transfer.submit_attempted_at)
          : null
        const attemptingForMs = attemptingSince === null ? 0 : Date.now() - attemptingSince
        if (attemptingForMs < env.SUBMIT_RETRY_CEILING_MINUTES * 60_000) throw err
        await placeHold(transfer.id, 'submit_error', {
          statusCode: 400,
          cause: 'retry_ceiling_exhausted',
          attemptingForMinutes: Math.round(attemptingForMs / 60_000),
        })
        return 0
      }
      // 422 (idempotency mismatch) or other 4xx: an engineering incident, not
      // a transient — hold for the runbook.
      await placeHold(transfer.id, 'submit_error', { statusCode: err.statusCode })
      return 0
    }
    throw err // 5xx / network: pg-boss retries
  }

  // Strict 2-dp parse of the actual USDC draw. More precision than 2dp (or a
  // missing amount) means our model of Bridge is wrong — hold + loud alert
  // rather than guessing at a ledger amount.
  let actualSourceAmountMinor: number
  try {
    actualSourceAmountMinor = parseDecimalToMinor(result.sourceAmount)
  } catch (err) {
    if (err instanceof PayoutValidationError) {
      Sentry.withScope((scope) => {
        scope.setFingerprint(['bridge-source-amount-precision'])
        scope.setContext('bridge_amount', {
          transferId: transfer.id,
          bridgeTransferId: result.bridgeTransferId,
          sourceAmount: result.sourceAmount,
        })
        Sentry.captureMessage('bridge source.amount failed strict 2-dp parse', 'error')
      })
      await placeHold(transfer.id, 'submit_error', { cause: 'source_amount_parse' })
      return 0
    }
    throw err
  }

  try {
    await transitionTransfer({
      transferId: transfer.id,
      fromState: 'FUNDED',
      toState: 'SUBMITTED',
      actor: 'worker:payout',
      reason: 'submitted to bridge',
      metadata: {
        bridgeTransferId: result.bridgeTransferId,
        sourceAmountMinor: actualSourceAmountMinor,
        ...(driftBps !== undefined ? { driftBps } : {}),
      },
      ledgerDescription: 'transfer SUBMITTED — payout sent to Bridge',
      // S = the quoted principal (send − margin, #193): what the recipient is
      // owed and what due_from_bridge tracks. On merged-rate rows the margin
      // stays behind in fee_revenue; on pre-merge rows margin is 0 and this is
      // send_amount_minor exactly as before.
      ledgerEntries: submittedLedgerEntries({
        sendAmountMinor: transfer.send_amount_minor - transfer.margin_minor,
        actualSourceAmountMinor,
      }),
      providerTransferRef: result.bridgeTransferId,
    })
  } catch (err) {
    if (err instanceof TransferRpcError && err.code === 'transition_conflict') {
      // Row moved concurrently (e.g. an event beat us past SUBMITTED) — the
      // poller reconciles; warn, don't fail the job into a retry loop.
      Sentry.withScope((scope) => {
        scope.setFingerprint(['payout-submit-transition-conflict'])
        Sentry.captureMessage('payout submit transition_conflict', 'warning')
      })
      return 1
    }
    throw err
  }

  // The create response can already show an advanced Bridge state — synthesize
  // the poll-shaped event now instead of waiting a poll cycle. The processor
  // job lands in PR 3; until then the queued job simply waits (dedupe via the
  // payment_events unique key + stately singleton makes this safe to repeat).
  if (!NO_CATCHUP_STATES.has(result.state)) {
    try {
      const { data: eventRow } = await supabaseAdmin
        .from('payment_events')
        .upsert(
          {
            source: 'bridge_poll',
            external_event_id: `${result.bridgeTransferId}:${result.state}`,
            event_type: result.state,
            transfer_id: transfer.id,
            provider_ref: result.bridgeTransferId,
            payload: { state: result.state, synthesized_from: 'payout.submit' },
          },
          { onConflict: 'source,external_event_id', ignoreDuplicates: true },
        )
        .select('id')
        .maybeSingle()
      if (eventRow) await enqueuePaymentEventProcess((eventRow as { id: string }).id, 'worker')
    } catch {
      // Best-effort: the payout.poll cron (PR 3) synthesizes the same event.
    }
  }

  return 1
}

async function loadBridgeCustomerId(userId: string): Promise<string> {
  const { data, error } = await supabaseAdmin
    .from('users')
    .select('bridge_customer_id')
    .eq('id', userId)
    .maybeSingle()
  if (error) throw new Error(`payout-submit user load failed: ${error.message}`)
  const customerId = (data as { bridge_customer_id: string | null } | null)?.bridge_customer_id
  if (!customerId) throw new Error('payout-submit: user has no bridge_customer_id')
  return customerId
}
