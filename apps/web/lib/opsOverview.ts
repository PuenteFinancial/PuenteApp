import { formatUsd, formatMxn } from './sendFormat'
import { parseApiError } from './apiError'

// Pure types + guards + derivations for the 8.5-v1 ops page (extract-to-lib
// convention: logic out of .tsx so it unit-tests without a DOM). Types are
// hand-mirrored from GET /v1/ops/overview (docs/api-contract.md) — the web
// convention (no @puente/shared here); the shape guard is the runtime
// contract check, same posture as isTransferShape.

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
  return true
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
