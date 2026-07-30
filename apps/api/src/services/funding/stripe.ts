import Stripe from 'stripe'
import { env } from '../../config/env.js'
import type {
  FundingEventType,
  FundingInitiation,
  FundingParseResult,
  FundingProcessor,
  FundingUndo,
} from './index.js'

// Locked event mapping (plan 2026-07-29, decisions.md "FUNDED on
// payment_intent.processing"): ACH is delayed-notification — the PI enters
// `processing` when the debit is submitted, and `succeeded` only at settlement
// (T+4 std). Instant-front means `processing` IS our funding_succeeded
// (drives FUNDED + payout submission); `succeeded` is the later
// funding_cleared flag. A pre-settlement return surfaces as
// payment_intent.payment_failed; a post-settlement return arrives as
// charge.dispute.created (handled in parseEvent below).
const PI_EVENT_MAP = new Map<string, FundingEventType>([
  ['payment_intent.processing', 'funding_succeeded'],
  ['payment_intent.succeeded', 'funding_cleared'],
  ['payment_intent.payment_failed', 'funding_failed'],
])

export class StripeFundingProcessor implements FundingProcessor {
  readonly provider = 'stripe'
  readonly signatureHeader = 'stripe-signature'
  private readonly client: Stripe

  constructor(client?: Stripe) {
    if (!client && !env.STRIPE_SECRET_KEY) {
      // Unreachable when selected via FUNDING_PROCESSOR (env.superRefine
      // refuses to boot that config) — this guards direct construction.
      throw new Error('StripeFundingProcessor requires STRIPE_SECRET_KEY')
    }
    this.client =
      client ??
      new Stripe(env.STRIPE_SECRET_KEY!, {
        // TIMEOUT CONTRACT (funding/index.ts): every processor call must be
        // bounded. Same knob shape as BRIDGE_TIMEOUT_SECONDS; with the SDK's
        // idempotent retries the worst case is ~(retries+1)×timeout — minutes
        // under the 10-min CLAIM_STALE_AFTER_MS derivation in refunds.ts.
        timeout: env.STRIPE_TIMEOUT_SECONDS * 1000,
        maxNetworkRetries: 2,
      })
  }

  isConfigured(): boolean {
    return Boolean(env.STRIPE_SECRET_KEY && env.STRIPE_WEBHOOK_SECRET)
  }

  async initiateFunding(input: {
    transferId: string
    userId: string
    totalAmountMinor: number
    currency: 'USD'
  }): Promise<FundingInitiation> {
    // metadata.transfer_id is the routing echo (locked decision: sender→
    // recipient routing lives on the transfers row, never in money-following;
    // the PI carries only the join key — no user id, no PII). The idempotency
    // key is derived from the transfer: one PaymentIntent per transfer, ever —
    // the DB-side funding_payment_ref null-gate is the primary guarantee, and
    // the Stripe key closes the crash-between-create-and-persist window
    // (24h key TTL ≫ the 30-min PENDING_PAYMENT lifetime).
    const intent = await this.client.paymentIntents.create(
      {
        amount: input.totalAmountMinor,
        currency: 'usd',
        payment_method_types: ['us_bank_account'],
        payment_method_options: {
          // Instant-only verification (locked decision 3): microdeposits are
          // deferred — they collide with the 30-min PENDING_PAYMENT auto-fail
          // and the FX rate lock. The Payment Element (PR-S3) surfaces a clean
          // error for unsupported banks.
          us_bank_account: { verification_method: 'instant' },
        },
        metadata: { transfer_id: input.transferId },
      },
      { idempotencyKey: `funding_init_${input.transferId}` },
    )
    if (!intent.client_secret) {
      throw new Error('Stripe PaymentIntent created without a client_secret')
    }
    return {
      provider: this.provider,
      method: 'ach',
      paymentRef: intent.id,
      clientFields: { client_secret: intent.client_secret },
    }
  }

  verifySignature(rawBody: Buffer, signatureHeader: string): boolean {
    const secret = env.STRIPE_WEBHOOK_SECRET
    if (!secret || !signatureHeader) return false
    try {
      // constructEvent = parse + HMAC verify + 300s timestamp tolerance; the
      // parsed result is discarded here — the route calls parseEvent on the
      // same raw bytes after this gate passes.
      this.client.webhooks.constructEvent(rawBody, signatureHeader, secret)
      return true
    } catch {
      return false
    }
  }

  parseEvent(rawBody: Buffer): FundingParseResult {
    let envelope: {
      id?: unknown
      type?: unknown
      data?: { object?: Record<string, unknown> }
    }
    try {
      envelope = JSON.parse(rawBody.toString('utf8')) as typeof envelope
    } catch {
      return { outcome: 'malformed' }
    }
    if (typeof envelope.id !== 'string' || typeof envelope.type !== 'string') {
      return { outcome: 'malformed' }
    }
    const unhandled = {
      outcome: 'unhandled',
      eventId: envelope.id,
      eventType: envelope.type,
    } as const
    const object = envelope.data?.object

    const piEventType = PI_EVENT_MAP.get(envelope.type)
    if (piEventType) {
      if (!object || typeof object['id'] !== 'string') return { outcome: 'malformed' }
      const metadata = object['metadata'] as Record<string, unknown> | null | undefined
      const transferRef = metadata?.['transfer_id']
      if (typeof transferRef !== 'string' || transferRef === '') {
        // Signed, well-formed, but not a PI we created (no transfer echo) —
        // ack rather than 400 into a redelivery loop.
        return unhandled
      }
      const lastError = object['last_payment_error'] as Record<string, unknown> | null | undefined
      // ACH return/decline detail: Stripe puts the specific cause in
      // decline_code when present, generic cause in code. Pass through
      // whichever exists; exact sandbox values get pinned in PR-S4's e2e.
      const reason = lastError?.['decline_code'] ?? lastError?.['code']
      return {
        outcome: 'event',
        event: {
          eventId: envelope.id,
          type: piEventType,
          transferRef,
          paymentRef: object['id'],
          ...(piEventType === 'funding_failed' &&
            typeof reason === 'string' && { reason }),
        },
      }
    }

    if (envelope.type === 'charge.dispute.created') {
      // Post-settlement ACH return (insufficient_funds / incorrect_account_details /
      // bank_cannot_process). The Dispute payload carries no metadata echo —
      // only the payment_intent id — so transferRef is null and the route
      // resolves the transfer via transfers.funding_payment_ref.
      if (!object) return { outcome: 'malformed' }
      const paymentIntent = object['payment_intent']
      if (typeof paymentIntent !== 'string' || paymentIntent === '') {
        // A dispute we can't join to a funding PI (e.g. a non-PI charge on a
        // shared account) — nothing to act on; ack with the log marker.
        return unhandled
      }
      const reason = object['reason']
      return {
        outcome: 'event',
        event: {
          eventId: envelope.id,
          type: 'funding_reversed',
          transferRef: null,
          paymentRef: paymentIntent,
          ...(typeof reason === 'string' && { reason }),
        },
      }
    }

    // Everything else — including payment_method.automatically_updated (bank
    // account replaced/blocked after a return): with no saved payment methods
    // at pilot (fresh PI + mandate per send) there is nothing to act on, but
    // the route logs the type so ops sees the signal. Revisit with
    // SetupIntents/saved accounts.
    return unhandled
  }

  async voidFunding(): Promise<FundingUndo> {
    // PR-S2 implements undo reality: paymentIntents.cancel — ACH is the one
    // method cancelable during `processing` (docs.stripe.com/refunds). A loud
    // failure beats minting a fake ref into refund_payment_ref.
    throw new Error('StripeFundingProcessor.voidFunding arrives in PR-S2 — not implemented')
  }

  async refund(): Promise<FundingUndo> {
    // PR-S2: refunds.create with status:'pending' + refund.failed/updated
    // webhook tails, settlement-aware guard (void before `succeeded`, never
    // refund — refund + late dispute = double credit).
    throw new Error('StripeFundingProcessor.refund arrives in PR-S2 — not implemented')
  }
}
