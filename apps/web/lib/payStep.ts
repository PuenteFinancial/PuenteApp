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

/**
 * Which affordance the pay step renders. 'none' is a REAL state (prod mock =
 * deliberately inert, today's behavior), so anything unexpected must be
 * 'error' instead — silently rendering nothing on a live stripe send would
 * strand the sender with no way to pay.
 */
export type PayAffordance = 'stripe' | 'simulate' | 'offline' | 'submitted' | 'none' | 'error'

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
  if (session.provider === 'mock') {
    return canSimulate ? 'simulate' : 'none'
  }
  return 'error'
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
