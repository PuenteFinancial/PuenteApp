import { env } from '../config/env.js'
import { supabaseAdmin } from './supabase.js'
import { listPendingReviews } from './cancellation-review.js'
import { isFloatCeilingTripped } from './payouts.js'
import { getAccountBalance } from './ledger.js'
import { coarseAnchor, thresholdMs, WATCHED_STATES, type WatchedState } from '../jobs/stuck-watch.js'

// The 8.5-v1 ops overview (GET /v1/ops/overview, docs/api-contract.md): one
// read-only aggregate the admin page renders in a single pass. Panels are all
// bounded and fail CLOSED (a broken read 500s the route — an empty queue and a
// broken read must never look the same). The single exception is the float
// ceiling: FLOAT_CEILING_MINOR is legitimately unset in the API process
// (worker-only knob), so that panel reports { configured: false } instead of
// throwing.
//
// PII discipline (listPendingReviews' rule, enforced again by the route's
// response schema): ids, amounts, timestamps, states, hold reasons, booleans.
// No names, no destinations, no user ids, no provider payloads on this wire —
// recon check `summary` objects are deliberately NOT included (name/status/
// count/error only; detail lives in the run row and Sentry).

const ROW_BOUND = 1000

export interface OpsPendingCancellation {
  transferId: string
  state: string
  sendAmountMinor: number
  feeAmountMinor: number
  requestedAt: string
  withinWindow: boolean
  refundPaymentRef: string | null
}

export interface OpsOpenTransfer {
  transferId: string
  state: WatchedState
  sendAmountMinor: number
  enteredStateAt: string
  dwellMinutes: number
  thresholdMinutes: number
  overThreshold: boolean
  holdReason: string | null
  fundingCleared: boolean
  submitAttempted: boolean
  cancellationRequested: boolean
}

export interface OpsFloatCeiling {
  configured: boolean
  tripped: boolean | null
  balanceMinor: number
  ceilingMinor: number | null
}

export interface OpsCheck {
  name: string
  status: string
  findingsCount: number
  error?: string
}

export interface OpsReconciliationRun {
  createdAt: string
  status: string
  findingsCount: number
  checks: OpsCheck[]
}

export interface OpsLedgerBalances {
  asOf: string
  balances: Array<{ code: string; amountMinor: number; currency: string }>
}

export interface OpsWorkerHeartbeat {
  worker: string
  beatAt: string
  ageSeconds: number
  stale: boolean
}

export interface OpsOverview {
  generatedAt: string
  pendingCancellations: OpsPendingCancellation[]
  openTransfers: OpsOpenTransfer[]
  floatCeiling: OpsFloatCeiling
  transferCounts: Array<{ state: string; count: number }>
  ledgerBalances: OpsLedgerBalances | null
  reconciliationRuns: OpsReconciliationRun[]
  workerHeartbeats: OpsWorkerHeartbeat[]
}

// Row shape for the open-transfers select — a superset of stuck-watch's
// WatchRow so `coarseAnchor` applies verbatim (same clock as the pager).
// user_id and disclosure_accepted_at are selected to satisfy that shape but
// never emitted on the wire.
interface OpenRow {
  id: string
  user_id: string
  state: WatchedState
  send_amount_minor: number
  funding_cleared: boolean
  payout_hold_reason: string | null
  disclosure_accepted_at: string | null
  payment_at: string | null
  submit_attempted_at: string | null
  cancellation_requested_at: string | null
  created_at: string
}

async function readOpenTransfers(nowMs: number): Promise<OpsOpenTransfer[]> {
  const { data, error } = await supabaseAdmin
    .from('transfers')
    .select(
      'id, user_id, state, send_amount_minor, funding_cleared, payout_hold_reason, disclosure_accepted_at, payment_at, submit_attempted_at, cancellation_requested_at, created_at',
    )
    .in('state', [...WATCHED_STATES])
    .limit(ROW_BOUND)
  if (error || data == null) {
    throw new Error(`ops open-transfers select failed: ${error?.message ?? 'no rows returned'}`)
  }
  const rows = data as OpenRow[]
  if (rows.length >= ROW_BOUND) {
    throw new Error(
      `ops open-transfers hit the ${ROW_BOUND}-row PostgREST cap — results may be silently truncated`,
    )
  }
  return rows
    .map((row) => {
      // coarseAnchor may predate the current stay after a state round trip —
      // the page over-states age in that rare case; the stuck-watch pager owns
      // exact verdicts (its page carries the transitions-log entry time).
      const enteredStateAt = coarseAnchor(row)
      const dwellMs = nowMs - new Date(enteredStateAt).getTime()
      const threshold = thresholdMs(row.state)
      return {
        transferId: row.id,
        state: row.state,
        sendAmountMinor: row.send_amount_minor,
        enteredStateAt,
        dwellMinutes: Math.max(0, Math.round(dwellMs / 60_000)),
        thresholdMinutes: Math.round(threshold / 60_000),
        overThreshold: dwellMs > threshold,
        holdReason: row.payout_hold_reason,
        fundingCleared: row.funding_cleared,
        submitAttempted: row.submit_attempted_at != null,
        cancellationRequested: row.cancellation_requested_at != null,
      }
    })
    .sort((a, b) => b.dwellMinutes - a.dwellMinutes)
}

async function readFloatCeiling(): Promise<OpsFloatCeiling> {
  // Guarded BEFORE isFloatCeilingTripped(): that helper throws on an unset
  // ceiling (correct for the worker, which must not submit without the
  // control), but for the API process "unset" is a legitimate config state the
  // page reports rather than 500s. The live balance is still worth showing.
  if (env.FLOAT_CEILING_MINOR === undefined) {
    const balance = await getAccountBalance('funding_receivable')
    return { configured: false, tripped: null, balanceMinor: balance.amountMinor, ceilingMinor: null }
  }
  const status = await isFloatCeilingTripped()
  return {
    configured: true,
    tripped: status.tripped,
    balanceMinor: status.balanceMinor,
    ceilingMinor: status.ceilingMinor,
  }
}

async function readTransferCounts(): Promise<Array<{ state: string; count: number }>> {
  const { data, error } = await supabaseAdmin.rpc('ops_transfer_state_counts')
  if (error || data == null) {
    throw new Error(`ops transfer-counts rpc failed: ${error?.message ?? 'no rows returned'}`)
  }
  return (data as Array<{ state: string; count: number }>).map((row) => ({
    state: row.state,
    count: Number(row.count),
  }))
}

interface RunRow {
  created_at: string
  status: string
  findings_count: number
  checks: Array<{ name: string; status: string; findings_count: number; error?: string }>
  balances: Record<string, { amount_minor: number; currency: string }>
}

async function readReconciliationRuns(): Promise<{
  runs: OpsReconciliationRun[]
  ledgerBalances: OpsLedgerBalances | null
}> {
  // The runbook's own query (docs/runbooks/reconciliation.md "Reading a run").
  const { data, error } = await supabaseAdmin
    .from('reconciliation_runs')
    .select('created_at, status, findings_count, checks, balances')
    .order('created_at', { ascending: false })
    .limit(7)
  if (error || data == null) {
    throw new Error(`ops reconciliation-runs select failed: ${error?.message ?? 'no rows returned'}`)
  }
  const rows = data as RunRow[]
  const runs = rows.map((row) => ({
    createdAt: row.created_at,
    status: row.status,
    findingsCount: row.findings_count,
    checks: (row.checks ?? []).map((check) => ({
      name: check.name,
      status: check.status,
      findingsCount: Number(check.findings_count ?? 0),
      ...(typeof check.error === 'string' && { error: check.error }),
    })),
  }))
  // Balance snapshot rides the NEWEST RUN THAT ACTUALLY CARRIES ONE (free;
  // staleness explicit via asOf). A run whose account_balances check failed
  // persists the column default '{}' — lifting that blindly would render a
  // broken snapshot as an empty-but-healthy balances card, the exact
  // empty-vs-broken confusion this slice avoids everywhere else (review
  // finding). The one balance that must be live — funding_receivable vs the
  // ceiling — comes from the float panel instead.
  const withBalances = rows.find((r) => Object.keys(r.balances ?? {}).length > 0)
  const ledgerBalances =
    withBalances == null
      ? null
      : {
          asOf: withBalances.created_at,
          balances: Object.entries(withBalances.balances)
            .map(([code, value]) => ({
              code,
              amountMinor: Number(value.amount_minor),
              currency: value.currency,
            }))
            .sort((a, b) => a.code.localeCompare(b.code)),
        }
  return { runs, ledgerBalances }
}

// The beat is every 5 min and the Sentry cron monitor opens an issue after 3
// consecutive misses. This page uses the SAME arithmetic on purpose — a board
// that calls the worker healthy while the pager calls it dead (or vice versa)
// is worse than either signal alone.
const HEARTBEAT_STALE_SECONDS = 15 * 60

interface HeartbeatRow {
  worker: string
  updated_at: string
}

// One row per logical worker service, returned as an ARRAY rather than "the
// newest beat": if a second worker service is ever added, a dead one must not
// be masked by a healthy one. `instance` is deliberately not selected — it is
// for psql during an incident, not for the wire.
async function readWorkerHeartbeats(nowMs: number): Promise<OpsWorkerHeartbeat[]> {
  const { data, error } = await supabaseAdmin
    .from('worker_heartbeat')
    .select('worker, updated_at')
    // Stalest first, matching how readOpenTransfers surfaces worst-first.
    .order('updated_at', { ascending: true })
    .limit(50)
  if (error || data == null) {
    throw new Error(`ops worker-heartbeat select failed: ${error?.message ?? 'no rows returned'}`)
  }
  return (data as HeartbeatRow[]).map((row) => {
    const ageSeconds = Math.max(0, Math.round((nowMs - new Date(row.updated_at).getTime()) / 1000))
    return {
      worker: row.worker,
      beatAt: row.updated_at,
      ageSeconds,
      stale: ageSeconds > HEARTBEAT_STALE_SECONDS,
    }
  })
}

export async function buildOpsOverview(): Promise<OpsOverview> {
  const nowMs = Date.now()
  const [pending, openTransfers, floatCeiling, transferCounts, recon, workerHeartbeats] =
    await Promise.all([
      listPendingReviews(),
      readOpenTransfers(nowMs),
      readFloatCeiling(),
      readTransferCounts(),
      readReconciliationRuns(),
      readWorkerHeartbeats(nowMs),
    ])
  return {
    generatedAt: new Date(nowMs).toISOString(),
    pendingCancellations: pending.map((row) => ({
      transferId: row.transfer_id,
      state: row.state,
      sendAmountMinor: row.send_amount_minor,
      feeAmountMinor: row.fee_amount_minor,
      requestedAt: row.requested_at,
      withinWindow: row.within_window,
      refundPaymentRef: row.refund_payment_ref,
    })),
    openTransfers,
    floatCeiling,
    transferCounts,
    ledgerBalances: recon.ledgerBalances,
    reconciliationRuns: recon.runs,
    workerHeartbeats,
  }
}
