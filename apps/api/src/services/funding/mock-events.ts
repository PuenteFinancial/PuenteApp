import crypto from 'node:crypto'
// TYPE-ONLY on purpose: a type import is erased at compile time, so this module
// pulls in NO runtime dependency — notably not ./index.js → config/env.js, which
// validates the entire server env and would exit(1). That keeps
// scripts/fire-funding-webhook.ts runnable with nothing but the webhook secret
// (its whole point: point it at localhost or staging and go).
import type { FundingEventType } from './index.js'

export interface SignedFundingEvent {
  /** Exact bytes to POST. The signature covers this string verbatim — re-serializing it invalidates the HMAC. */
  body: string
  /** Value for the `Funding-Signature` request header. */
  signature: string
}

// Builds and signs a mock funding event in exactly the shape
// MockFundingProcessor.verifySignature + parseEvent expect: header
// `t=<ms>,v1=<hex>` where v1 = HMAC-SHA256(secret, "<t>.<body>").
//
// Extracted from fire-funding-webhook.ts so the dev simulate-funding endpoint
// (slice 7 PR3) and the script drive the funding webhook through the SAME
// signer — one definition of the wire format, so the two can never drift and
// leave the endpoint silently signing events the route rejects.
export function buildMockFundingEvent(input: {
  transferId: string
  type: FundingEventType
  secret: string
  /** Echo the transfer's real funding_payment_ref (as Stripe would echo its PaymentIntent id); a fresh mock ref when unknown. */
  paymentRef?: string
  /** Failure / ACH return code — only meaningful on funding_failed | funding_reversed. */
  reason?: string
  /** Overridable for deterministic tests; defaults to a fresh event id. */
  eventId?: string
  /** Overridable for deterministic tests; defaults to now. Mock verification rejects a skew over 5 min. */
  timestamp?: number
}): SignedFundingEvent {
  const {
    transferId,
    type,
    secret,
    paymentRef,
    reason,
    eventId = `evt_${crypto.randomUUID()}`,
    timestamp = Date.now(),
  } = input

  const body = JSON.stringify({
    id: eventId,
    type,
    data: {
      transfer_id: transferId,
      payment_ref: paymentRef ?? `mockpay_${crypto.randomUUID()}`,
      ...(reason && { reason }),
    },
  })

  const v1 = crypto.createHmac('sha256', secret).update(`${timestamp}.${body}`).digest('hex')

  return { body, signature: `t=${timestamp},v1=${v1}` }
}
