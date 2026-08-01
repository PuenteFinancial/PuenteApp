import * as Sentry from '@sentry/node'
import { env } from '../config/env.js'
import { supabaseAdmin } from '../services/supabase.js'
import { assessUnclearedCap, hasClearedHistory } from '../services/risk.js'

// The stuck-transfer watch cron (`transfers.stuck-watch`, slice-8 O1,
// docs/runbooks/stuck-transfer.md): the real-time pager for transfers that
// stop moving. Every 5 minutes it sweeps the non-terminal states and pages ONE
// Sentry issue per (transfer, state, entry) episode when dwell exceeds the
// env-tuned threshold. Detection only — repairs are human, per the runbook.
//
// Division of labor (overlap documented, deliberately not deduped): this cron
// answers "is OUR pipeline stuck"; payout-poll's `payout-in-review-stale`
// answers "is BRIDGE holding it"; O2's daily `transfer_aging` is the coarse
// audit backstop. The same underlying condition can page under more than one
// fingerprint — each is a different question.
//
// PENDING_PAYMENT is deliberately absent: the 30-min auto-fail
// (transfer.reconcile-pending) owns that state, and O2's daily
// `pending-payment-autofail-dead` bucket watches THAT cron's liveness.

const WATCHED_STATES = ['FUNDED', 'SUBMITTED', 'IN_FLIGHT', 'UNDER_REVIEW'] as const
type WatchedState = (typeof WATCHED_STATES)[number]

// PostgREST caps every response at max_rows (1000) regardless of the requested
// limit, so a response AT the cap may be silently truncated — fail loud (the
// O2 review finding; an exactly-1000-row sweep tripping falsely is the right
// failure direction).
const ROW_BOUND = 1000

interface WatchRow {
  id: string
  user_id: string
  state: WatchedState
  funding_cleared: boolean
  payout_hold_reason: string | null
  disclosure_accepted_at: string | null
  payment_at: string | null
  submit_attempted_at: string | null
  cancellation_requested_at: string | null
  created_at: string
}

interface TransitionRow {
  created_at: string
  actor: string | null
  reason: string | null
}

function thresholdMs(state: WatchedState): number {
  switch (state) {
    case 'FUNDED':
      return env.STUCK_FUNDED_AFTER_MINUTES * 60_000
    case 'SUBMITTED':
      return env.STUCK_SUBMITTED_AFTER_MINUTES * 60_000
    case 'IN_FLIGHT':
      return env.STUCK_IN_FLIGHT_AFTER_MINUTES * 60_000
    case 'UNDER_REVIEW':
      return env.STUCK_UNDER_REVIEW_AFTER_HOURS * 60 * 60_000
  }
}

// Cheap pre-filter anchor from the write-once lifecycle stamps — must always
// be at or BEFORE the true entry into row.state, so it can only OVER-select
// candidates (the exact transitions read below then decides). That means only
// stamps that provably precede entry into that state may fold in (review
// finding — the naive latest-of-all-stamps version UNDER-selected):
//  * submit_attempted_at is written while the row is still FUNDED (the
//    payout-submit claim), so it is AFTER a FUNDED row's own entry
//  * cancellation_requested_at is written with NO state change on
//    FUNDED/SUBMITTED/IN_FLIGHT (the 202 submission-in-progress path) — a
//    cancel tap on a stuck transfer must not restart its dwell clock; only
//    UNDER_REVIEW is entered after it
// updated_at is deliberately not used at all: it moves on any lifecycle write
// and would hide a stuck row exactly when something touches it.
export function coarseAnchor(row: WatchRow): string {
  const stamps: Array<string | null> = [row.payment_at]
  if (row.state !== 'FUNDED') stamps.push(row.submit_attempted_at)
  if (row.state === 'UNDER_REVIEW') stamps.push(row.cancellation_requested_at)
  let latest = row.created_at
  for (const stamp of stamps) {
    if (stamp != null && stamp > latest) latest = stamp
  }
  return latest
}

export async function watchStuckTransfers(): Promise<number> {
  const nowMs = Date.now()

  const { data, error } = await supabaseAdmin
    .from('transfers')
    .select(
      'id, user_id, state, funding_cleared, payout_hold_reason, disclosure_accepted_at, payment_at, submit_attempted_at, cancellation_requested_at, created_at',
    )
    .in('state', [...WATCHED_STATES])
    .limit(ROW_BOUND)
  // Fail CLOSED: a broken read must never present as "nothing is stuck".
  if (error || data == null) {
    throw new Error(`stuck-watch select failed: ${error?.message ?? 'no rows returned'}`)
  }
  const rows = data as WatchRow[]
  if (rows.length >= ROW_BOUND) {
    throw new Error(
      `stuck-watch: read hit the ${ROW_BOUND}-row PostgREST cap — results may be silently truncated; move this check into SQL`,
    )
  }

  let paged = 0
  const failures: string[] = []

  for (const row of rows) {
    try {
      const threshold = thresholdMs(row.state)
      if (nowMs - new Date(coarseAnchor(row)).getTime() <= threshold) continue

      if (row.state === 'FUNDED' && (await isDeliberateFundedWait(row))) continue

      // Exact state-entry time + last-transition context, from the append-only
      // log. The coarse stamp can predate the CURRENT stay in this state (e.g.
      // UNDER_REVIEW→COMPLETED→UNDER_REVIEW round trips), so the threshold is
      // re-checked against the real entry before paging.
      const entered = await latestTransitionInto(row.id, row.state)
      const enteredAt = entered?.created_at ?? coarseAnchor(row)
      const ageMs = nowMs - new Date(enteredAt).getTime()
      if (ageMs <= threshold) continue

      // TOCTOU guard (codex P2 + review): the bulk read is a snapshot — a
      // payment event can advance the transfer, or payout-submit can place a
      // hold, between it and this decision; paging a healthy or ops-owned row
      // is a false alarm ops learns to ignore. Re-read the live row last; any
      // movement means not pageable HERE anymore (a new state gets its own
      // clock next tick; a new hold already paged through its own alert).
      if (!(await stillPageable(row))) continue

      pageStuck(row, enteredAt, ageMs, threshold, entered)
      paged++
    } catch (err) {
      // One transfer's reads failing must not blind the rest of the sweep —
      // but a partial sweep is loud, never a clean pass (throw below).
      failures.push(err instanceof Error ? err.message : String(err))
    }
  }

  if (failures.length > 0) {
    // Surface every distinct cause (capped), not just the first — five
    // candidates failing five different ways must not read as one (review
    // finding). Denominator is watched rows, not candidates.
    const distinct = [...new Set(failures)]
    throw new Error(
      `stuck-watch: ${failures.length} candidate check(s) failed across ${rows.length} watched row(s): ` +
        `${distinct.slice(0, 5).join(' | ')}${distinct.length > 5 ? ` (+${distinct.length - 5} more)` : ''}`,
    )
  }
  return paged
}

// A FUNDED row dwelling deliberately is policy, not a stuck transfer. Two
// families, mirrored from payout-submit's own skip ladder (all of it except
// the float ceiling — a ceiling episode deliberately DOES page each dwelling
// row: the runbook's answer is "raise the ceiling or wait", and hiding the
// affected transfers would hide the blast radius):
//  * ops holds (payout_hold_reason — velocity_review, payability…): page at
//    hold time through their own alerts; O2's 8-day audit bounds them
//  * the three NO-HOLD waits (decisions.md 2026-07-31 — they set no hold
//    reason at all, so the reason column cannot identify them):
//    WAIT_FOR_CLEARING (every payout waits for funding_cleared);
//    FIRST_TRANSFER_HOLD (an unproven sender waits for their OWN clearing —
//    flag-first ordering so OFF costs zero queries, same as payout-submit);
//    the O3 uncleared cap (a strictly-older uncleared send parks this one —
//    the wait-die check with the same excludeTransferId + olderThan shape).
// The risk reads failing throw — a transfer must never silently classify as
// either "stuck" or "fine" on a broken read.
async function isDeliberateFundedWait(row: WatchRow): Promise<boolean> {
  if (row.payout_hold_reason != null) return true
  // A CLAIMED row is in crash recovery, not a wait: payout-submit skips every
  // wait gate on recovery (`isRecovery` — the only safe move is the idempotent
  // re-POST, since a Bridge payout may already exist). Nothing about its dwell
  // is deliberate, so no exemption may suppress its page (codex P1: the
  // WAIT_FOR_CLEARING arm would otherwise mask a claimed-then-crashed transfer
  // indefinitely).
  if (row.submit_attempted_at != null) return false
  if (env.WAIT_FOR_CLEARING && !row.funding_cleared) return true
  if (
    env.FIRST_TRANSFER_HOLD &&
    !row.funding_cleared &&
    !(await hasClearedHistory(row.user_id))
  ) {
    return true
  }
  const verdict = await assessUnclearedCap({
    userId: row.user_id,
    excludeTransferId: row.id,
    olderThan: row.disclosure_accepted_at
      ? { acceptedAt: row.disclosure_accepted_at, transferId: row.id }
      : null,
  })
  return !verdict.ok
}

async function stillPageable(row: WatchRow): Promise<boolean> {
  const { data, error } = await supabaseAdmin
    .from('transfers')
    .select('state, payout_hold_reason')
    .eq('id', row.id)
    .single()
  // Fail closed: a broken re-read throws (candidate error) rather than either
  // suppressing or double-confirming the page.
  if (error || data == null) {
    throw new Error(`stuck-watch state re-read failed: ${error?.message ?? 'no row returned'}`)
  }
  const live = data as { state: string; payout_hold_reason: string | null }
  if (live.state !== row.state) return false
  // A hold that landed after the bulk read makes a FUNDED row ops-owned.
  if (row.state === 'FUNDED' && live.payout_hold_reason != null) return false
  return true
}

async function latestTransitionInto(
  transferId: string,
  state: string,
): Promise<TransitionRow | null> {
  const { data, error } = await supabaseAdmin
    .from('transfer_transitions')
    .select('created_at, actor, reason')
    .eq('transfer_id', transferId)
    .eq('to_state', state)
    .order('created_at', { ascending: false })
    .limit(1)
  if (error || data == null) {
    throw new Error(`stuck-watch transition lookup failed: ${error?.message ?? 'no rows returned'}`)
  }
  return (data as TransitionRow[])[0] ?? null
}

function pageStuck(
  row: WatchRow,
  enteredAt: string,
  ageMs: number,
  thresholdMs_: number,
  transition: TransitionRow | null,
): void {
  const ageMinutes = Math.round(ageMs / 60_000)
  // Local evidence beside the capture (correction-watch pattern): a Sentry
  // outage must not leave a stuck transfer traceless. Ids + ages only, no PII.
  console.warn(`worker: stuck-transfer ${row.id} in ${row.state} for ${ageMinutes}m`)
  Sentry.withScope((scope) => {
    // One issue per (transfer, state, ENTRY) episode: the 5-min re-fire while
    // stuck collapses into it; resolving while still stuck reopens next tick;
    // and a round trip back into the same state (new enteredAt) is a NEW
    // episode with its own issue rather than a reopened old one (codex P2).
    scope.setFingerprint(['stuck-transfer', row.id, row.state, enteredAt])
    scope.setContext('stuck_transfer', {
      transferId: row.id,
      state: row.state,
      enteredAt,
      ageMinutes,
      thresholdMinutes: Math.round(thresholdMs_ / 60_000),
      lastTransitionActor: transition?.actor ?? null,
      lastTransitionReason: transition?.reason ?? null,
      // UNDER_REVIEW is the cancellation-review queue — its action lives in
      // the pending-cancellation runbook (resolve-cancellation CLI).
      runbook:
        row.state === 'UNDER_REVIEW'
          ? 'docs/runbooks/pending-cancellation.md'
          : 'docs/runbooks/stuck-transfer.md',
    })
    Sentry.captureMessage(`stuck transfer: ${row.state} past dwell threshold`, 'warning')
  })
}
