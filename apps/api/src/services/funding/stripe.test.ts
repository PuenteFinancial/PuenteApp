import { describe, it, expect, vi } from 'vitest'
import Stripe from 'stripe'
import { env } from '../../config/env.js'
import type { FundingProcessor } from './index.js'
import { StripeFundingProcessor } from './stripe.js'

// setup.ts provides STRIPE_WEBHOOK_SECRET (and deliberately NOT
// STRIPE_SECRET_KEY — isConfigured tests below rely on that split).
const WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET!

// A real Stripe client (dummy key, never hits the network) so verifySignature
// exercises the SDK's actual constructEvent HMAC + tolerance logic, and
// generateTestHeaderString produces genuine signature vectors.
const realClient = new Stripe('sk_test_dummy')
const processor = new StripeFundingProcessor(realClient)

const TRANSFER_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'

const piEventBody = (
  type = 'payment_intent.processing',
  objectOverrides: Record<string, unknown> = {},
) =>
  Buffer.from(
    JSON.stringify({
      id: 'evt_1',
      type,
      data: {
        object: {
          id: 'pi_123',
          object: 'payment_intent',
          metadata: { transfer_id: TRANSFER_ID },
          ...objectOverrides,
        },
      },
    }),
  )

const signed = (body: Buffer, secret: string = WEBHOOK_SECRET, timestamp?: number) =>
  realClient.webhooks.generateTestHeaderString({
    payload: body.toString('utf8'),
    secret,
    ...(timestamp !== undefined && { timestamp }),
  })

describe('StripeFundingProcessor construction', () => {
  it('refuses default construction without STRIPE_SECRET_KEY', () => {
    expect(env.STRIPE_SECRET_KEY).toBeUndefined()
    expect(() => new StripeFundingProcessor()).toThrow(/STRIPE_SECRET_KEY/)
  })

  it('builds its own client from env with the bounded timeout (debt-pass contract)', () => {
    const saved = env.STRIPE_SECRET_KEY
    env.STRIPE_SECRET_KEY = 'sk_test_dummy'
    try {
      const p = new StripeFundingProcessor()
      const client = (p as unknown as { client: Stripe }).client
      expect(client.getApiField('timeout')).toBe(env.STRIPE_TIMEOUT_SECONDS * 1000)
      expect(client.getMaxNetworkRetries()).toBe(2)
    } finally {
      env.STRIPE_SECRET_KEY = saved
    }
  })
})

describe('stripe isConfigured', () => {
  it('requires BOTH the secret key and the webhook secret', () => {
    const saved = env.STRIPE_SECRET_KEY
    try {
      expect(env.STRIPE_WEBHOOK_SECRET).toBeTruthy()
      expect(processor.isConfigured()).toBe(false) // no secret key in test env
      env.STRIPE_SECRET_KEY = 'sk_test_dummy'
      expect(processor.isConfigured()).toBe(true)
    } finally {
      env.STRIPE_SECRET_KEY = saved
    }
  })
})

describe('stripe initiateFunding', () => {
  const input = {
    transferId: TRANSFER_ID,
    userId: 'user-1',
    totalAmountMinor: 20000,
    currency: 'USD' as const,
  }

  it('creates a us_bank_account PaymentIntent with the transfer echo and a derived idempotency key', async () => {
    const create = vi.fn(async () => ({ id: 'pi_123', client_secret: 'pi_123_secret_x' }))
    const p = new StripeFundingProcessor({ paymentIntents: { create } } as unknown as Stripe)

    const initiation = await p.initiateFunding(input)

    expect(create).toHaveBeenCalledTimes(1)
    const [params, options] = create.mock.calls[0]! as unknown as [
      Record<string, unknown>,
      Record<string, unknown>,
    ]
    expect(params).toMatchObject({
      amount: 20000,
      currency: 'usd',
      payment_method_types: ['us_bank_account'],
      payment_method_options: { us_bank_account: { verification_method: 'instant' } },
      metadata: { transfer_id: TRANSFER_ID },
    })
    // No PII rides to Stripe — the PI carries only the transfer join key.
    expect(JSON.stringify(params)).not.toContain('user-1')
    expect(options).toEqual({ idempotencyKey: `funding_init_${TRANSFER_ID}` })
    expect(initiation).toEqual({
      provider: 'stripe',
      method: 'ach',
      paymentRef: 'pi_123',
      clientFields: { client_secret: 'pi_123_secret_x' },
    })
  })

  it('throws when Stripe returns no client_secret instead of confirming a dead transfer', async () => {
    const create = vi.fn(async () => ({ id: 'pi_123', client_secret: null }))
    const p = new StripeFundingProcessor({ paymentIntents: { create } } as unknown as Stripe)
    await expect(p.initiateFunding(input)).rejects.toThrow(/client_secret/)
  })
})

describe('stripe verifySignature — real SDK vectors', () => {
  it('accepts a genuine signature', () => {
    const body = piEventBody()
    expect(processor.verifySignature(body, signed(body))).toBe(true)
  })

  it('rejects wrong secret, tampered body, stale timestamp, and garbage headers — without throwing', () => {
    const body = piEventBody()
    expect(processor.verifySignature(body, signed(body, 'whsec_wrong_secret'))).toBe(false)
    expect(processor.verifySignature(Buffer.from('{"tampered":1}'), signed(body))).toBe(false)
    // constructEvent tolerance is 300s — 400s-old timestamps must fail
    expect(
      processor.verifySignature(body, signed(body, WEBHOOK_SECRET, Math.floor(Date.now() / 1000) - 400)),
    ).toBe(false)
    for (const header of ['', 'garbage', 't=abc,v1=zz', `t=${Date.now()},v1=`]) {
      expect(processor.verifySignature(body, header)).toBe(false)
    }
  })
})

describe('stripe parseEvent — locked event mapping', () => {
  it.each([
    ['payment_intent.processing', 'funding_succeeded'],
    ['payment_intent.succeeded', 'funding_cleared'],
    ['payment_intent.payment_failed', 'funding_failed'],
  ] as const)('%s → %s with the metadata transfer echo', (stripeType, fundingType) => {
    const parsed = processor.parseEvent(piEventBody(stripeType))
    expect(parsed).toEqual({
      outcome: 'event',
      event: {
        eventId: 'evt_1',
        type: fundingType,
        transferRef: TRANSFER_ID,
        paymentRef: 'pi_123',
      },
    })
  })

  it('carries the ACH failure cause through on payment_failed (decline_code over code)', () => {
    const withDecline = processor.parseEvent(
      piEventBody('payment_intent.payment_failed', {
        last_payment_error: { code: 'payment_failed', decline_code: 'insufficient_funds' },
      }),
    )
    expect(withDecline.outcome === 'event' && withDecline.event.reason).toBe('insufficient_funds')

    const codeOnly = processor.parseEvent(
      piEventBody('payment_intent.payment_failed', {
        last_payment_error: { code: 'account_closed' },
      }),
    )
    expect(codeOnly.outcome === 'event' && codeOnly.event.reason).toBe('account_closed')

    // succeeded events never carry a reason even if an old error lingers
    const succeeded = processor.parseEvent(
      piEventBody('payment_intent.processing', { last_payment_error: { code: 'stale' } }),
    )
    expect(succeeded.outcome === 'event' && 'reason' in succeeded.event).toBe(false)
  })

  it('charge.dispute.created → funding_reversed with a null transferRef and the PI join key', () => {
    const body = Buffer.from(
      JSON.stringify({
        id: 'evt_d1',
        type: 'charge.dispute.created',
        data: {
          object: {
            id: 'dp_1',
            object: 'dispute',
            charge: 'ch_1',
            payment_intent: 'pi_123',
            reason: 'insufficient_funds',
          },
        },
      }),
    )
    expect(processor.parseEvent(body)).toEqual({
      outcome: 'event',
      event: {
        eventId: 'evt_d1',
        type: 'funding_reversed',
        transferRef: null,
        paymentRef: 'pi_123',
        reason: 'insufficient_funds',
      },
    })
  })

  it('acks-as-unhandled: foreign PIs, joinless disputes, and unmapped types (incl. payment_method.automatically_updated)', () => {
    // a PI on the same account that isn't ours — no metadata echo
    expect(processor.parseEvent(piEventBody('payment_intent.processing', { metadata: {} }))).toEqual(
      { outcome: 'unhandled', eventId: 'evt_1', eventType: 'payment_intent.processing' },
    )
    // a dispute with no payment_intent to join through
    expect(
      processor.parseEvent(
        Buffer.from(
          JSON.stringify({
            id: 'evt_d2',
            type: 'charge.dispute.created',
            data: { object: { id: 'dp_2', payment_intent: null } },
          }),
        ),
      ),
    ).toEqual({ outcome: 'unhandled', eventId: 'evt_d2', eventType: 'charge.dispute.created' })
    // subscribed-but-unmapped event types ack instead of 400-looping
    // ('constructor' pins the map against Object.prototype key collisions)
    for (const eventType of ['payment_method.automatically_updated', 'charge.succeeded', 'constructor']) {
      expect(
        processor.parseEvent(Buffer.from(JSON.stringify({ id: 'evt_x', type: eventType, data: { object: { id: 'x_1' } } }))),
      ).toEqual({ outcome: 'unhandled', eventId: 'evt_x', eventType })
    }
  })

  it('classifies junk as malformed', () => {
    expect(processor.parseEvent(Buffer.from('not json'))).toEqual({ outcome: 'malformed' })
    expect(processor.parseEvent(Buffer.from(JSON.stringify({ type: 'payment_intent.processing' })))).toEqual(
      { outcome: 'malformed' },
    )
    expect(processor.parseEvent(Buffer.from(JSON.stringify({ id: 'evt_1' })))).toEqual({
      outcome: 'malformed',
    })
    // a mapped type with no object payload is junk, not merely unhandled
    expect(
      processor.parseEvent(Buffer.from(JSON.stringify({ id: 'evt_1', type: 'payment_intent.processing' }))),
    ).toEqual({ outcome: 'malformed' })
  })
})

describe('stripe undo ops are PR-S2', () => {
  it('voidFunding and refund fail loudly instead of minting fake refs', async () => {
    // Interface-typed on purpose: callers only ever hold the seam type.
    const seam: FundingProcessor = processor
    await expect(
      seam.voidFunding({ transferId: TRANSFER_ID, paymentRef: 'pi_123', idempotencyKey: 'k' }),
    ).rejects.toThrow(/PR-S2/)
    await expect(
      seam.refund({
        transferId: TRANSFER_ID,
        paymentRef: 'pi_123',
        amountMinor: 20000,
        currency: 'USD',
        idempotencyKey: 'k',
      }),
    ).rejects.toThrow(/PR-S2/)
  })
})
