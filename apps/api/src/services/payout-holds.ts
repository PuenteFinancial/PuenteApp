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
  // The loss path (2026-09-10). `funding_disputed` releases when a human wins
  // or writes off the dispute — that judgement is exactly what an operator is
  // for. `sender_suspended` is derived from users.status rather than from this
  // transfer, so releasing it WITHOUT unfreezing the sender simply re-holds the
  // row on the next sweep: safe and self-correcting, but the runbook's order is
  // unfreeze first, then release.
  'funding_disputed',
  'sender_suspended',
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

/**
 * Auto-release the `payability` holds that a LATE Bridge registration just
 * unblocked, and only those.
 *
 * Bridge gates an MXN external account on the customer's SPEI endorsement, and
 * `active` at customer level does NOT imply it (sandbox, 2026-09-10). So the
 * registration pass that runs on approval can 403, leaving
 * `provider_account_ref` null, and payout-submit parks the transfer on
 * `payability`. When the endorsement lands Bridge sends another
 * `customer.updated`, the pass runs again and succeeds — but the transfer used
 * to stay held until an operator noticed. That was money waiting on a human
 * for a condition the system had already fixed.
 *
 * NARROW BY CONSTRUCTION. `payability` covers four distinct causes
 * (destination_not_found, destination_not_active, recipient_not_active,
 * provider_account_ref_missing) and only the last one is what a registration
 * fixes. Releasing a user's payability holds wholesale would push genuinely
 * unpayable transfers at Bridge, so the release is keyed on
 * `payout_destination_id IN (the destinations this pass registered)` — passed
 * in by the caller, never inferred here.
 *
 * NO PAYABILITY RE-CHECK before releasing, deliberately. payout-submit calls
 * `checkPayability` itself on every run and holds again if anything is still
 * wrong, so a check here would be a second read of the same row that can go
 * stale before the submit anyway. Its only effect would be to convert a
 * self-correcting extra hold cycle (one minute, no money moved) into a read
 * that can fail and block a release that was safe. The cheaper, more robust
 * order is: release, and let the gate that actually guards the money decide.
 *
 * Same compare-and-swap as the operator release and `releaseSenderKycHolds`:
 * `payout_hold_reason = 'payability'` is in the WHERE clause, so a row re-held
 * for another reason in the meantime is left alone.
 */
export async function releaseDestinationPayabilityHolds(
  input: {
    userId: string
    /** `registeredIds` from `registerPendingDestinations`. */
    destinationIds: string[]
    /** The pass that healed the ref: `webhook:bridge` today. */
    actor: string
    /** Fastify request id on a route, null in a worker. */
    requestId: string | null
  },
  log: Logger,
): Promise<string[]> {
  if (input.destinationIds.length === 0) return []

  // `user_id` is redundant with the destination scope (the registration pass
  // only ever selects this user's destinations) and kept as defence in depth:
  // a caller that passed a foreign id could not release a stranger's hold.
  const { data, error } = await supabaseAdmin
    .from('transfers')
    .update({ payout_hold_reason: null, payout_held_at: null })
    .eq('user_id', input.userId)
    .eq('state', 'FUNDED')
    .eq('payout_hold_reason', 'payability')
    .in('payout_destination_id', input.destinationIds)
    .select('id')

  if (error) {
    // Degrades to the status quo — the hold is operator-releasable and
    // reconciliation flags it overdue at 24h — but a failed write on a money
    // path still pages, same as the KYC release.
    log.error(
      { userId: input.userId, supabaseError: error.code },
      'payability release after destination registration failed',
    )
    Sentry.withScope((scope) => {
      scope.setFingerprint(['payability-registration-release-failed', input.userId])
      scope.setContext('release', {
        userId: input.userId,
        destinations: input.destinationIds.length,
        supabaseError: error.code,
      })
      Sentry.captureMessage('payability release after destination registration failed', 'error')
    })
    return []
  }

  const released = ((data ?? []) as Array<{ id: string }>).map((row) => row.id)
  for (const transferId of released) {
    log.info(
      { audit: true, userId: input.userId, transferId, actor: input.actor },
      'payability hold auto-released after destination registration',
    )
    // The board must show that the SYSTEM released this, not a person.
    // `releaseSenderKycHolds` predates ops_actions and writes no row; that is
    // a gap in the older path, not a precedent to copy. Fixed keys only (the
    // PII guard); the Bridge account id itself stays out of the jsonb.
    await recordOpsAction(
      {
        actor: input.actor,
        action: 'hold_release',
        transferId,
        reason: 'payability',
        note: null,
        before: { payoutHoldReason: 'payability', providerAccountRef: 'missing' },
        after: { payoutHoldReason: null, providerAccountRef: 'registered' },
        requestId: input.requestId,
      },
      log,
    )
    // Latency only: the 1-min sweep resubmits an unheld, unclaimed FUNDED row
    // on its own, so a failed enqueue is never fatal.
    try {
      await enqueuePayoutSubmit(transferId, 'api')
    } catch {
      log.warn({ userId: input.userId, transferId }, 'payout enqueue after release failed — sweep will heal')
    }
  }
  return released
}

/**
 * Release the `sender_suspended` holds an UNFREEZE just made obsolete, and only
 * those.
 *
 * Called by unfreezeSender (services/sender-freeze.ts) AFTER users.status is
 * back to 'active', never before: payout-submit reads the sender's status on
 * every run, so releasing first simply re-holds the row on the next sweep.
 * That ordering is safety, not tidiness — but note it is safe in both
 * directions, which is why `sender_suspended` is also in
 * RELEASABLE_HOLD_REASONS for a manual board release.
 *
 * NOT an auto-release in the `releaseSenderKycHolds` sense. That one fires on a
 * Bridge event with no human in the loop; this one is the tail of a decision a
 * person made and signed with a note. The distinction matters for
 * reconciliation, which classifies holds by whether anyone owes an action.
 *
 * Same compare-and-swap as every other release: `payout_hold_reason =
 * 'sender_suspended'` is in the WHERE clause, so a row re-held meanwhile for a
 * different reason (a dispute of its own, say) is left alone.
 */
export async function releaseSenderSuspendedHolds(
  input: {
    userId: string
    /** `ops:<operator uuid>` — an unfreeze is always someone's decision. */
    actor: string
    /** Fastify request id on a route, null in a CLI. */
    requestId: string | null
  },
  log: Logger,
): Promise<string[]> {
  const { data, error } = await supabaseAdmin
    .from('transfers')
    .update({ payout_hold_reason: null, payout_held_at: null })
    .eq('user_id', input.userId)
    .eq('state', 'FUNDED')
    .eq('payout_hold_reason', 'sender_suspended')
    .select('id')

  if (error) {
    // Degrades to the status quo — the sender is unfrozen and each hold stays
    // operator-releasable from the board — but a failed write on a money path
    // pages, same as the other releases. Never thrown: the unfreeze itself has
    // already committed and must not be reported as a failure.
    log.error(
      { userId: input.userId, supabaseError: error.code },
      'sender_suspended release after unfreeze failed',
    )
    Sentry.withScope((scope) => {
      scope.setFingerprint(['sender-suspended-release-failed', input.userId])
      scope.setContext('release', { userId: input.userId, supabaseError: error.code })
      Sentry.captureMessage('sender_suspended release after unfreeze failed', 'error')
    })
    return []
  }

  const released = ((data ?? []) as Array<{ id: string }>).map((row) => row.id)
  for (const transferId of released) {
    log.info(
      { audit: true, userId: input.userId, transferId, actor: input.actor },
      'sender_suspended hold released after unfreeze',
    )
    // One row per transfer, because that is how the board reads a hold's
    // history. Fixed keys only (the PII guard).
    await recordOpsAction(
      {
        actor: input.actor,
        action: 'hold_release',
        transferId,
        reason: 'sender_suspended',
        note: null,
        before: { payoutHoldReason: 'sender_suspended', senderStatus: 'suspended' },
        after: { payoutHoldReason: null, senderStatus: 'active' },
        requestId: input.requestId,
      },
      log,
    )
    // Latency only: the 1-min sweep resubmits an unheld, unclaimed FUNDED row
    // on its own, so a failed enqueue is never fatal.
    try {
      await enqueuePayoutSubmit(transferId, 'api')
    } catch {
      log.warn({ userId: input.userId, transferId }, 'payout enqueue after release failed — sweep will heal')
    }
  }
  return released
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

/**
 * Stop a payout because the money that funded it is being clawed back.
 *
 * The pre-delivery arm of the loss path: the pesos have NOT left, so the right
 * answer is to refuse to send them, and to book NOTHING — there is no loss yet
 * (docs/ledger-rules.md gives the loss batch to the post-delivery case only).
 *
 * Guarded exactly like payout-submit's own hold: FUNDED and not already held,
 * so a row that moved on, or that another actor held first, is left alone.
 * Returns whether this call is the one that placed it, so the caller can page
 * once rather than on every redelivery.
 */
export async function holdPayoutForDispute(transferId: string): Promise<boolean> {
  const { data, error } = await supabaseAdmin
    .from('transfers')
    .update({ payout_hold_reason: 'funding_disputed', payout_held_at: new Date().toISOString() })
    .eq('id', transferId)
    .eq('state', 'FUNDED')
    // Unheld, OR already held as `sender_suspended` — which is an UPGRADE, not
    // the overwrite the no-clobber rule forbids.
    //
    // Observed on the staging drive 2026-09-10: the loss path freezes the
    // sender before it holds this transfer, and the 1-minute payout sweep can
    // land in between. It then sees a suspended sender and holds the row as
    // `sender_suspended` — correct, but the LESS specific of two reasons the
    // same dispute caused, and it made reconciliation's `stripe_disputes`
    // check report the dispute as unrecorded on every run.
    //
    // The reason a transfer carries should name what happened to THAT
    // transfer; the sender's other payouts are the ones `sender_suspended`
    // describes. Any other hold reason still wins and is left alone.
    .or('payout_hold_reason.is.null,payout_hold_reason.eq.sender_suspended')
    .select('id')
  // Throws rather than returning false: a dispute hold that silently failed to
  // land would let the sweep pay out money we are being forced to give back.
  // The caller is a webhook, so throwing means a 500 and a provider redelivery.
  if (error) throw new Error(`dispute hold update failed: ${error.message}`)
  return ((data ?? []) as Array<{ id: string }>).length === 1
}
