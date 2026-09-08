// Pure types + guard + derivations for the ops transfer detail page
// (/dashboard/ops/transfers/[id], ops board slice 1). Same extract-to-lib
// convention as opsOverview.ts: logic out of .tsx so it unit-tests without a
// DOM. Types are hand-mirrored from GET /v1/ops/transfers/:id
// (docs/api-contract.md); the shape guard is the runtime contract check.
//
// PII posture is the API's (ids, amounts, timestamps, states, opaque refs,
// joined-row statuses) — nothing here re-derives anything about a person.

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

export interface OpsTransferDetail {
  generatedAt: string
  // Same deploy-skew semantics as the overview: absent = read-only.
  actionsEnabled?: boolean
  transfer: OpsDetailTransfer
  quote: OpsDetailQuote | null
  destination: OpsDetailDestination | null
  refund: OpsDetailRefund
  transitions: OpsDetailTransition[]
  ledger: OpsDetailLedgerBatch[]
  paymentEvents: OpsDetailPaymentEvent[]
  cancellationRequests: OpsDetailCancellationRequest[]
  depositInstructions: OpsDetailDepositInstructions | null
  disclosures: OpsDetailDisclosure[]
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
  return true
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
  if (releasableHoldReason(detail) != null) actions.push('holdRelease')
  if (refundPreflight(detail).blockers.length === 0) actions.push('refund')
  return actions
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
