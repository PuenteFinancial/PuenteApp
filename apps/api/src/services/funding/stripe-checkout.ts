import type Stripe from 'stripe'
import { env } from '../../config/env.js'
import { StripeFundingProcessor } from './stripe.js'
import type {
  FundingClientSession,
  FundingInitiation,
  FundingParseResult,
  FundingPaymentStatus,
  FundingUndo,
} from './index.js'

// Checkout Sessions rail (C1 — docs/prds/checkout-sessions-rail.md).
//
// Same money machinery as the Payment Intents rail, a different object in
// front of it: a Checkout Session drives OUR Payment Element instead of us
// driving a PaymentIntent directly. Stripe's own docs now recommend this over
// Payment Intents ("don't use the Payment Intent API unless the user
// explicitly asks, because it requires significantly more code"), and the
// reason it matters here is narrower than that: WHICH PAYMENT METHODS a sender
// is offered becomes Dashboard configuration instead of a hard-coded
// `payment_method_types` array that needs a deploy to change.
//
// EXTENDS the PI rail rather than copying it. Everything after the sender pays
// is identical — the settlement-aware void/refund dance, the cancel-refused
// re-resolution, signature verification — and that logic is the most
// load-bearing code in either adapter. What this class overrides is the four
// places a Session is not a PaymentIntent:
//
//   initiateFunding   creates a Session, not a PI
//   getClientSession  reads the Session's client_secret
//   parseEvent        checkout.session.* events, not payment_intent.*
//   void / refund     resolve Session → PaymentIntent, then delegate to super
//
// Eager initiation, like the PI rail and unlike the embedded crypto rail: a
// Session needs nothing from the browser, so confirm can create it and persist
// the ref. No `deferredInitiation`.
//
// `funding_payment_ref` holds the SESSION id (`cs_…`), not the PaymentIntent.
// The Session is the object that exists from confirm onward; the PI does not
// exist until the sender pays. Storing the thing that is always there keeps the
// null-ref abandonment sweep meaning what it already means.

// One line item, priced ad hoc. No Product object: the "product" is a single
// transfer that will never be sold twice, and a Product per transfer would be
// litter in the Dashboard.
const LINE_ITEM_NAME = 'Puente transfer'

export class StripeCheckoutFundingProcessor extends StripeFundingProcessor {
  override readonly provider = 'stripe_checkout'
  // Bridge is the sole verifier here: a card or bank charge needs no identity
  // check of Stripe's, so no `stripe_kyc_tier` is ever written and the pay
  // step runs the Bridge leg itself (C3).
  override readonly identityFlow = 'bridge_only' as const

  override isConfigured(): boolean {
    return Boolean(
      env.STRIPE_SECRET_KEY &&
        env.STRIPE_WEBHOOK_SECRET &&
        env.STRIPE_PUBLISHABLE_KEY &&
        env.CHECKOUT_RETURN_URL_BASE,
    )
  }

  override async initiateFunding(input: {
    transferId: string
    userId: string
    totalAmountMinor: number
    currency: 'USD'
    clientIp?: string
    customer?: { firstName?: string; lastName?: string; email?: string }
  }): Promise<FundingInitiation> {
    const session = await this.client.checkout.sessions.create(
      {
        ui_mode: 'elements',
        mode: 'payment',
        // Stripe requires one even in elements mode, where the sender never
        // leaves our page. It is only reached if a payment method redirects
        // away and comes back (3DS, some wallets).
        return_url: `${env.CHECKOUT_RETURN_URL_BASE}?session_id={CHECKOUT_SESSION_ID}`,
        line_items: [
          {
            quantity: 1,
            price_data: {
              currency: 'usd',
              unit_amount: input.totalAmountMinor,
              product_data: { name: LINE_ITEM_NAME },
            },
          },
        ],
        payment_method_options: {
          us_bank_account: {
            // INSTANT ONLY, deliberately — the same call the PI rail makes and
            // for the same reason. Micro-deposits take 1–2 business days to
            // arrive and up to 10 to verify, which outlives both the
            // PENDING_PAYMENT abandonment clock and the quote's FX window. A
            // sender whose bank cannot do instant gets a clean refusal rather
            // than a transfer that quietly rots.
            verification_method: 'instant',
          },
        },
        // The routing echo, matching the PI rail exactly: the join key and
        // nothing else. No user id, no PII — money-following never carries
        // sender→recipient routing (that lives on the transfers row).
        metadata: { transfer_id: input.transferId },
        // The SAME echo on the PaymentIntent the Session creates. Not
        // redundant: clearing and post-settlement failure arrive as
        // payment_intent.* events, which carry the Session's metadata only if
        // we put it there. Without this the parent class's parser would see a
        // PI it cannot join to a transfer and ack it as unhandled — and a card
        // transfer would never clear. See the note on checkoutEventType.
        payment_intent_data: { metadata: { transfer_id: input.transferId } },
        // Prefill only. Stripe validates it, and the sender can still change
        // it in the Contact Details element.
        ...(input.customer?.email && { customer_email: input.customer.email }),
      },
      // One Session per transfer, ever. Same derivation as the PI rail: the
      // DB-side null-gate on funding_payment_ref is the primary guarantee and
      // this closes the crash-between-create-and-persist window.
      { idempotencyKey: `checkout_init_${input.transferId}` },
    )

    if (!session.id) throw new Error('Stripe Checkout Session created without an id')
    if (!session.client_secret) {
      // Without it the Payment Element cannot mount, so the sender would reach
      // a dead pay step. Fail at creation instead of at their screen.
      throw new Error('Stripe Checkout Session created without a client_secret')
    }

    return {
      provider: this.provider,
      method: 'ach',
      paymentRef: session.id,
    }
  }

  override async getClientSession(input: { paymentRef: string }): Promise<FundingClientSession> {
    // Same posture as the PI rail: the client_secret is never persisted on our
    // side. Retrieved live, once per pay-step mount, and Stripe stays the only
    // store of the credential.
    const session = await this.client.checkout.sessions.retrieve(input.paymentRef)
    if (!session.client_secret) {
      throw new Error('Stripe Checkout Session retrieved without a client_secret')
    }
    return {
      provider: this.provider,
      fields: {
        clientSecret: session.client_secret,
        publishableKey: env.STRIPE_PUBLISHABLE_KEY!,
        // Session status (open / complete / expired) plus payment_status, so a
        // reload after confirm renders the submitted banner instead of
        // re-offering a form that can no longer be confirmed. Two fields
        // because they answer different questions: whether the SESSION is
        // still usable, and whether MONEY has settled.
        status: session.status ?? 'unknown',
        paymentStatus: session.payment_status ?? 'unknown',
      },
    }
  }

  override parseEvent(rawBody: Buffer): FundingParseResult {
    let envelope: { id?: unknown; type?: unknown; data?: { object?: Record<string, unknown> } }
    try {
      envelope = JSON.parse(rawBody.toString('utf8')) as typeof envelope
    } catch {
      return { outcome: 'malformed' }
    }
    if (typeof envelope.id !== 'string' || typeof envelope.type !== 'string') {
      return { outcome: 'malformed' }
    }
    const unhandled = { outcome: 'unhandled', eventId: envelope.id, eventType: envelope.type } as const
    const object = envelope.data?.object

    // Not a checkout.session.* event: hand it to the parent, which already
    // parses payment_intent.* and charge.dispute.created. That fall-through is
    // load-bearing rather than tidiness — it is where card clearing and
    // post-settlement ACH returns come from on this rail.
    if (!CHECKOUT_EVENTS.has(envelope.type)) return super.parseEvent(rawBody)

    if (!object || typeof object['id'] !== 'string') return { outcome: 'malformed' }
    const metadata = object['metadata'] as Record<string, unknown> | null | undefined
    const transferRef = metadata?.['transfer_id']
    if (typeof transferRef !== 'string' || transferRef === '') {
      // Signed and well-formed, but not a Session we created. Ack rather than
      // 400 into a redelivery loop.
      return unhandled
    }

    const type = checkoutEventType(envelope.type)
    if (!type) return unhandled

    return {
      outcome: 'event',
      event: {
        eventId: envelope.id,
        type,
        transferRef,
        // The SESSION id, matching what initiateFunding persisted. The route
        // joins on funding_payment_ref, so the two must agree.
        paymentRef: object['id'],
      },
    }
  }

  override async getPaymentStatus(input: { paymentRef: string }): Promise<FundingPaymentStatus> {
    const session = await this.client.checkout.sessions.retrieve(input.paymentRef)
    return {
      paymentRef: session.id,
      // Both, joined: `complete/unpaid` and `complete/paid` are different
      // worlds and a single field cannot tell reconciliation which it is.
      status: `${session.status ?? 'unknown'}/${session.payment_status ?? 'unknown'}`,
    }
  }

  // ── The undos: resolve the Session's PaymentIntent, then reuse the parent ──
  //
  // Every hard part of undoing a Stripe pull — that a cancel and a refund are
  // not interchangeable, that settlement decides which arm applies, that a
  // cancel refused mid-flight has to be re-resolved rather than retried — is
  // already solved on the PI rail and is identical here. The only difference is
  // that our stored ref names a Session. So: translate, then delegate.

  override async voidFunding(input: {
    transferId: string
    paymentRef: string
    idempotencyKey: string
  }): Promise<FundingUndo> {
    const paymentIntentId = await this.paymentIntentFor(input.paymentRef)
    const undo = await super.voidFunding({ ...input, paymentRef: paymentIntentId })
    return { ...undo, provider: this.provider }
  }

  override async refund(input: {
    transferId: string
    paymentRef: string
    amountMinor: number
    currency: 'USD'
    idempotencyKey: string
  }): Promise<FundingUndo> {
    const paymentIntentId = await this.paymentIntentFor(input.paymentRef)
    const undo = await super.refund({ ...input, paymentRef: paymentIntentId })
    return { ...undo, provider: this.provider }
  }

  /**
   * The route's fallback-join escape hatch (FundingProcessor doc comment):
   * charge.dispute.created and a dashboard-issued refund carry the underlying
   * PaymentIntent id as paymentRef, but funding_payment_ref on THIS rail's
   * rows holds the Session id — the direct join always misses. Stripe's List
   * Checkout Sessions endpoint supports filtering by `payment_intent`
   * (docs.stripe.com/api/checkout/sessions/list), which is exactly the
   * reverse lookup needed: PaymentIntent id → the Session that created it.
   * One Session per PI (this rail creates at most one Checkout Session per
   * transfer, ever — the confirm-time idempotency key), so `limit: 1` is
   * exact, not a truncation risk.
   */
  async resolveAlternateFundingRef(paymentIntentId: string): Promise<string | null> {
    if (!paymentIntentId.startsWith('pi_')) return null
    const sessions = await this.client.checkout.sessions.list({
      payment_intent: paymentIntentId,
      limit: 1,
    })
    return sessions.data[0]?.id ?? null
  }

  /**
   * The PaymentIntent behind a Checkout Session.
   *
   * THROWS when there isn't one, and that is deliberate. Both undo paths are
   * reached only from FUNDED, which this rail can only reach via
   * `checkout.session.completed` — a Session that completed always has a
   * PaymentIntent. A missing one therefore means the row is wrong, not that
   * the sender owes nothing, and guessing here would either strand a real
   * payment or report an undo that moved no money. Same posture as the refund
   * tail's null funding_payment_ref check: a data-integrity fault throws, so
   * the claim stays standing and a human looks.
   */
  private async paymentIntentFor(sessionId: string): Promise<string> {
    const session = await this.client.checkout.sessions.retrieve(sessionId)
    const pi = session.payment_intent
    const id = typeof pi === 'string' ? pi : (pi as Stripe.PaymentIntent | null)?.id
    if (!id) {
      throw new Error(
        `stripe_checkout undo: session ${sessionId} has no payment_intent ` +
          `(status=${session.status}, payment_status=${session.payment_status}) — ` +
          'refusing to guess whether money moved',
      )
    }
    return id
  }
}

const CHECKOUT_EVENTS = new Set([
  'checkout.session.completed',
  'checkout.session.async_payment_succeeded',
  'checkout.session.async_payment_failed',
])

/**
 * Map a Checkout Session event to our funding event.
 *
 * `completed` ALWAYS means funded, whatever `payment_status` says, and the
 * reason is worth writing down because the obvious alternative is a money bug.
 *
 * A card session arrives `completed` with `payment_status: 'paid'` — already
 * settled — so it is tempting to call that `funding_cleared` and skip a step.
 * It is not: `funding_cleared` is a FLAG applied to an already-FUNDED transfer,
 * and `applyFundingCleared` explicitly SKIPS its ledger posting when the
 * transfer is still PENDING_PAYMENT ("never posted FUNDED"). So that mapping
 * would set a flag, post nothing, leave the transfer at PENDING_PAYMENT, and
 * let the abandonment sweep fail it — after the sender's card was charged.
 * Money taken, transfer dead, no ledger entry. Caught while writing this rail;
 * an earlier draft of the PRD had it wrong too.
 *
 * So the two legs stay separate, and clearing arrives on its own event:
 *
 *   bank debit  completed (unpaid) → FUNDED, then
 *               async_payment_succeeded → cleared
 *   card        completed (paid)   → FUNDED, then
 *               payment_intent.succeeded → cleared, moments later
 *
 * The card leg is why `payment_intent_data.metadata` is set at creation and
 * why parseEvent falls through to the parent: the PI event is the only clearing
 * signal a card will ever produce. A bank debit will produce BOTH its async
 * event and a PI event; that is harmless, because the clearing ledger batch is
 * keyed on (transfer, 'funding_cleared') and the second one is a no-op.
 *
 * WEBHOOK CONSEQUENCE: this rail needs `payment_intent.succeeded` and
 * `payment_intent.payment_failed` subscribed alongside the three
 * checkout.session.* events. Three is not enough.
 */
function checkoutEventType(
  eventType: string,
): 'funding_succeeded' | 'funding_cleared' | 'funding_failed' | undefined {
  if (eventType === 'checkout.session.completed') return 'funding_succeeded'
  if (eventType === 'checkout.session.async_payment_succeeded') return 'funding_cleared'
  if (eventType === 'checkout.session.async_payment_failed') return 'funding_failed'
  return undefined
}

export { checkoutEventType }
