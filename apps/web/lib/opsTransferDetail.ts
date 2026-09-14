// Pure types + guard + derivations for the ops transfer detail page
// (/dashboard/ops/transfers/[id], ops board slice 1). Same extract-to-lib
// convention as opsOverview.ts: logic out of .tsx so it unit-tests without a
// DOM. Types are hand-mirrored from GET /v1/ops/transfers/:id
// (docs/api-contract.md); the shape guard is the runtime contract check.
//
// PII posture is the API's (ids, amounts, timestamps, states, opaque refs,
// joined-row statuses) — nothing here re-derives anything about a person.

import { isOpsActivityRowShape, type OpsActivityRow } from './opsActivity'

export interface OpsDwell {
  enteredStateAt: string
  dwellMinutes: number
  thresholdMinutes: number
  overThreshold: boolean
}

export interface OpsDetailTransfer {
  transferId: string
  state: string
  sendAmountMinor: number
  sendCurrency: string
  receiveAmountMinor: number
  receiveCurrency: string
  feeAmountMinor: number
  marginMinor: number
  fxRate: number
  fundingSourceType: string
  fundingProcessor: string
  fundingCleared: boolean
  fundingPaymentRef: string | null
  providerTransferRef: string | null
  refundPaymentRef: string | null
  payoutHoldReason: string | null
  payoutHeldAt: string | null
  submitAttemptedAt: string | null
  cancellationRequestedAt: string | null
  paymentClaimedAt: string | null
  disclosureAcceptedAt: string | null
  paymentAt: string | null
  cancelableUntil: string | null
  completedAt: string | null
  refundedAt: string | null
  createdAt: string
  dwell: OpsDwell | null
}

export interface OpsDetailQuote {
  fxRate: number
  sourceRate: number
  marginMinor: number
  fxRateAt: string
  expiresAt: string
  createdAt: string
  status: string
}

export interface OpsDetailDestination {
  status: string
  hasProviderAccountRef: boolean
  recipientStatus: string | null
}

export type OpsClaimStatus = 'unclaimed' | 'claimed' | 'abandoned'
const CLAIM_STATUSES: readonly OpsClaimStatus[] = ['unclaimed', 'claimed', 'abandoned']

export interface OpsDetailRefund {
  claimStatus: OpsClaimStatus
  claimedAt: string | null
  claimedBy: string | null
  returnEventType: string | null
  ledgerKeys: { bridgeReturn: boolean; refunded: boolean }
}

export interface OpsDetailTransition {
  fromState: string | null
  toState: string
  actor: string
  reason: string | null
  createdAt: string
}

export interface OpsDetailLedgerEntry {
  accountCode: string
  direction: string
  amountMinor: number
  currency: string
}

export interface OpsDetailLedgerBatch {
  transition: string | null
  idempotencyKey: string
  description: string | null
  postedAt: string
  netMinor: number
  entries: OpsDetailLedgerEntry[]
}

export interface OpsDetailPaymentEvent {
  id: string
  source: string
  eventType: string
  status: string
  receivedAt: string
  processedAt: string | null
  providerRef: string | null
  hasError: boolean
}

export interface OpsDetailCancellationRequest {
  id: string
  requestedAt: string
  requestedState: string
  withinWindow: boolean
  status: string
  resolvedAt: string | null
  resolvedBy: string | null
}

export interface OpsDetailDepositInstructions {
  bridgeTransferRef: string
  currency: string
  amountMinor: number
  paymentRail: string
  depositMessage: string
  attachedBy: string | null
}

export interface OpsDetailDisclosure {
  type: string
  locale: string
  presentedAt: string
}

/**
 * Whether Release hold can accomplish anything on this row (2026-09-14). The
 * hold REASON cannot answer that on its own: `fx_drift` is placed by either of
 * two conditions and only one of them is something a release resolves. The API
 * derives this from the quote's age against its own FX_MAX_QUOTE_AGE_MINUTES —
 * a bound the browser does not have — so the verdict is read, never recomputed
 * here.
 */
export interface OpsDetailHoldRelease {
  blocker: 'stale_quote' | null
  quoteAgeMinutes: number
  maxQuoteAgeMinutes: number
}

export interface OpsTransferDetail {
  generatedAt: string
  // Same deploy-skew semantics as the overview: absent = read-only.
  actionsEnabled?: boolean
  transfer: OpsDetailTransfer
  quote: OpsDetailQuote | null
  destination: OpsDetailDestination | null
  // Absent on an older API (deploy skew) and null when the reason carries no
  // arm-level distinction. Both mean "no blocker reported" and the button
  // stays — the API refuses with 409 hold_cannot_clear regardless, so the
  // worst case is the status quo, never a release that should not happen.
  holdRelease?: OpsDetailHoldRelease | null
  refund: OpsDetailRefund
  transitions: OpsDetailTransition[]
  ledger: OpsDetailLedgerBatch[]
  paymentEvents: OpsDetailPaymentEvent[]
  cancellationRequests: OpsDetailCancellationRequest[]
  depositInstructions: OpsDetailDepositInstructions | null
  disclosures: OpsDetailDisclosure[]
  // Slice 2: the transfer's ops history. Same deploy-skew semantics as
  // actionsEnabled — absent = not reported, and the section stays hidden.
  activity?: OpsActivityRow[]
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null

// Structural spot-checks on the panels the page cannot render without. A 2xx
// with a different shape (gateway HTML, contract drift) must fall into the
// load-failed path, never render as an empty-but-healthy detail page.
export function isOpsTransferDetailShape(v: unknown): v is OpsTransferDetail {
  if (!isRecord(v)) return false
  if (typeof v.generatedAt !== 'string') return false
  if (!isRecord(v.transfer)) return false
  if (typeof v.transfer.transferId !== 'string' || typeof v.transfer.state !== 'string') return false
  if (typeof v.transfer.sendAmountMinor !== 'number' || typeof v.transfer.feeAmountMinor !== 'number') {
    return false
  }
  if (!isRecord(v.refund) || !CLAIM_STATUSES.includes(v.refund.claimStatus as OpsClaimStatus)) return false
  for (const list of ['transitions', 'ledger', 'paymentEvents', 'cancellationRequests', 'disclosures']) {
    if (!Array.isArray(v[list])) return false
  }
  if (v.actionsEnabled !== undefined && typeof v.actionsEnabled !== 'boolean') return false
  // Structural, not semantic: a malformed verdict must not be read as "no
  // blocker". Absent or null is the honest "not reported" (deploy skew).
  if (v.holdRelease !== undefined && v.holdRelease !== null) {
    if (!isRecord(v.holdRelease)) return false
    const b = v.holdRelease.blocker
    if (b !== null && b !== 'stale_quote') return false
    if (typeof v.holdRelease.quoteAgeMinutes !== 'number') return false
    if (typeof v.holdRelease.maxQuoteAgeMinutes !== 'number') return false
  }
  if (v.activity !== undefined && !(Array.isArray(v.activity) && v.activity.every(isOpsActivityRowShape))) {
    return false
  }
  return true
}

/** Slice 2: the history as the API sent it (newest first); empty when not reported. */
export function activityRows(detail: OpsTransferDetail): OpsActivityRow[] {
  return detail.activity ?? []
}

/** Every posting batch nets to zero — the runbook's verify step, as a boolean. */
export function ledgerBalanced(detail: OpsTransferDetail): boolean {
  return detail.ledger.every((batch) => batch.netMinor === 0)
}

// The hold reasons an operator may release from the board (decision
// 2026-09-08, all four human-actioned reasons). sender_kyc_pending is NOT
// here: it auto-releases on Bridge's approval webhook and releasing while
// the customer is unverified only re-holds the row.
export const RELEASABLE_HOLD_REASONS = [
  'fx_drift',
  'payability',
  'velocity_review',
  'submit_error',
] as const
export type ReleasableHoldReason = (typeof RELEASABLE_HOLD_REASONS)[number]

export function releasableHoldReason(detail: OpsTransferDetail): ReleasableHoldReason | null {
  const { state, payoutHoldReason } = detail.transfer
  if (state !== 'FUNDED' || payoutHoldReason == null) return null
  return (RELEASABLE_HOLD_REASONS as readonly string[]).includes(payoutHoldReason)
    ? (payoutHoldReason as ReleasableHoldReason)
    : null
}

/**
 * Why releasing this hold could not clear it, or null.
 *
 * Distinct from `releasableHoldReason`, which is about POLICY — may an operator
 * act on this reason. This is about MECHANISM: a `fx_drift` hold whose quote is
 * past the API's max age re-lands within a minute of any release, because the
 * submit job re-measures the same growing number (observed on staging
 * 2026-09-14: released 17:33, re-held 33 seconds later). Offering the button
 * there spends an operator's action on a loop. The exit for those rows is
 * cancel + refund, which the page says instead.
 */
export function holdReleaseBlocker(detail: OpsTransferDetail): 'stale_quote' | null {
  if (releasableHoldReason(detail) == null) return null
  return detail.holdRelease?.blocker ?? null
}

// Why a refund cannot be offered right now. Mirrors the CLI's dry run: state
// gate, the claim, and the RECORDED half of the principal-returned interlock
// (the live Bridge half runs only inside the action). A pre-submit row
// (#254: no provider ref) has nothing to return, so it passes without an event.
export type RefundBlocker = 'not_payout_failed' | 'claim_abandoned' | 'claim_live' | 'no_return_event'

export function refundPreflight(detail: OpsTransferDetail): { blockers: RefundBlocker[] } {
  const blockers: RefundBlocker[] = []
  if (detail.transfer.state !== 'PAYOUT_FAILED') blockers.push('not_payout_failed')
  if (detail.refund.claimStatus === 'abandoned') blockers.push('claim_abandoned')
  if (detail.refund.claimStatus === 'claimed') blockers.push('claim_live')
  if (detail.transfer.providerTransferRef != null && detail.refund.returnEventType == null) {
    blockers.push('no_return_event')
  }
  return { blockers }
}

export type OpsDetailAction = 'holdRelease' | 'refund'

/**
 * Which actions the detail page offers. `[]` unless the API reports the write
 * capability live (deploy skew renders read-only). An abandoned claim is the
 * STOP state — no refund button by design; the page shows the runbook path.
 */
export function detailActions(detail: OpsTransferDetail): OpsDetailAction[] {
  if (detail.actionsEnabled !== true) return []
  const actions: OpsDetailAction[] = []
  // A blocked release is NOT offered — same posture as the abandoned refund
  // claim: when the action cannot do its job, the page shows the path that can.
  if (releasableHoldReason(detail) != null && holdReleaseBlocker(detail) == null) {
    actions.push('holdRelease')
  }
  if (refundPreflight(detail).blockers.length === 0) actions.push('refund')
  return actions
}

// ── O-B: the two write actions ───────────────────────────────────────────────

// The operator's note: what they verified before acting. Mirrors the API's
// body schema (10–500 chars after trim) so the button gates client-side and
// the 400 is never the first feedback. Free text; the hint tells the operator
// to keep names and account numbers out of it.
export const OPS_NOTE_MIN = 10
export const OPS_NOTE_MAX = 500
export function opsNoteValid(note: string): boolean {
  const n = note.trim().length
  return n >= OPS_NOTE_MIN && n <= OPS_NOTE_MAX
}

export interface OpsHoldReleaseSuccess {
  transferId: string
  outcome: 'released'
  enqueued: boolean
}

export function isOpsHoldReleaseSuccessShape(v: unknown): v is OpsHoldReleaseSuccess {
  if (!isRecord(v)) return false
  return typeof v.transferId === 'string' && v.outcome === 'released' && typeof v.enqueued === 'boolean'
}

const REFUND_OUTCOMES = ['refunded', 'already_disbursed', 'already_settled'] as const
export type OpsRefundOutcome = (typeof REFUND_OUTCOMES)[number]

export interface OpsRefundSuccess {
  transferId: string
  outcome: OpsRefundOutcome
  ledgerComplete: boolean
  ledgerKeys: string[]
}

export function isOpsRefundSuccessShape(v: unknown): v is OpsRefundSuccess {
  if (!isRecord(v)) return false
  if (typeof v.transferId !== 'string') return false
  if (!REFUND_OUTCOMES.includes(v.outcome as OpsRefundOutcome)) return false
  if (typeof v.ledgerComplete !== 'boolean') return false
  return Array.isArray(v.ledgerKeys) && v.ledgerKeys.every((k) => typeof k === 'string')
}

/** Date AND time — an operator reading a timeline needs the minute. */
export function formatOpsTimestamp(iso: string, lang: 'en' | 'es'): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return iso
  // Explicit components, not dateStyle/timeStyle: Intl refuses to combine the
  // style shortcuts with timeZoneName, and the zone must be visible — an
  // operator comparing against the Bridge dashboard needs to know it is UTC.
  return d.toLocaleString(lang === 'es' ? 'es-MX' : 'en-US', {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
    timeZone: 'UTC',
    timeZoneName: 'short',
  })
}
