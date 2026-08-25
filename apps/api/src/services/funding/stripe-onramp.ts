import crypto from 'node:crypto'
import Stripe from 'stripe'
import { env } from '../../config/env.js'
import {
  FundingInitiationError,
  type FundingClientSession,
  type FundingEventType,
  type FundingInitiation,
  type FundingParseResult,
  type FundingProcessor,
  type FundingUndo,
} from './index.js'

// Stripe crypto onramp rail (#213). The sender pays inside Stripe's embedded
// widget (card / Apple Pay / ACH — Stripe is merchant of record and owns
// fraud/dispute liability); Stripe delivers USDC on Base to the treasury
// wallet address the session locks at creation. Raw REST over fetch, per
// services/bridge.ts precedent: the official SDK has no onramp support while
// the API is in public preview (their docs say so outright), so the only SDK
// use here is `webhooks.constructEvent` — a pure local HMAC check, no network.
//
// Session status → funding event mapping (locked decision 3, 2026-08-21):
//   fulfillment_processing — payment confirmed, crypto not yet delivered →
//     funding_succeeded (FUNDED; payout releases against float, same posture
//     as the manual rail — WAIT_FOR_CLEARING is the ready-made conservative
//     mode)
//   fulfillment_complete   — USDC delivered to the treasury →
//     funding_cleared (+ float top-up, via applyOnrampSettlement)
//   rejected               — KYC / sanctions / fraud refusal →
//     funding_failed (PAYMENT_FAILED)
//   initialized / requires_payment — pre-payment churn → unhandled (200 ack)
// Confirmed transactions are irreversible on Stripe's side, so this rail has
// no funding_reversed tail and no processor-side refund API (see undo()).
const SESSION_EVENT_TYPE = 'crypto.onramp_session.updated'

const SESSION_STATUS_MAP = new Map<string, FundingEventType>([
  ['fulfillment_processing', 'funding_succeeded'],
  ['fulfillment_complete', 'funding_cleared'],
  ['rejected', 'funding_failed'],
])

// Stripe 400 codes from session create that mean "this sender, not us":
// geo/profile refusal off the customer_ip_address pre-check. Mapped to
// FundingInitiationError('unsupported') → confirm 403 funding_unsupported.
const UNSUPPORTED_CODES = new Set([
  'crypto_onramp_unsupportable_customer',
  'crypto_onramp_unsupported_country',
])

// KYC prefill parameter name. The live docs disagree with themselves: the
// embedded-onramp guide's worked example uses `customer_information[...]`,
// the machine-generated API reference names the same object `kyc_details`
// (public-preview drift; the public OpenAPI spec omits onramp entirely, so
// neither can be confirmed offline). Shipping the guide's spelling; a wrong
// guess fails LOUDLY at the first staging confirm (Stripe 400s on unknown
// params) and the fix is this one constant.
const PREFILL_PARAM = 'customer_information'

export class StripeOnrampApiError extends Error {
  // Raw Stripe error body — readable for code branching, but NON-ENUMERABLE
  // (BridgeApiError precedent) so console.error / util.inspect / JSON never
  // print it: onramp error bodies can echo request params (names, emails).
  declare readonly body: unknown

  constructor(
    public readonly status: number,
    body: unknown,
  ) {
    super(`Stripe onramp API request failed with status ${status}`)
    this.name = 'StripeOnrampApiError'
    Object.defineProperty(this, 'body', { value: body, enumerable: false })
  }
}

// The error code inside a Stripe error envelope, or null. Duck-typed off the
// body shape ({ error: { code } }) — the documented contract is the code
// string, same rationale as isNotCancelable in stripe.ts.
function stripeErrorCode(body: unknown): string | null {
  if (typeof body !== 'object' || body === null) return null
  const error = (body as { error?: unknown }).error
  if (typeof error !== 'object' || error === null) return null
  const code = (error as { code?: unknown }).code
  return typeof code === 'string' ? code : null
}

interface OnrampSessionPayload {
  id?: unknown
  client_secret?: unknown
  status?: unknown
  metadata?: unknown
}

export class StripeOnrampFundingProcessor implements FundingProcessor {
  readonly provider = 'stripe_onramp'
  readonly signatureHeader = 'stripe-signature'
  // ONLY for webhooks.constructEvent (parse + HMAC + 300s timestamp
  // tolerance, purely local). Every network call in this file is raw fetch.
  private readonly signer: Stripe
  private readonly secretKey: string

  constructor(secretKey?: string) {
    const key = secretKey ?? env.STRIPE_SECRET_KEY
    if (!key) {
      // Unreachable when selected via FUNDING_PROCESSOR (env.superRefine
      // refuses to boot that config) — this guards direct construction.
      throw new Error('StripeOnrampFundingProcessor requires STRIPE_SECRET_KEY')
    }
    this.secretKey = key
    this.signer = new Stripe(key, { timeout: env.STRIPE_TIMEOUT_SECONDS * 1000 })
  }

  isConfigured(): boolean {
    // The stripe trio plus the on-chain delivery address (superRefine enforces
    // the same set at boot; this runtime gate must agree with it).
    return Boolean(
      env.STRIPE_SECRET_KEY &&
        env.STRIPE_WEBHOOK_SECRET &&
        env.STRIPE_PUBLISHABLE_KEY &&
        env.ONRAMP_DESTINATION_ADDRESS,
    )
  }

  // TIMEOUT CONTRACT (funding/index.ts): bounded per-request deadline, same
  // knob as the SDK adapter. Form-encoded bodies — the onramp endpoints speak
  // standard Stripe form encoding, not JSON.
  private async onrampFetch(
    path: string,
    init: { method?: string; body?: URLSearchParams; idempotencyKey?: string } = {},
  ): Promise<unknown> {
    const res = await fetch(`https://api.stripe.com${path}`, {
      method: init.method ?? 'GET',
      signal: AbortSignal.timeout(env.STRIPE_TIMEOUT_SECONDS * 1000),
      headers: {
        Authorization: `Bearer ${this.secretKey}`,
        ...(init.body && { 'Content-Type': 'application/x-www-form-urlencoded' }),
        ...(init.idempotencyKey && { 'Idempotency-Key': init.idempotencyKey }),
      },
      ...(init.body && { body: init.body }),
    })

    if (!res.ok) {
      const body = await res.json().catch(() => null)
      throw new StripeOnrampApiError(res.status, body)
    }
    return res.json()
  }

  async initiateFunding(input: {
    transferId: string
    userId: string
    totalAmountMinor: number
    currency: 'USD'
    clientIp?: string
    customer?: { firstName?: string; lastName?: string; email?: string }
  }): Promise<FundingInitiation> {
    const destinationAddress = env.ONRAMP_DESTINATION_ADDRESS
    if (!destinationAddress) {
      // Unreachable when selected via FUNDING_PROCESSOR (superRefine +
      // isConfigured both require it) — guards direct construction, because
      // a session minted without a locked address would let the sender pick
      // their own wallet and walk off with the delivery.
      throw new Error('StripeOnrampFundingProcessor requires ONRAMP_DESTINATION_ADDRESS')
    }
    // Destination-fixed session, everything the sender must not change locked
    // at creation (decision 2, 2026-08-21): amount = send+fee in USDC at par
    // (USDC has 6 decimals but the amount is dollars-and-cents by
    // construction, so 2 suffice), currency/network pinned by single-value
    // restriction arrays (user-UNoverridable per the API reference; the
    // singular fields alone are just defaults), delivery hard-wired to the
    // treasury's Base address. metadata.transfer_id is the routing echo —
    // same contract as the PI rail's, no user id, no PII.
    const params = new URLSearchParams({
      source_currency: 'usd',
      destination_currency: 'usdc',
      destination_network: 'base',
      'destination_currencies[]': 'usdc',
      'destination_networks[]': 'base',
      destination_amount: (input.totalAmountMinor / 100).toFixed(2),
      'wallet_addresses[base]': destinationAddress,
      lock_wallet_address: 'true',
      'metadata[transfer_id]': input.transferId,
    })
    if (input.clientIp) params.set('customer_ip_address', input.clientIp)
    if (input.customer?.firstName) params.set(`${PREFILL_PARAM}[first_name]`, input.customer.firstName)
    if (input.customer?.lastName) params.set(`${PREFILL_PARAM}[last_name]`, input.customer.lastName)
    if (input.customer?.email) params.set(`${PREFILL_PARAM}[email]`, input.customer.email)

    let session: OnrampSessionPayload
    try {
      // Same idempotency contract as the PI rail: one session per transfer,
      // ever — the DB-side funding_payment_ref null-gate is the primary
      // guarantee, the Stripe key closes the crash-between-create-and-persist
      // window.
      session = (await this.onrampFetch('/v1/crypto/onramp_sessions', {
        method: 'POST',
        body: params,
        idempotencyKey: `funding_init_${input.transferId}`,
      })) as OnrampSessionPayload
    } catch (err) {
      if (err instanceof StripeOnrampApiError) {
        const code = stripeErrorCode(err.body)
        if (code !== null && UNSUPPORTED_CODES.has(code)) {
          throw new FundingInitiationError('unsupported')
        }
        // Stripe's fraud kill switch: session creation is off account-wide
        // until they re-enable it (or the env flips back to manual).
        if (code === 'crypto_onramp_disabled') {
          throw new FundingInitiationError('disabled')
        }
      }
      throw err
    }

    if (typeof session.id !== 'string' || session.id === '') {
      throw new Error('Stripe onramp session created without an id')
    }
    if (typeof session.client_secret !== 'string' || session.client_secret === '') {
      // A session without a secret can't mount the widget — surface loudly
      // rather than persisting a ref the pay step can never use.
      throw new Error('Stripe onramp session created without a client_secret')
    }
    return {
      provider: this.provider,
      method: 'onramp',
      paymentRef: session.id,
      clientFields: { client_secret: session.client_secret },
    }
  }

  async getClientSession(input: { paymentRef: string }): Promise<FundingClientSession> {
    // Pay-step bootstrap: retrieve the LIVE session on demand — the
    // client_secret is never persisted or logged on our side (PI-rail
    // contract). `status` lets a reload after payment render the submitted
    // banner instead of remounting a widget for a session that's already
    // past requires_payment. Fits the funding-session response allowlist
    // with zero schema change.
    const session = (await this.onrampFetch(
      `/v1/crypto/onramp_sessions/${encodeURIComponent(input.paymentRef)}`,
    )) as OnrampSessionPayload
    if (typeof session.client_secret !== 'string' || session.client_secret === '') {
      throw new Error('Stripe onramp session retrieved without a client_secret')
    }
    return {
      provider: this.provider,
      fields: {
        clientSecret: session.client_secret,
        // superRefine guarantees this under FUNDING_PROCESSOR=stripe_onramp;
        // the non-null assertion guards direct construction the same way the
        // constructor's secret-key check does.
        publishableKey: env.STRIPE_PUBLISHABLE_KEY!,
        ...(typeof session.status === 'string' && { status: session.status }),
      },
    }
  }

  // No getPaymentStatus / listRecentPayments in v1 — deliberately. The recon
  // stripe-legs gate on provider 'stripe' and would skip this provider anyway;
  // implementing the reads without re-plumbing recon would be mock theater.
  // Honest `skipped` findings until the onramp recon fast-follow (#227
  // family). The redelivery window + the uncleared-transfer check are the
  // interim nets.

  verifySignature(rawBody: Buffer, signatureHeader: string): boolean {
    const secret = env.STRIPE_WEBHOOK_SECRET
    if (!secret || !signatureHeader) return false
    try {
      // Pure local HMAC + timestamp check; parsed result discarded — the
      // route calls parseEvent on the same raw bytes after this gate passes.
      this.signer.webhooks.constructEvent(rawBody, signatureHeader, secret)
      return true
    } catch {
      return false
    }
  }

  parseEvent(rawBody: Buffer): FundingParseResult {
    let envelope: {
      id?: unknown
      type?: unknown
      data?: { object?: OnrampSessionPayload }
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

    // One event type carries the whole lifecycle; anything else the endpoint
    // is subscribed to acks (a 400 would put a legitimate delivery into a
    // redelivery loop and count against endpoint health).
    if (envelope.type !== SESSION_EVENT_TYPE) return unhandled

    const session = envelope.data?.object
    if (!session || typeof session.id !== 'string') return { outcome: 'malformed' }

    // Signed and well-formed but no transfer echo — a session minted outside
    // this rail (dashboard experiment, another integration on the account).
    // Not ours to act on; ack with the type visible to ops.
    const metadata = session.metadata as Record<string, unknown> | null | undefined
    const transferRef = metadata?.['transfer_id']
    if (typeof transferRef !== 'string' || transferRef === '') return unhandled

    // Pre-payment churn (initialized, requires_payment) and any status this
    // preview API grows later → unhandled, defensively: an unknown status is
    // not evidence money moved.
    if (typeof session.status !== 'string') return { outcome: 'malformed' }
    const eventType = SESSION_STATUS_MAP.get(session.status)
    if (!eventType) return unhandled

    return {
      outcome: 'event',
      event: {
        eventId: envelope.id,
        type: eventType,
        transferRef,
        paymentRef: session.id,
        // No reason field: the session payload carries no machine-readable
        // rejection cause (KYC/sanctions detail stays on Stripe's side).
      },
    }
  }

  async voidFunding(): Promise<FundingUndo> {
    return this.undo()
  }

  async refund(): Promise<FundingUndo> {
    return this.undo()
  }

  // Both undo ops resolve identically, and NEITHER may claim success — the
  // manual processor's posture, for the same reason: by FUNDED the sender's
  // money is real and already collected (Stripe confirmed the payment; the
  // USDC lands in the treasury), there is no uncleared pull to cancel, and
  // the onramp API has no refund op — confirmed transactions are irreversible
  // on Stripe's side. `'pending'` records the obligation; a human returns the
  // funds per docs/runbooks/manual-refund.md and the refund_settled /
  // refund_failed tail closes it out. `mode: 'refunded'` keeps the ledger
  // honest (funds WERE collected, the receivable settles on its own clearing
  // leg); the `onramprefund_` prefix is the durable encoding —
  // undoModeForRef's unknown-prefix default already reads 'refunded', and
  // undoRequiresManualDisbursement lists it explicitly.
  private undo(): FundingUndo {
    return {
      provider: this.provider,
      ref: `onramprefund_${crypto.randomUUID()}`,
      status: 'pending',
      mode: 'refunded',
    }
  }
}
