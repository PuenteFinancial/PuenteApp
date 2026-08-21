import type { Money } from './sendFormat'
import { parseApiError, parseCancellationRequiresSupport } from './apiError'

// Pure state logic for the transfer tracker — what the timeline shows, when to
// stop polling, whether to offer cancel, and how to read a cancel response.
// Extracted from TransferTracker.tsx so all of it is unit-testable in the
// node-environment vitest run (same split as sendFormat.ts ← QuoteScreen).

// The 11 states of docs/transfer-state-machine.md, still mirrored by hand from
// packages/shared/src/types/transfer.ts and still needing to be kept in step
// with it.
//
// The reason for the mirror is gone as of the i18n promotion: apps/web now
// depends on @puente/shared. This module just hasn't moved yet — it lands in
// shared in mobile slice M7, alongside the transfer tracker that consumes it
// (docs/prds/mobile-mvp.md §9). Import from @puente/shared then and delete
// this union.
export type TransferState =
  | 'PENDING_PAYMENT'
  | 'FUNDED'
  | 'SUBMITTED'
  | 'IN_FLIGHT'
  | 'COMPLETED'
  | 'PAYMENT_FAILED'
  | 'CANCELED'
  | 'PAYOUT_FAILED'
  | 'REFUNDED'
  | 'FUNDING_REVERSED'
  | 'UNDER_REVIEW'

export interface TrackedTransfer {
  id: string
  state: TransferState
  totalAmount: Money
  sendAmount: Money
  feeAmount: Money
  receiveAmount: Money
  fxRate: string
  paymentAt: string | null
  /** Set at FUNDED — the end of the Reg E cancellation window. */
  cancelableUntil: string | null
  /**
   * Set when the sender asked to cancel a transfer already on its way to payout
   * (slice-7 PR6b). Optional because history rows predating the column, and
   * older cached responses, simply do not carry it.
   */
  cancellationRequestedAt?: string | null
  /**
   * Set-once when the sender tapped "I've sent the payment" (funding-ops
   * slice 4). Optional for the same reason as cancellationRequestedAt: older
   * cached responses simply do not carry it.
   */
  paymentClaimedAt?: string | null
  completedAt: string | null
  createdAt: string
}

// The happy path, in order. Everything else is an exit from it.
export const TIMELINE_STEPS = [
  'PENDING_PAYMENT',
  'FUNDED',
  'SUBMITTED',
  'IN_FLIGHT',
  'COMPLETED',
] as const

export type TimelineStep = (typeof TIMELINE_STEPS)[number]
export type StepStatus = 'done' | 'current' | 'upcoming'

// States that can never change again without the sender starting something new.
// Polling stops here. CANCELED, PAYOUT_FAILED and UNDER_REVIEW are deliberately
// NOT in this set: CANCELED advances to REFUNDED on the cancel request's own
// tail, and the other two are resolved by ops, so a tracker left open should
// see it happen.
const SETTLED: ReadonlySet<TransferState> = new Set<TransferState>([
  'COMPLETED',
  'REFUNDED',
  'PAYMENT_FAILED',
  'FUNDING_REVERSED',
])

// Every state that has left the happy path, plus COMPLETED — each maps to one
// user-facing outcome. Keyed by state so an unmapped state can't silently
// render as "in progress".
const OUTCOMES = {
  COMPLETED: 'completed',
  CANCELED: 'canceled',
  REFUNDED: 'refunded',
  PAYMENT_FAILED: 'paymentFailed',
  PAYOUT_FAILED: 'payoutFailed',
  FUNDING_REVERSED: 'fundingReversed',
  UNDER_REVIEW: 'underReview',
} as const

export type TransferOutcome = (typeof OUTCOMES)[keyof typeof OUTCOMES]

export function isSettled(state: TransferState): boolean {
  return SETTLED.has(state)
}

// True while the transfer is still walking the forward path, so the step
// timeline is the honest thing to render.
export function isOnHappyPath(state: TransferState): boolean {
  return (TIMELINE_STEPS as readonly string[]).includes(state)
}

// The outcome banner for a state, or null while it is still in flight.
// COMPLETED returns both an outcome AND stays on the happy path — the timeline
// renders fully done beneath a success banner.
export function outcomeFor(state: TransferState): TransferOutcome | null {
  return OUTCOMES[state as keyof typeof OUTCOMES] ?? null
}

export type BadgeTone = 'success' | 'progress' | 'neutral' | 'error'

// The coarse visual grouping a history-row status badge carries alongside its
// exact per-state label — the label gives precision, the tone gives the
// at-a-glance scan. Exhaustive over TransferState (a Record, not a lookup with a
// fallback) so adding a state without a tone is a compile error, never a silent
// default. `progress` = still moving; `success` = delivered; `neutral` = money
// returned or a benign dead end; `error` = needs attention.
const BADGE_TONES: Record<TransferState, BadgeTone> = {
  PENDING_PAYMENT: 'progress',
  FUNDED: 'progress',
  SUBMITTED: 'progress',
  IN_FLIGHT: 'progress',
  COMPLETED: 'success',
  CANCELED: 'neutral',
  REFUNDED: 'neutral',
  PAYMENT_FAILED: 'neutral',
  PAYOUT_FAILED: 'error',
  FUNDING_REVERSED: 'error',
  // 'progress', not 'error'. `error` means "needs attention" — and the sender
  // can do nothing here AND their transfer was delivered successfully. This is
  // us working through a cancellation they asked for, so it reads as motion,
  // not fault. Cheap to correct now because slice-7 PR6b is the repo's first
  // writer of this state: no sender has ever seen it.
  UNDER_REVIEW: 'progress',
}

export function badgeTone(state: TransferState): BadgeTone {
  return BADGE_TONES[state]
}

/**
 * Whether the tracker should show the pending-cancellation banner.
 *
 * The underlying fact is A FLAG ORTHOGONAL TO STATE, deliberately not a
 * timeline step and not an outcome: the payout keeps advancing while the
 * request is pending, so the timeline stays the honest thing to render and
 * this rides above it. Folding it into the state machine would force the
 * tracker to choose between showing where the money is and showing that the
 * sender asked to stop it — and both are true at once.
 *
 * Named for what it DECIDES, not what it knows (PR6b review fix — formerly
 * `hasPendingCancellation`): the flag records "has ever asked", and a request
 * can still be open on states where this returns false. The banner shows only
 * while no outcome banner speaks:
 *  - settled states: the request resolved with the transfer, and the outcome
 *    carries the story.
 *  - UNDER_REVIEW: the outcome banner IS the cancellation story ("working on
 *    your cancellation") — stacking this banner over it repeated the promise
 *    and contradicted it ("already on its way" vs "was delivered").
 *  - COMPLETED with the request still open (the out-of-window / after-deposit
 *    buckets awaiting a human denial): deliberately plain "Delivered" — a
 *    "we're working on it" banner would imply hope for a request that ops will
 *    deny; the page still updates in place when the denial closes it.
 */
export function showCancellationBanner(transfer: {
  state: TransferState
  cancellationRequestedAt?: string | null
}): boolean {
  if (!transfer.cancellationRequestedAt) return false
  return !isSettled(transfer.state) && outcomeFor(transfer.state) === null
}

// Step-by-step progress for a happy-path state. Deliberately NOT defined for
// off-path states: a canceled or refunded transfer gives no honest answer to
// "how far did it get" (REFUNDED is reachable from both CANCELED and
// PAYOUT_FAILED), so the UI shows the outcome instead of a guessed timeline.
export function timelineFor(state: TransferState): { step: TimelineStep; status: StepStatus }[] {
  const current = TIMELINE_STEPS.indexOf(state as TimelineStep)
  if (current === -1) return []
  return TIMELINE_STEPS.map((step, i) => ({
    step,
    // COMPLETED is an arrival, not a step still underway — mark it done.
    status: i < current || state === 'COMPLETED' ? 'done' : i === current ? 'current' : 'upcoming',
  }))
}

// Whether to OFFER the cancel button. The server is the authority and applies
// checks this cannot see (notably submit_attempted_at, which is not exposed on
// the transfer response) — so this only decides the affordance, and the 202 /
// 409 branches of classifyCancelResponse handle the server's real answer.
export function canRequestCancel(transfer: TrackedTransfer, nowMs: number): boolean {
  if (transfer.state !== 'FUNDED') return false
  if (!transfer.cancelableUntil) return false
  return new Date(transfer.cancelableUntil).getTime() > nowMs
}

// The answers POST /transfers/:id/cancel can give. `support` is the Reg E
// compliant 202: the request is accepted for out-of-band handling, never denied,
// and carries its own server-authored copy in both languages.
//
// `accepted` tracks whether the SERVER took the request (any 2xx), separately
// from whether we can render the result. That distinction is load-bearing for
// the idempotency key: the API stores the response under the key on any 2xx and
// replays it verbatim for 24 h (plugins/idempotency.ts), releasing the key only
// on a non-2xx. So a client that holds its key after a 2xx it merely failed to
// PARSE would replay that same stored response on every retry — locking the
// sender out of a cancellation right that may since have become exercisable.
// Clear on `accepted`, hold otherwise.
export type CancelOutcome =
  | { kind: 'refunded'; accepted: true; transfer: TrackedTransfer }
  | { kind: 'support'; accepted: true; messages: { en: string; es: string } | null }
  | { kind: 'error'; accepted: boolean; code: string | null }

export function classifyCancelResponse(status: number, body: unknown): CancelOutcome {
  if (status === 200) {
    // The refund happened server-side either way; an unreadable body only means
    // we can't show it from THIS response, so re-read rather than cry failure.
    return isTransferShape(body)
      ? { kind: 'refunded', accepted: true, transfer: body }
      : { kind: 'error', accepted: true, code: null }
  }
  if (status === 202) {
    // A 202 whose body we can't read still must not render as a failure — the
    // cancellation right WAS accepted. Null messages fall back to the mapped
    // cancellation_requires_support string, in the same neutral surface.
    return { kind: 'support', accepted: true, messages: parseCancellationRequiresSupport(body) }
  }
  return { kind: 'error', accepted: false, code: parseApiError(body)?.code ?? null }
}

function isMoney(v: unknown): boolean {
  return (
    typeof v === 'object' &&
    v !== null &&
    typeof (v as { amountMinor?: unknown }).amountMinor === 'number'
  )
}

const STATES: ReadonlySet<string> = new Set<TransferState>([
  ...TIMELINE_STEPS,
  'PAYMENT_FAILED',
  'CANCELED',
  'PAYOUT_FAILED',
  'REFUNDED',
  'FUNDING_REVERSED',
  'UNDER_REVIEW',
])

// Shape guard before we trust a 2xx body (same reasoning as isQuoteShape: a
// gateway 200 + HTML slipping past the proxy must not become a render-time
// TypeError). The state is checked against the known set too, so an unrecognized
// state can never fall through the timeline/outcome split as "in progress".
export function isTransferShape(body: unknown): body is TrackedTransfer {
  if (typeof body !== 'object' || body === null) return false
  const t = body as Record<string, unknown>
  return (
    typeof t.id === 'string' &&
    typeof t.state === 'string' &&
    STATES.has(t.state) &&
    typeof t.fxRate === 'string' &&
    // createdAt is consumed unconditionally by the history list (formatDate);
    // a missing/non-string value would render "Invalid Date" with no signal.
    typeof t.createdAt === 'string' &&
    isMoney(t.totalAmount) &&
    isMoney(t.sendAmount) &&
    isMoney(t.feeAmount) &&
    isMoney(t.receiveAmount)
  )
}
