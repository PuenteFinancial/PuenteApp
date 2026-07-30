import { env } from '../../config/env.js'
import { MockFundingProcessor } from './mock.js'
import { StripeFundingProcessor } from './stripe.js'

export type FundingEventType =
  | 'funding_succeeded'
  | 'funding_failed'
  | 'funding_cleared'
  | 'funding_reversed'
  // The undo tails (PR-S2): a refund ISSUED earlier (FundingUndo status
  // 'pending') later settled or bounced. Neither drives a state transition —
  // the transfer settled at REFUNDED when the undo was issued; these are the
  // money-truth record (payment_events, source 'funding') and, for
  // refund_failed, an ops page — the sender is STILL OWED after a bounce.
  | 'refund_failed'
  | 'refund_settled'

export interface FundingEvent {
  /** Processor-unique event id (Stripe: evt_…; mock: caller-supplied). */
  eventId: string
  type: FundingEventType
  /**
   * Our transfers.id, echoed back by the processor (Stripe: PaymentIntent —
   * and Refund — metadata; mock: payload field). Null when the processor
   * payload cannot carry the echo — Stripe's charge.dispute.created references
   * only the payment_intent — in which case the webhook route resolves the
   * transfer through the persisted transfers.funding_payment_ref instead.
   */
  transferRef: string | null
  /** Processor-side payment id (Stripe: payment_intent id; mock: mockpay_…). */
  paymentRef: string
  /**
   * The undo object the event is about, on refund_failed | refund_settled
   * (Stripe: Refund id re_…; mock: payload undo_ref). Distinct from paymentRef
   * so the page/audit trail names the exact disbursement that bounced.
   */
  undoRef?: string
  /** Failure / ACH return code on funding_failed | funding_reversed | refund_failed. */
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
//
// `mode` (PR-S2) is HOW the sender was made whole, and it decides the ledger:
//   voided   — the uncleared pull was CANCELED; the sender is never debited,
//              no cash moves, and the FUNDED receivable must be REVERSED.
//   refunded — collected funds go back via a real disbursement (Stripe Refund);
//              cash leaves cash_clearing and the receivable settles on its own
//              ACH-clearing leg.
// Posting the wrong batch for the mode books cash that never moved — see
// voidRefundLedgerEntries / correctionVoidLedgerEntries in services/transfers.ts.
export interface FundingUndo {
  provider: string
  /** Processor-side undo id (Stripe: canceled PaymentIntent / Refund id; mock: mockvoid_… / mockrefund_…). */
  ref: string
  status: 'succeeded' | 'pending'
  mode: 'voided' | 'refunded'
}

/**
 * Recover a persisted undo's mode from its ref alone — the crash-recovery
 * counterpart to FundingUndo.mode. The `already_disbursed` replay paths
 * (services/refunds.ts, services/cancellation-review.ts) reach the REFUNDED
 * transition holding nothing but transfers.refund_payment_ref, and the ledger
 * batch they post depends on the mode, so the ref namespace IS the durable
 * encoding (documented on FundingUndo.ref since slice 6).
 *
 * Module-level rather than a processor method on purpose: refs OUTLIVE the
 * processor selection (a staging row voided under mock must still classify
 * after FUNDING_PROCESSOR flips to stripe), so this knows every namespace.
 * Unknown prefixes classify as 'refunded' — the pre-S2 posting, and the arm
 * whose books recon can catch (an uncollected receivable ages visibly; a
 * silently reversed one vanishes).
 */
export function undoModeForRef(ref: string): 'voided' | 'refunded' {
  if (ref.startsWith('pi_') || ref.startsWith('mockvoid_')) return 'voided'
  return 'refunded'
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
  // the Stripe adapter dedupes exactly-once without a signature change.
  //
  // NEITHER op promises its nominal mode (PR-S2): settlement decides. The
  // Stripe adapter resolves the LIVE PaymentIntent — an uncleared pull can only
  // be voided (Stripe forbids refunding an unsettled ACH charge, and a refund
  // beside a late dispute double-credits), a settled one can only be refunded —
  // so voidFunding falls back to a refund when the PI settled first, and refund
  // falls back to a void while the PI is still processing. Callers learn which
  // arm ran from FundingUndo.mode (or undoModeForRef on the persisted ref) and
  // MUST post the matching ledger batch.
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
