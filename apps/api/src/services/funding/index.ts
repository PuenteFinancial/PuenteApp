import { env } from '../../config/env.js'
import { MockFundingProcessor } from './mock.js'
import { StripeFundingProcessor } from './stripe.js'

export type FundingEventType =
  | 'funding_succeeded'
  | 'funding_failed'
  | 'funding_cleared'
  | 'funding_reversed'

export interface FundingEvent {
  /** Processor-unique event id (Stripe: evt_…; mock: caller-supplied). */
  eventId: string
  type: FundingEventType
  /**
   * Our transfers.id, echoed back by the processor (Stripe: PaymentIntent
   * metadata; mock: payload field). Null when the processor payload cannot
   * carry the echo — Stripe's charge.dispute.created references only the
   * payment_intent — in which case the webhook route resolves the transfer
   * through the persisted transfers.funding_payment_ref instead.
   */
  transferRef: string | null
  /** Processor-side payment id (Stripe: payment_intent id; mock: mockpay_…). */
  paymentRef: string
  /** Failure / ACH return code on funding_failed | funding_reversed. */
  reason?: string
}

// A signed webhook body parses to exactly one of three things: an actionable
// funding event, a well-formed event outside our mapping (Stripe delivers
// whatever the endpoint subscribes to — e.g. payment_method.automatically_updated —
// and a 400 would put a legitimate delivery into a redelivery loop and count
// against endpoint health, so the route must ack these), or junk.
export type FundingParseResult =
  | { outcome: 'event'; event: FundingEvent }
  | { outcome: 'unhandled'; eventId: string; eventType: string }
  | { outcome: 'malformed' }

export interface FundingInitiation {
  provider: string
  method: 'ach'
  /** Persisted to transfers.funding_payment_ref. */
  paymentRef: string
  /** Processor-specific fields the client needs (Stripe: client_secret). */
  clientFields: Record<string, string>
}

// The result of a funding-undo op (slice 6). Persisted to
// transfers.refund_payment_ref (one undo path per transfer). `pending` is for a
// real async return (Stripe ACH refund); the mock void/refund is always
// `succeeded` (instant), which is what lets PR1's cancel run synchronously.
export interface FundingUndo {
  provider: string
  /** Processor-side undo id (Stripe: canceled PaymentIntent / Refund id; mock: mockvoid_… / mockrefund_…). */
  ref: string
  status: 'succeeded' | 'pending'
}

// The funding seam: initiation on confirm, plus the webhook-side verify +
// normalize. Implementations never throw from verifySignature or parseEvent;
// parseEvent classifies unusable payloads as malformed rather than throwing.
//
// TIMEOUT CONTRACT (debt pass 2026-07-29): every network-bound implementation
// MUST enforce its own bounded per-request timeout (Stripe adapter: the SDK's
// `timeout` option). CLAIM_STALE_AFTER_MS in services/refunds.ts (10 min) is
// derived assuming no in-flight processor call outlives its bound by minutes —
// an adapter with unbounded calls silently breaks that derivation and can make
// a LIVE refund read as an abandoned claim (a human gets paged to judge a
// disbursement that is still in flight). The mock is synchronous and trivially
// satisfies this.
export interface FundingProcessor {
  readonly provider: string
  /**
   * The (lowercase) request header carrying the webhook signature — the route
   * asks the processor instead of hardcoding it (mock: funding-signature;
   * Stripe: stripe-signature).
   */
  readonly signatureHeader: string
  /**
   * Whether this processor can actually run here: its secrets are present.
   * The route 503s the funding webhook and confirm gates on this — for the
   * mock that check IS the production lock (the mock secret is never set in
   * prod); for Stripe env.superRefine already refuses to boot a stripe
   * selection without keys, so this is belt-and-suspenders.
   */
  isConfigured(): boolean
  initiateFunding(input: {
    transferId: string
    userId: string
    totalAmountMinor: number
    currency: 'USD'
  }): Promise<FundingInitiation>
  verifySignature(rawBody: Buffer, signatureHeader: string): boolean
  parseEvent(rawBody: Buffer): FundingParseResult
  // The two funding-undo ops (slice 6), mirroring the initiateFunding seam.
  // Distinct money movements → distinct ledger batches: voidFunding cancels an
  // UNCLEARED pull (Stripe: cancel the PaymentIntent) so nothing ever settled —
  // the cancel-at-FUNDED path; refund returns COLLECTED funds (Stripe: create a
  // Refund) — the PAYOUT_FAILED→REFUNDED path. Both accept an idempotencyKey so
  // the slice-7 Stripe adapter drops in exactly-once without a signature change
  // (PR1 calls voidFunding; PR2 calls refund).
  voidFunding(input: {
    transferId: string
    paymentRef: string
    idempotencyKey: string
  }): Promise<FundingUndo>
  refund(input: {
    transferId: string
    paymentRef: string
    amountMinor: number
    currency: 'USD'
    idempotencyKey: string
  }): Promise<FundingUndo>
}

// No DI container in this codebase (services are plain modules, bridge.ts
// style) — a module-level factory on env is the established seam shape.
const processors: Record<typeof env.FUNDING_PROCESSOR, () => FundingProcessor> = {
  mock: () => new MockFundingProcessor(),
  stripe: () => new StripeFundingProcessor(),
}

let instance: FundingProcessor | undefined

export function getFundingProcessor(): FundingProcessor {
  instance ??= processors[env.FUNDING_PROCESSOR]()
  return instance
}
