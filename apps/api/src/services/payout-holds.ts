import * as Sentry from '@sentry/node'
import { supabaseAdmin } from './supabase.js'
import { enqueuePayoutSubmit } from './queue.js'
import { recordOpsAction } from './ops-actions.js'

// Payout holds, released.
//
// K6 decision 8: the 'sender_kyc_pending' hold is the system's first
// AUTO-RELEASED hold. payout-submit parks a FUNDED row on it when the
// sender's Bridge customer is not yet approved; the Bridge approval webhook
// calls releaseSenderKycHolds to clear every such hold for the sender and
// re-enqueue the submit. The 1-min payout.sweep would resubmit anyway (it
// selects FUNDED + unheld + unclaimed), so the enqueue is latency only — its
// failure is logged, never fatal.
//
// Ops board slice 1 / O-B: releaseHold is the OPERATOR release — the runbook's
// SQL (docs/runbooks/payout-holds.md "Release procedure") as a service, with
// the runbook's compare-and-swap guard verbatim (`payout_hold_reason =
// '<reason>'`, so a row that meanwhile re-held for a different reason is left
// alone) and a durable ops_actions row that the SQL editor never wrote.

interface Logger {
  info(obj: Record<string, unknown>, msg: string): void
  warn(obj: Record<string, unknown>, msg: string): void
  error(obj: Record<string, unknown>, msg: string): void
}

// The reasons an operator may release from the board (decision 2026-09-08:
// all four human-actioned reasons). sender_kyc_pending is NOT here — it
// auto-releases on Bridge's approval webhook, and releasing while the customer
// is unverified only re-holds the row as submit_error. The enum is the policy:
// the route schema rejects anything else with a 400.
export const RELEASABLE_HOLD_REASONS = [
  'fx_drift',
  'payability',
  'velocity_review',
  'submit_error',
] as const
export type ReleasableHoldReason = (typeof RELEASABLE_HOLD_REASONS)[number]

export type ReleaseHoldOutcome =
  | { done: true; outcome: 'released'; enqueued: boolean }
  | { done: false; reason: 'transfer_not_found' }
  | { done: false; reason: 'not_funded'; state: string }
  | { done: false; reason: 'not_held' }
  // The row IS held, but not for the reason the operator saw — covers a
  // re-hold under another reason and sender_kyc_pending alike.
  | { done: false; reason: 'hold_reason_mismatch'; actual: string }

interface HoldRow {
  id: string
  state: string
  payout_hold_reason: string | null
  payout_held_at: string | null
}

const HOLD_COLUMNS = 'id, state, payout_hold_reason, payout_held_at'

async function readHoldRow(transferId: string): Promise<HoldRow | null> {
  const { data, error } = await supabaseAdmin
    .from('transfers')
    .select(HOLD_COLUMNS)
    .eq('id', transferId)
    .maybeSingle()
  if (error) throw new Error(`hold release transfer load failed: ${error.message}`)
  return (data as HoldRow | null) ?? null
}

function classify(row: HoldRow | null, reason: ReleasableHoldReason): ReleaseHoldOutcome | null {
  if (row == null) return { done: false, reason: 'transfer_not_found' }
  if (row.state !== 'FUNDED') return { done: false, reason: 'not_funded', state: row.state }
  if (row.payout_hold_reason == null) return { done: false, reason: 'not_held' }
  if (row.payout_hold_reason !== reason) {
    return { done: false, reason: 'hold_reason_mismatch', actual: row.payout_hold_reason }
  }
  return null
}

/**
 * Release one operator-actionable hold. The runbook's compare-and-swap: the
 * UPDATE applies only while the row is FUNDED and held for EXACTLY the reason
 * the operator confirmed, so a hold that changed underneath them is refused,
 * not released. Refusals are outcomes, not throws — the route maps them to
 * 409s; a broken read throws (fail closed).
 */
export async function releaseHold(
  input: {
    transferId: string
    reason: ReleasableHoldReason
    /** `ops:<admin user id>` */
    actor: string
    note: string
    requestId: string | null
  },
  log: Logger,
): Promise<ReleaseHoldOutcome> {
  // Pre-read: an honest refusal for the common cases, and the `before` the
  // operator saw for the provenance row. The UPDATE below is still the guard.
  const before = await readHoldRow(input.transferId)
  const early = classify(before, input.reason)
  if (early != null) return early

  const { data, error } = await supabaseAdmin
    .from('transfers')
    .update({ payout_hold_reason: null, payout_held_at: null })
    .eq('id', input.transferId)
    .eq('state', 'FUNDED')
    .eq('payout_hold_reason', input.reason)
    .select('id')
  if (error) throw new Error(`hold release update failed: ${error.message}`)

  if ((data ?? []).length === 0) {
    // Lost the race between the pre-read and the UPDATE: ONE re-read tells us
    // which refusal is true now (refunds.ts precedent). A row that still
    // matches is unreachable — the CAS would have applied — so it reads as
    // not_held rather than pretending a release happened.
    const fresh = await readHoldRow(input.transferId)
    return classify(fresh, input.reason) ?? { done: false, reason: 'not_held' }
  }

  // The provenance row — best-effort, never blocks the release it records.
  await recordOpsAction(
    {
      actor: input.actor,
      action: 'hold_release',
      transferId: input.transferId,
      reason: input.reason,
      note: input.note,
      before: { payoutHoldReason: input.reason, payoutHeldAt: before?.payout_held_at ?? null },
      after: { payoutHoldReason: null, payoutHeldAt: null },
      requestId: input.requestId,
    },
    log,
  )
  log.info(
    { audit: true, transferId: input.transferId, reason: input.reason, actor: input.actor },
    'payout hold released by ops',
  )

  // Latency only: the 1-min sweep resubmits an unheld, unclaimed FUNDED row on
  // its own (payout-sweep.ts). A crash-recovery row (submit_attempted_at set)
  // waits out the sweep's stale-claim window instead — also by design.
  let enqueued = true
  try {
    await enqueuePayoutSubmit(input.transferId, 'api')
  } catch {
    enqueued = false
    log.warn({ transferId: input.transferId }, 'payout enqueue after release failed — sweep will heal')
  }
  return { done: true, outcome: 'released', enqueued }
}

export async function releaseSenderKycHolds(userId: string, log: Logger): Promise<string[]> {
  const { data, error } = await supabaseAdmin
    .from('transfers')
    .update({ payout_hold_reason: null, payout_held_at: null })
    .eq('user_id', userId)
    .eq('state', 'FUNDED')
    .eq('payout_hold_reason', 'sender_kyc_pending')
    .select('id')

  if (error) {
    // The hold stays until the next approval event or a manual release; that
    // is money waiting on nobody, so page it rather than only log it.
    log.error({ userId, supabaseError: error.code }, 'sender_kyc_pending release failed')
    Sentry.withScope((scope) => {
      scope.setFingerprint(['sender-kyc-release-failed', userId])
      scope.setContext('release', { userId, supabaseError: error.code })
      Sentry.captureMessage('sender_kyc_pending release failed', 'error')
    })
    return []
  }

  const released = ((data ?? []) as Array<{ id: string }>).map((row) => row.id)
  for (const transferId of released) {
    log.info({ audit: true, userId, transferId }, 'sender_kyc_pending hold auto-released')
    try {
      await enqueuePayoutSubmit(transferId, 'api')
    } catch {
      log.warn({ userId, transferId }, 'payout enqueue after release failed — sweep will heal')
    }
  }
  return released
}
