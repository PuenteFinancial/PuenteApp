import { env } from '../../config/env.js'
import { MockFundingProcessor } from './mock.js'
import { StripeFundingProcessor } from './stripe.js'
import { ManualFundingProcessor } from './manual.js'
import { StripeOnrampFundingProcessor } from './stripe-onramp.js'
import { StripeCryptoFundingProcessor } from './stripe-crypto.js'

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
  /**
   * The amount the processor says was (or is being) delivered, in USDC
   * MICRO-units (6 dp — USDC's native precision), onramp only (#213 guard): the
   * widget's amount field is user-EDITABLE (no API lock exists), so FUNDED
   * must never release on the event's say-so alone — the appliers verify this
   * against the transfer's send+fee to the cent. Absent on processors whose
   * amounts are server-fixed (PI, mock) and on events that carry no delivery.
   */
  deliveredAmountMicro?: number
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
  /** How the sender pays: 'ach' pulls USD; 'onramp' is a Stripe crypto onramp
   *  widget session (card / Apple Pay / ACH inside Stripe's UI, USDC delivered
   *  to the treasury). */
  method: 'ach' | 'onramp'
  /** Persisted to transfers.funding_payment_ref. */
  paymentRef: string
  /** Processor-specific fields the client needs (Stripe: client_secret). */
  clientFields: Record<string, string>
}

// Moved to errors.ts: a leaf module so processor files can import it by
// value without creating a cycle back through index.ts (see errors.ts).
export { FundingInitiationError } from './errors.js'

// What the browser needs to bootstrap the pay step (PR-S3). Served on demand
// by GET /v1/transfers/:id/funding-session — once per pay-step mount, never on
// the tracker poll. `fields` is wire-shaped camelCase and goes to the client
// verbatim (stripe: { clientSecret, publishableKey }; mock: {} — the web falls
// back to the simulate affordance on provider alone). The client_secret is
// retrieved from the processor live each time, never persisted or logged.
export interface FundingClientSession {
  provider: string
  fields: Record<string, string>
}

// ── Reconciliation reads (slice-8 O2) ───────────────────────────────────────
// Read-only inputs for the daily ledger.reconcile cron. OPTIONAL on the seam:
// the mock has no external truth to reconcile against, so it simply doesn't
// implement them and the recon checks report themselves `skipped` — no mock
// theater, no pretend findings.

export interface FundingPaymentStatus {
  paymentRef: string
  /** Raw processor status (Stripe PI: requires_*, processing, succeeded,
   *  canceled…; onramp session: initialized, requires_payment, rejected,
   *  fulfillment_*). */
  status: string
  /** Machine-readable failure detail when the processor exposes one (onramp:
   *  transaction_details.last_error, e.g. kyc_verification_failed). Optional —
   *  the PI adapter has no equivalent field. */
  lastError?: string
}

export interface FundingPaymentListItem {
  paymentRef: string
  /** Our transfers.id echoed in processor metadata; null = orphan candidate. */
  transferRef: string | null
  status: string
  createdAt: string
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
 * Whether a provider is an onramp-SESSION rail — the two rails whose funding
 * events carry a delivered-USDC amount and must route through the amount
 * guard + float top-up appliers (applyOnrampFunded / applyOnrampSettlement)
 * instead of the plain funding appliers. The webhook route branches on THIS,
 * not on a provider string: when the embedded rail (K4) joined, a literal
 * 'stripe_onramp' comparison would have silently routed its events past the
 * amount guard the rail exists to enforce.
 */
export function isOnrampSessionRail(provider: string): boolean {
  return provider === 'stripe_onramp' || provider === 'stripe_crypto'
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
 * silently reversed one vanishes). `manualrefund_` (out-of-band funding) relies
 * on exactly that default and is correct there: manual funds are COLLECTED
 * before the transfer is ever marked funded, so an undo is always a real
 * disbursement back, never a voided pull.
 */
export function undoModeForRef(ref: string): 'voided' | 'refunded' {
  if (ref.startsWith('pi_') || ref.startsWith('mockvoid_')) return 'voided'
  return 'refunded'
}

/**
 * Whether an undo still needs a HUMAN to move money — the same ref-namespace
 * encoding as undoModeForRef, and durable for the same reason (the resume path
 * reaches here holding nothing but transfers.refund_payment_ref).
 *
 * The distinction is NOT "is it settled yet". A Stripe ACH refund is unsettled
 * for days, but it was genuinely ISSUED — the disbursement is in flight and the
 * sender's copy ("issued, may take a few business days") is true. An
 * out-of-band undo has issued nothing at all: the funds were collected on a
 * rail we don't operate, and until an operator sends them back by hand the
 * sender has not been made whole. Only that case may not settle to REFUNDED.
 *
 * Unknown prefixes return false — the pre-existing behavior for every processor
 * that can actually disburse, so this narrows nothing that already worked.
 *
 * `onramprefund_` (#213) is here for the same reason as `manualrefund_`:
 * Stripe's onramp has no refund API — confirmed transactions are irreversible
 * on their side and the USDC is already in the treasury — so making the sender
 * whole is always a human moving money by hand.
 */
export function undoRequiresManualDisbursement(ref: string): boolean {
  return ref.startsWith('manualrefund_') || ref.startsWith('onramprefund_')
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
   * K4 (embedded onramp): true = confirm must NOT call initiateFunding or
   * persist a funding_payment_ref — the processor's payment object can only
   * be created later, at the pay step, with client-side material (the SDK's
   * payment token). The transfer sits PENDING_PAYMENT with a null ref until
   * then, which the existing null-ref abandonment sweep already handles.
   */
  readonly deferredInitiation?: boolean
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
    /** Real client IP forwarded by the web proxy (#213) — the onramp adapter
     *  passes it to Stripe's supportability pre-check; others ignore it. */
    clientIp?: string
    /** KYC prefill for the onramp widget (#213) — name/email only, never SSN.
     *  Optional fields because users rows predate profile completion. */
    customer?: { firstName?: string; lastName?: string; email?: string }
  }): Promise<FundingInitiation>
  verifySignature(rawBody: Buffer, signatureHeader: string): boolean
  parseEvent(rawBody: Buffer): FundingParseResult
  /**
   * Pay-step bootstrap (PR-S3): resolve the client-side fields for an
   * already-initiated funding attempt. Read-only — must not create or mutate
   * processor objects. Stripe retrieves the LIVE PaymentIntent by paymentRef
   * (bounded by the SDK timeout like every other call); mock returns no fields.
   */
  getClientSession(input: { paymentRef: string }): Promise<FundingClientSession>
  /**
   * Deferred rails only (K5): the pay-step bootstrap for a transfer that has
   * NO payment object yet — a null funding_payment_ref is the NORMAL state
   * between confirm and the SDK's payment-token mint, not the crash window it
   * is for eager rails. Returns what the browser needs to initialize the
   * client SDK (the publishable key — deliberately served here, not via a
   * NEXT_PUBLIC_ env; see docs/decisions.md). Synchronous and secret-free.
   */
  getDeferredClientBootstrap?(): FundingClientSession
  /**
   * Reconciliation reads (slice-8 O2, both OPTIONAL — see the interface note):
   * the live status of one payment, and the newest payments on the account
   * (orphan detection). Read-only; never create or mutate processor objects.
   * A full page from listRecentPayments means TRUNCATED, not "everything".
   */
  getPaymentStatus?(input: { paymentRef: string }): Promise<FundingPaymentStatus>
  listRecentPayments?(input: { createdAfter: Date; limit: number }): Promise<FundingPaymentListItem[]>
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
  manual: () => new ManualFundingProcessor(),
  stripe_onramp: () => new StripeOnrampFundingProcessor(),
  stripe_crypto: () => new StripeCryptoFundingProcessor(),
}

let instance: FundingProcessor | undefined

export function getFundingProcessor(): FundingProcessor {
  instance ??= processors[env.FUNDING_PROCESSOR]()
  return instance
}
