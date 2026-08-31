// Pure decision logic for the PENDING_PAYMENT pay step (PayStep.tsx), split
// out for unit tests — same convention as transferState.ts ← TransferTracker.

/** Out-of-band deposit coordinates (#199, manual only) — rendered verbatim. */
export interface DepositInstructions {
  amountMinor: number
  currency: string
  paymentRail: string
  bankName: string
  bankRoutingNumber: string
  bankAccountNumber: string
  bankBeneficiaryName?: string
  /** The reference code Bridge matches the deposit by — the load-bearing field. */
  depositMessage: string
}

/** Wire shape of GET /api/transfers/:id/funding-session. */
export interface FundingSession {
  provider: string
  clientSecret?: string
  publishableKey?: string
  /** stripe_crypto only: the treasury address the SDK must register before a
   *  session can be created (Stripe refuses a raw address on headless). */
  walletAddress?: string
  /** Live PI status (stripe only) — drives the reload-after-pay branch. */
  status?: string
  /** Validated at RENDER time (isDepositInstructionsShape), not here — a
   *  malformed object must degrade to the fallback copy, not to the error
   *  card, so it is typed as unknown until the component proves it. */
  depositInstructions?: unknown
}

// Every field the panel renders must be present and well-typed, or the whole
// object is dropped: partial coordinates are worse than the fallback copy,
// because a sender might wire money against them.
export function isDepositInstructionsShape(value: unknown): value is DepositInstructions {
  if (typeof value !== 'object' || value === null) return false
  const v = value as Record<string, unknown>
  return (
    typeof v.amountMinor === 'number' &&
    Number.isInteger(v.amountMinor) &&
    v.amountMinor > 0 &&
    typeof v.currency === 'string' &&
    typeof v.paymentRail === 'string' &&
    typeof v.bankName === 'string' &&
    typeof v.bankRoutingNumber === 'string' &&
    typeof v.bankAccountNumber === 'string' &&
    (v.bankBeneficiaryName === undefined || typeof v.bankBeneficiaryName === 'string') &&
    typeof v.depositMessage === 'string' &&
    v.depositMessage !== ''
  )
}

export function isFundingSessionShape(body: unknown): body is FundingSession {
  if (typeof body !== 'object' || body === null) return false
  const b = body as Record<string, unknown>
  if (typeof b.provider !== 'string') return false
  if (b.clientSecret !== undefined && typeof b.clientSecret !== 'string') return false
  if (b.publishableKey !== undefined && typeof b.publishableKey !== 'string') return false
  if (b.walletAddress !== undefined && typeof b.walletAddress !== 'string') return false
  if (b.status !== undefined && typeof b.status !== 'string') return false
  // depositInstructions is deliberately NOT validated here: the offline panel
  // works without it, so a malformed object degrades to the fallback copy
  // (checked at render) rather than failing the whole session into the
  // retry-error card.
  return true
}

// PI statuses where confirmPayment can still meaningfully run. Anything past
// these (processing, succeeded) means the sender already paid — a reload must
// show "submitted", not re-offer the form (the transfer stays PENDING_PAYMENT
// until the processing webhook lands, so transfer state can't make this call).
const PAYABLE_PI_STATUSES = new Set([
  'requires_payment_method',
  'requires_confirmation',
  'requires_action',
])

// Onramp session statuses where the sender already completed payment inside
// Stripe's widget — a reload/second tab must show "submitted", not remount a
// widget for a session past requires_payment (the transfer stays
// PENDING_PAYMENT until the fulfillment_processing webhook lands, so transfer
// state can't make this call — the PI rail's PAYABLE_PI_STATUSES reasoning).
const ONRAMP_PAID_STATUSES = new Set(['fulfillment_processing', 'fulfillment_complete'])

/**
 * Which affordance the pay step renders. 'none' is a REAL state (prod mock =
 * deliberately inert, today's behavior), so anything unexpected must be
 * 'error' instead — silently rendering nothing on a live stripe send would
 * strand the sender with no way to pay.
 */
export type PayAffordance =
  | 'stripe'
  | 'onramp'
  | 'crypto'
  | 'simulate'
  | 'offline'
  | 'submitted'
  | 'none'
  | 'error'

export function payAffordanceFor(session: FundingSession, canSimulate: boolean): PayAffordance {
  // Out-of-band funding: the sender pays by a rail we don't operate, so there
  // is nothing to click. This is a REAL affordance, not 'none' — the sender
  // must see that we're waiting on their deposit rather than a blank panel
  // that reads as a broken page. It never depends on canSimulate: the dev
  // endpoint is off in every environment that uses this processor.
  if (session.provider === 'manual') return 'offline'
  if (session.provider === 'stripe') {
    if (!session.clientSecret || !session.publishableKey) return 'error'
    // No status (older API) = payable — the pre-status behavior. processing/
    // succeeded = already paid, show submitted. canceled or anything unknown =
    // error: never a payable form for a dead PI.
    if (session.status === undefined || PAYABLE_PI_STATUSES.has(session.status)) return 'stripe'
    if (session.status === 'processing' || session.status === 'succeeded') return 'submitted'
    return 'error'
  }
  if (session.provider === 'stripe_onramp') {
    if (!session.clientSecret || !session.publishableKey) return 'error'
    if (session.status !== undefined && ONRAMP_PAID_STATUSES.has(session.status)) {
      return 'submitted'
    }
    // rejected = a dead session (KYC/sanctions/fraud refusal): the webhook is
    // driving the transfer to PAYMENT_FAILED, so never remount a widget for
    // it — the error card holds until the tracker's banner takes over.
    if (session.status === 'rejected') return 'error'
    // initialized / requires_payment / anything this preview API grows later:
    // mount the widget — unlike a PI (where an unknown status means a dead
    // form), the widget renders the session's own live state, so showing it
    // is safe and stranding the sender behind an error card is not.
    return 'onramp'
  }
  if (session.provider === 'stripe_crypto') {
    // Embedded rail (K5): the deferred bootstrap carries no clientSecret —
    // only the publishable key the SDK initializes with. Session status rides
    // along when a live read resolved (reload after an attempt): paid
    // statuses show submitted, a rejected session shows the error card until
    // the tracker's PAYMENT_FAILED banner takes over (the reconcile poll is
    // driving that transition), and anything else starts the machine fresh —
    // sessions are never resumed, so "fresh" is always a safe landing.
    // Both are required to run the flow: the key initializes the SDK, and
    // the treasury address must be registered before any session create.
    if (!session.publishableKey || !session.walletAddress) return 'error'
    if (session.status !== undefined && ONRAMP_PAID_STATUSES.has(session.status)) {
      return 'submitted'
    }
    if (session.status === 'rejected') return 'error'
    return 'crypto'
  }
  if (session.provider === 'mock') {
    return canSimulate ? 'simulate' : 'none'
  }
  return 'error'
}

/**
 * Whether PayStep should keep refetching the funding session. True only for a
 * manual-rail session still missing (or carrying malformed) deposit
 * coordinates: the auto-onramp attaches them seconds AFTER confirm, so the
 * mount-time fetch races the worker and can lose (seen live 2026-08-21 — the
 * sender's pay step never showed the auto-attached coordinates without a full
 * reload). Never true for stripe: refetching there risks remounting a live
 * Payment Element, which is exactly what the one-shot fetch protects against.
 */
export function shouldRefetchSession(session: FundingSession | null): boolean {
  if (!session || session.provider !== 'manual') return false
  return !isDepositInstructionsShape(session.depositInstructions)
}

/**
 * How to surface a stripe.confirmPayment error. Stripe authors (and localizes,
 * per the Element's `locale`) the user-actionable messages — bank refusals,
 * incomplete forms — so those render inline and the Element stays mounted for
 * another attempt. Everything else gets Puente's generic retryable copy.
 */
export type PayErrorKind = 'inline' | 'retryable'

export function classifyConfirmPaymentError(err: {
  type?: string
  message?: string
  code?: string
}): PayErrorKind {
  return err.type === 'card_error' || err.type === 'validation_error' ? 'inline' : 'retryable'
}
