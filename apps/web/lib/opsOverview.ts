import { formatUsd, formatMxn } from './sendFormat'
import { parseApiError } from './apiError'

// Pure types + guards + derivations for the 8.5-v1 ops page (extract-to-lib
// convention: logic out of .tsx so it unit-tests without a DOM). Types are
// hand-mirrored from GET /v1/ops/overview (docs/api-contract.md); the shape
// guard is the runtime contract check, same posture as isTransferShape.
//
// These stay mirrored on purpose even though apps/web now depends on
// @puente/shared: the ops console is web-only (docs/prds/mobile-mvp.md §2),
// so its response types have exactly one consumer and moving them to a shared
// package would buy nothing.

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
  state: string
  sendAmountMinor: number
  enteredStateAt: string
  dwellMinutes: number
  thresholdMinutes: number
  overThreshold: boolean
  holdReason: string | null
  fundingCleared: boolean
  submitAttempted: boolean
  cancellationRequested: boolean
  // funding-ops-automation slice 1 — OPTIONAL with the same deploy-skew
  // semantics as actionsEnabled: an older API omits them and transferActions()
  // returns [], so the row renders read-only instead of a button that would
  // 409 on a total it cannot state.
  feeAmountMinor?: number
  fundingInitiated?: boolean
  onrampRef?: string | null
  // #244 — the rail that funded this ROW (audit corner 1's column). Every
  // action below is out-of-band-only, so this decides whether any render.
  // Optional with the same deploy-skew semantics: absent = pre-#244 API.
  fundingProcessor?: string
  // Slice 4 — same optional deploy-skew semantics: an older API omits it and
  // the row simply shows no claim annotation.
  paymentClaimedAt?: string | null
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
  // v1.1: whether the API's write capability (double-control env gate) is live.
  // OPTIONAL with default-false semantics — a v1 API during deploy skew simply
  // omits it and the page renders read-only. Gate rendering on `=== true`.
  actionsEnabled?: boolean
  pendingCancellations: OpsPendingCancellation[]
  openTransfers: OpsOpenTransfer[]
  floatCeiling: OpsFloatCeiling
  transferCounts: Array<{ state: string; count: number }>
  ledgerBalances: OpsLedgerBalances | null
  reconciliationRuns: OpsReconciliationRun[]
  // Workstream A: liveness beats, one per logical worker service. OPTIONAL with
  // the same deploy-skew semantics as actionsEnabled — an API predating the
  // heartbeat omits it, and the panel simply doesn't render. Requiring it would
  // make isOpsOverviewShape reject an older API's payload and blank the whole
  // board over a missing panel.
  workerHeartbeats?: OpsWorkerHeartbeat[]
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null

// Structural spot-checks on the panels the page cannot render without — a 2xx
// with a different shape (gateway HTML, contract drift) must fall into the
// load-failed path, never render as an empty, healthy ops board.
export function isOpsOverviewShape(v: unknown): v is OpsOverview {
  if (!isRecord(v)) return false
  if (typeof v.generatedAt !== 'string') return false
  if (!Array.isArray(v.pendingCancellations)) return false
  if (!Array.isArray(v.openTransfers)) return false
  if (!Array.isArray(v.transferCounts)) return false
  if (!Array.isArray(v.reconciliationRuns)) return false
  if (!isRecord(v.floatCeiling) || typeof v.floatCeiling.configured !== 'boolean') return false
  if (v.ledgerBalances !== null && !isRecord(v.ledgerBalances)) return false
  if (v.actionsEnabled !== undefined && typeof v.actionsEnabled !== 'boolean') return false
  if (v.workerHeartbeats !== undefined && !Array.isArray(v.workerHeartbeats)) return false
  return true
}

/**
 * True when ANY worker has gone quiet. This is a needs-you condition, not a
 * statistic: if the worker is dead, every other queue on this page is frozen
 * and its numbers are stale rather than calm.
 *
 * Absent (deploy skew) reads as false — "not reported" must not render as an
 * alarm, or every deploy would cry wolf.
 */
export function workerHeartbeatAlarm(overview: OpsOverview): boolean {
  return (overview.workerHeartbeats ?? []).some((b) => b.stale)
}

/** The worst beat, for the needs-you banner. Null when absent or empty. */
export function stalestHeartbeat(overview: OpsOverview): OpsWorkerHeartbeat | null {
  const beats = overview.workerHeartbeats
  if (beats == null || beats.length === 0) return null
  return beats.reduce((worst, b) => (b.ageSeconds > worst.ageSeconds ? b : worst))
}

// ── v1.1 resolve-cancellation (POST /api/ops/cancellations/resolve) ──────────

export type OpsResolveDecision = 'refund' | 'deny'

const RESOLVE_OUTCOMES = ['refunded', 'denied', 'already_disbursed', 'already_refunded'] as const
export type OpsResolveOutcome = (typeof RESOLVE_OUTCOMES)[number]

export interface OpsResolveSuccess {
  transferId: string
  outcome: OpsResolveOutcome
}

export function isOpsResolveSuccessShape(v: unknown): v is OpsResolveSuccess {
  if (!isRecord(v)) return false
  if (typeof v.transferId !== 'string') return false
  return RESOLVE_OUTCOMES.includes(v.outcome as OpsResolveOutcome)
}

// The UI branches the component switches on — each refusal demands DIFFERENT
// operator behavior (claim_abandoned → runbook, never retry; refund_owed →
// permanent legal refusal; evidence_conflict → correct the input in place).
export type ResolveErrorKind =
  | 'claim_abandoned'
  | 'refund_owed'
  | 'evidence_conflict'
  | 'conflict'
  | 'not_found'
  | 'validation'
  | 'generic'

export function resolveErrorKind(status: number, body: unknown): ResolveErrorKind {
  const code = parseApiError(body)?.code ?? null
  if (status === 409) {
    if (code === 'claim_abandoned') return 'claim_abandoned'
    if (code === 'refund_owed') return 'refund_owed'
    if (code === 'deposit_evidence_conflict') return 'evidence_conflict'
    if (code === 'conflict' || code === 'idempotency_conflict') return 'conflict'
    return 'generic'
  }
  if (status === 404) return 'not_found'
  if (status === 400) return 'validation'
  return 'generic'
}

// The evidence bounds ride details[0].issue on deposit_evidence_conflict —
// operator-facing operational data (timestamps), not consumer copy.
export function firstDetailIssue(body: unknown): string | null {
  if (!isRecord(body) || !isRecord(body.error)) return null
  const details = body.error.details
  if (!Array.isArray(details) || !isRecord(details[0])) return null
  return typeof details[0].issue === 'string' ? details[0].issue : null
}

// ── Transfer actions (funding-ops-automation slice 1) ────────────────────────

const TRANSFER_FUNDING_OUTCOMES = ['funded', 'cleared', 'cleared_skipped'] as const
export type OpsTransferFundingOutcome = (typeof TRANSFER_FUNDING_OUTCOMES)[number]

export interface OpsTransferFundingSuccess {
  transferId: string
  outcome: OpsTransferFundingOutcome
}

// One guard for both money writes: the funding route answers 'funded', the
// deposit-landed route 'cleared' | 'cleared_skipped' — same envelope.
export function isOpsTransferFundingSuccessShape(v: unknown): v is OpsTransferFundingSuccess {
  if (!isRecord(v)) return false
  if (typeof v.transferId !== 'string') return false
  return TRANSFER_FUNDING_OUTCOMES.includes(v.outcome as OpsTransferFundingOutcome)
}

export interface OpsAttachSuccess {
  transferId: string
  outcome: 'attached'
  depositMessage: string
}

export function isOpsAttachSuccessShape(v: unknown): v is OpsAttachSuccess {
  if (!isRecord(v)) return false
  if (typeof v.transferId !== 'string') return false
  if (v.outcome !== 'attached') return false
  return typeof v.depositMessage === 'string'
}

export type OpsTransferAction = 'attach' | 'release' | 'depositLanded'

/**
 * Which actions a row supports. Encodes the operational order, not the API's
 * full reachability: attach and release act on a confirmed PENDING_PAYMENT
 * row; deposit-landed acts on any released row whose receivable is still open
 * (the runbook's §5-then-§6 order — cleared before release is not offered even
 * though the API would take it). Deploy skew (missing fields) → no actions.
 */
export function transferActions(tr: OpsOpenTransfer): OpsTransferAction[] {
  if (tr.feeAmountMinor === undefined || tr.fundingInitiated === undefined) return []
  // All three actions are the out-of-band rail's: the server refuses each one
  // with processor_not_manual on any other rail (#244), so rendering them
  // elsewhere only produces a guaranteed 409 — and an attach that "succeeds"
  // would write deposit coordinates no surface ever shows. Absent (older API)
  // keeps the previous behaviour; the server remains the real guard.
  if (tr.fundingProcessor !== undefined && tr.fundingProcessor !== 'manual') return []
  if (tr.state === 'PENDING_PAYMENT') {
    return tr.fundingInitiated ? ['attach', 'release'] : []
  }
  return tr.fundingCleared ? [] : ['depositLanded']
}

// ── Treasury float top-up (funding-ops-automation slice 2) ───────────────────

export interface OpsFloatTopUpSuccess {
  amountMinor: number
  externalRef: string
  floatBalanceMinor: number
}

export function isOpsFloatTopUpSuccessShape(v: unknown): v is OpsFloatTopUpSuccess {
  if (!isRecord(v)) return false
  if (typeof v.amountMinor !== 'number') return false
  if (typeof v.externalRef !== 'string') return false
  return typeof v.floatBalanceMinor === 'number'
}

// ── Derivations (the API ships two lists; the page shows five panels) ────────

export function heldTransfers(overview: OpsOverview): OpsOpenTransfer[] {
  return overview.openTransfers.filter((t) => t.holdReason != null)
}

export function agingReviews(overview: OpsOverview): OpsOpenTransfer[] {
  return overview.openTransfers.filter((t) => t.state === 'UNDER_REVIEW' && t.overThreshold)
}

export function latestRun(overview: OpsOverview): OpsReconciliationRun | null {
  return overview.reconciliationRuns[0] ?? null
}

/** The needs-you slice of the latest run: checks that found something or died. */
export function latestFindings(overview: OpsOverview): OpsCheck[] {
  const run = latestRun(overview)
  if (!run) return []
  return run.checks.filter((c) => c.status === 'findings' || c.status === 'error')
}

/**
 * Checks the latest run never RAN (skipped ≠ clean — three checks skip in
 * exactly today's prod config: mock funding processor, no treasury wallet id).
 * Surfaced beside the findings so "latest run was clean" can't be asserted
 * over checks that never executed (review finding).
 */
export function latestSkipped(overview: OpsOverview): OpsCheck[] {
  const run = latestRun(overview)
  if (!run) return []
  return run.checks.filter((c) => c.status === 'skipped')
}

/**
 * Currency-aware balance formatting. The ledger chart is all-USD today, but
 * the wire carries `currency` per balance precisely because a future account
 * could differ — formatting MXN minor units as dollars would misstate a
 * financial position to an operator (codex-review finding). Reuses the
 * sendFormat helpers for the known currencies; unknown ones fall back to an
 * explicit "<amount> <code>" rather than a wrong symbol.
 */
export function formatBalance(amountMinor: number, currency: string): string {
  if (currency === 'USD') return formatUsd(amountMinor)
  if (currency === 'MXN') return formatMxn(amountMinor)
  return `${(amountMinor / 100).toFixed(2)} ${currency}`
}
