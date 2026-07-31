// Pure decision logic for the PENDING_PAYMENT pay step (PayStep.tsx), split
// out for unit tests — same convention as transferState.ts ← TransferTracker.

/** Wire shape of GET /api/transfers/:id/funding-session. */
export interface FundingSession {
  provider: string
  clientSecret?: string
  publishableKey?: string
}

export function isFundingSessionShape(body: unknown): body is FundingSession {
  if (typeof body !== 'object' || body === null) return false
  const b = body as Record<string, unknown>
  if (typeof b.provider !== 'string') return false
  if (b.clientSecret !== undefined && typeof b.clientSecret !== 'string') return false
  if (b.publishableKey !== undefined && typeof b.publishableKey !== 'string') return false
  return true
}

/**
 * Which affordance the pay step renders. 'none' is a REAL state (prod mock =
 * deliberately inert, today's behavior), so anything unexpected must be
 * 'error' instead — silently rendering nothing on a live stripe send would
 * strand the sender with no way to pay.
 */
export type PayAffordance = 'stripe' | 'simulate' | 'none' | 'error'

export function payAffordanceFor(session: FundingSession, canSimulate: boolean): PayAffordance {
  if (session.provider === 'stripe') {
    return session.clientSecret && session.publishableKey ? 'stripe' : 'error'
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
