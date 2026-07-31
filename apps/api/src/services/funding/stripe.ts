import Stripe from 'stripe'
import { env } from '../../config/env.js'
import type {
  FundingClientSession,
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

// Refund-object envelope types (PR-S2) — the async tail of a refunds.create.
// A Set, not a second map: the FundingEventType depends on the payload status,
// not the envelope name alone (see parseEvent).
const REFUND_ENVELOPE_TYPES: ReadonlySet<string> = new Set([
  'refund.failed',
  'refund.updated',
  'charge.refund.updated',
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

  async getClientSession(input: { paymentRef: string }): Promise<FundingClientSession> {
    // Pay-step bootstrap (PR-S3): the client_secret is deliberately NOT
    // persisted anywhere on our side — the funding-session route calls this on
    // demand (once per pay-step mount) and Stripe remains the only store of the
    // credential. Read-only: retrieve never mutates the PI.
    const intent = await this.client.paymentIntents.retrieve(input.paymentRef)
    if (!intent.client_secret) {
      // Same guard as initiateFunding — a PI without a secret can't mount an
      // Element; surface loudly rather than returning a half-usable session.
      throw new Error('Stripe PaymentIntent retrieved without a client_secret')
    }
    return {
      provider: this.provider,
      fields: {
        clientSecret: intent.client_secret,
        // superRefine guarantees this under FUNDING_PROCESSOR=stripe; the
        // non-null assertion guards direct construction the same way the
        // constructor's secret-key check does.
        publishableKey: env.STRIPE_PUBLISHABLE_KEY!,
      },
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

    if (REFUND_ENVELOPE_TYPES.has(envelope.type)) {
      // The undo tail (PR-S2): a Refund we issued resolving. refund.failed is
      // the bounce (closed account etc. — money back on our balance, sender
      // STILL OWED); refund.updated carries status churn, of which only
      // `succeeded` (settled) and `failed` (some API versions deliver the
      // bounce this way) are actionable — the rest ack as unhandled.
      // charge.refund.updated is the same Refund payload under the pre-2022-11
      // event name; endpoints can receive either depending on the API version
      // pin, so both map here.
      if (!object || typeof object['id'] !== 'string') return { outcome: 'malformed' }
      const status = object['status']
      // `canceled` counts as the bounce: a canceled Refund will never arrive,
      // so the sender is exactly as owed as after a `failed` — acking it as
      // unhandled would be the silent arm of a money-truth event.
      const type =
        envelope.type === 'refund.failed' || status === 'failed' || status === 'canceled'
          ? ('refund_failed' as const)
          : status === 'succeeded'
            ? ('refund_settled' as const)
            : null
      if (type === null) return unhandled
      // The PI id is the paymentRef (the funding_payment_ref join the route
      // already knows); a refund with no payment_intent is not against a
      // funding pull of ours — ack it.
      const paymentIntent = object['payment_intent']
      if (typeof paymentIntent !== 'string' || paymentIntent === '') return unhandled
      const metadata = object['metadata'] as Record<string, unknown> | null | undefined
      const transferRefRaw = metadata?.['transfer_id']
      // Null (not unhandled) on a missing echo: refunds WE create carry it,
      // but a refund issued from the Stripe dashboard against our PI would
      // not, and it is still our money-truth — the route joins through the
      // persisted funding_payment_ref exactly as it does for disputes.
      const transferRef =
        typeof transferRefRaw === 'string' && transferRefRaw !== '' ? transferRefRaw : null
      const reason = object['failure_reason']
      return {
        outcome: 'event',
        event: {
          eventId: envelope.id,
          type,
          transferRef,
          paymentRef: paymentIntent,
          undoRef: object['id'],
          ...(type === 'refund_failed' && typeof reason === 'string' && { reason }),
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

  // ── The undo ops (PR-S2) ──────────────────────────────────────────────────
  // Settlement decides the mechanism, and the LIVE PaymentIntent is the
  // authority (never transfers.funding_cleared — a webhook mirror that lags):
  // ACH is the one method cancelable during `processing`
  // (docs.stripe.com/refunds), and conversely an unsettled ACH charge cannot
  // be refunded — Stripe rejects it, and a refund next to a late dispute
  // double-credits. So an uncleared pull VOIDS (cancel; the sender is simply
  // never debited) and a settled one REFUNDS (async credit, `pending` until
  // the refund.updated/refund.failed tail resolves it).
  //
  // Idempotency sub-keys: each POST arm derives its own key (`:cancel` /
  // `:create` under the caller's root) because Stripe caches a FAILED request
  // under its key too — a cancel that lost the settlement race must not
  // poison the fallback refund's key. Every arm is stable per (transfer, op),
  // so crash-replays dedupe against the same sub-key.

  async voidFunding(input: {
    transferId: string
    paymentRef: string
    idempotencyKey: string
  }): Promise<FundingUndo> {
    // Optimistic cancel, no pre-read: at cancel-at-FUNDED the PI is minutes
    // old against a ~T+4 settlement, so the void arm wins outside of sandbox
    // (which settles instantly — the fallback below is how sandbox cancels
    // resolve, closing the slice-7 "ACH-cancelable + void→refund fallback"
    // gated item).
    try {
      const pi = await this.client.paymentIntents.cancel(
        input.paymentRef,
        { cancellation_reason: 'requested_by_customer' },
        { idempotencyKey: `${input.idempotencyKey}:cancel` },
      )
      return { provider: this.provider, ref: pi.id, status: 'succeeded', mode: 'voided' }
    } catch (err) {
      if (!isNotCancelable(err)) throw err
      return this.undoAfterCancelRefused(input, err)
    }
  }

  async refund(input: {
    transferId: string
    paymentRef: string
    amountMinor: number
    currency: 'USD'
    idempotencyKey: string
  }): Promise<FundingUndo> {
    // Read-first, unlike voidFunding: the refund tails fire on payout
    // failures at unpredictable ages, so which arm applies is genuinely
    // unknown here — and under real ACH timing (payout fails in minutes,
    // settlement ~T+4) the answer is usually still `processing`, making VOID
    // the main path of this method, not the exception.
    const pi = await this.client.paymentIntents.retrieve(input.paymentRef)

    if (pi.status === 'canceled') {
      // Crash-replay: a prior run voided this pull but died before persisting
      // the ref. Nothing to move — report the void.
      return { provider: this.provider, ref: pi.id, status: 'succeeded', mode: 'voided' }
    }

    if (pi.status === 'succeeded') {
      return this.createRefund(input)
    }

    // Uncleared → void. Cancel is all-or-nothing, so a partial amount cannot
    // be honoured this way; both callers pass the full send+fee (= the PI
    // amount), making a mismatch a caller bug — refuse loudly rather than
    // return more than asked.
    if (input.amountMinor !== pi.amount) {
      throw new Error(
        `stripe refund: amount ${input.amountMinor} !== PI amount ${pi.amount} — ` +
          `an uncleared pull can only be voided in full (${pi.id})`,
      )
    }
    try {
      // No cancellation_reason: 'requested_by_customer' would be false here —
      // this arm serves the payout-failure and correction tails.
      const canceled = await this.client.paymentIntents.cancel(input.paymentRef, undefined, {
        idempotencyKey: `${input.idempotencyKey}:cancel`,
      })
      return { provider: this.provider, ref: canceled.id, status: 'succeeded', mode: 'voided' }
    } catch (err) {
      if (!isNotCancelable(err)) throw err
      // Settlement (or another actor's cancel) raced our read — re-resolve.
      return this.undoAfterCancelRefused(input, err)
    }
  }

  /**
   * A cancel was refused (`payment_intent_unexpected_state`): the PI left the
   * cancelable statuses between our decision and the POST. Re-read to learn
   * which way — canceled (another actor / a replayed run: the void stands) or
   * succeeded (settlement won: refund instead). Anything else rethrows the
   * ORIGINAL refusal: the PI is in a state this seam has no move for, and the
   * caller's posture (claim left standing, human paged) is built for exactly
   * that throw.
   */
  private async undoAfterCancelRefused(
    input: { transferId: string; paymentRef: string; idempotencyKey: string; amountMinor?: number },
    originalErr: unknown,
  ): Promise<FundingUndo> {
    const pi = await this.client.paymentIntents.retrieve(input.paymentRef)
    if (pi.status === 'canceled') {
      return { provider: this.provider, ref: pi.id, status: 'succeeded', mode: 'voided' }
    }
    if (pi.status === 'succeeded') {
      return this.createRefund(input)
    }
    throw originalErr
  }

  /**
   * The refund arm. Omitted amount = full refund (the voidFunding fallback,
   * whose seam carries no amount). `status: 'pending'` is the ACH norm — the
   * credit lands in ~5–10 business days and resolves via refund.updated /
   * refund.failed (parseEvent below); callers persist the ref and treat the
   * undo as ISSUED. metadata.transfer_id mirrors the PI echo so the tail
   * events route without a join.
   */
  private async createRefund(input: {
    transferId: string
    paymentRef: string
    idempotencyKey: string
    amountMinor?: number
  }): Promise<FundingUndo> {
    const refund = await this.client.refunds.create(
      {
        payment_intent: input.paymentRef,
        ...(input.amountMinor !== undefined && { amount: input.amountMinor }),
        metadata: { transfer_id: input.transferId },
      },
      { idempotencyKey: `${input.idempotencyKey}:create` },
    )
    return {
      provider: this.provider,
      ref: refund.id,
      status: refund.status === 'succeeded' ? 'succeeded' : 'pending',
      mode: 'refunded',
    }
  }
}

// Stripe refuses to cancel a PI outside the cancelable statuses with an
// invalid_request_error coded `payment_intent_unexpected_state`. Duck-typed on
// the code rather than instanceof Stripe.errors.…: the documented contract is
// the code string, and class identity breaks across SDK copies.
const isNotCancelable = (err: unknown): boolean =>
  typeof err === 'object' &&
  err !== null &&
  (err as { code?: unknown }).code === 'payment_intent_unexpected_state'
