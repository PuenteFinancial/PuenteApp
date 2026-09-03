import { describe, it, expect, vi } from 'vitest'
import Stripe from 'stripe'
import { env } from '../../config/env.js'
import { undoModeForRef, type FundingProcessor } from './index.js'
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
  it('requires the secret key, webhook secret, AND publishable key (PR-S3 trio)', () => {
    const savedSecret = env.STRIPE_SECRET_KEY
    const savedPublishable = env.STRIPE_PUBLISHABLE_KEY
    try {
      expect(env.STRIPE_WEBHOOK_SECRET).toBeTruthy()
      expect(processor.isConfigured()).toBe(false) // no secret key in test env
      env.STRIPE_SECRET_KEY = 'sk_test_dummy'
      // Secret + webhook alone is still a partial trio: the web could never
      // mount the Element, so the runtime gate must agree with boot's superRefine.
      expect(processor.isConfigured()).toBe(false)
      env.STRIPE_PUBLISHABLE_KEY = 'pk_test_dummy'
      expect(processor.isConfigured()).toBe(true)
    } finally {
      env.STRIPE_SECRET_KEY = savedSecret
      env.STRIPE_PUBLISHABLE_KEY = savedPublishable
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
    })
    // #243: the client_secret is served live by getClientSession, never
    // returned from initiation — confirm's response has no consumer for it.
    expect(initiation).not.toHaveProperty('clientFields')
  })

  it('throws when Stripe returns no client_secret instead of confirming a dead transfer', async () => {
    const create = vi.fn(async () => ({ id: 'pi_123', client_secret: null }))
    const p = new StripeFundingProcessor({ paymentIntents: { create } } as unknown as Stripe)
    await expect(p.initiateFunding(input)).rejects.toThrow(/client_secret/)
  })
})

describe('stripe getClientSession (PR-S3 pay-step bootstrap)', () => {
  it('retrieves the live PI and returns wire-shaped camelCase fields with the publishable key', async () => {
    const saved = env.STRIPE_PUBLISHABLE_KEY
    env.STRIPE_PUBLISHABLE_KEY = 'pk_test_dummy'
    try {
      const retrieve = vi.fn(async () => ({
        id: 'pi_123',
        client_secret: 'pi_123_secret_x',
        status: 'processing',
      }))
      const p = new StripeFundingProcessor({ paymentIntents: { retrieve } } as unknown as Stripe)

      const session = await p.getClientSession({ paymentRef: 'pi_123' })

      expect(retrieve).toHaveBeenCalledWith('pi_123')
      expect(session).toEqual({
        provider: 'stripe',
        fields: {
          clientSecret: 'pi_123_secret_x',
          publishableKey: 'pk_test_dummy',
          status: 'processing',
        },
      })
    } finally {
      env.STRIPE_PUBLISHABLE_KEY = saved
    }
  })

  it('throws on a PI without a client_secret instead of returning a half-usable session', async () => {
    const retrieve = vi.fn(async () => ({ id: 'pi_123', client_secret: null }))
    const p = new StripeFundingProcessor({ paymentIntents: { retrieve } } as unknown as Stripe)
    await expect(p.getClientSession({ paymentRef: 'pi_123' })).rejects.toThrow(/client_secret/)
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

// ── PR-S2: the undo ops ──────────────────────────────────────────────────────

const NOT_CANCELABLE = Object.assign(new Error('You cannot cancel this PaymentIntent'), {
  code: 'payment_intent_unexpected_state',
})

// A stripe-shaped client exposing only what the undo ops touch. Missing fns
// default to a mock that throws on call, so an arm reaching for an endpoint a
// test didn't expect fails loudly instead of resolving undefined.
const undoClient = (fns: {
  cancel?: ReturnType<typeof vi.fn>
  retrieve?: ReturnType<typeof vi.fn>
  create?: ReturnType<typeof vi.fn>
}) => {
  const unexpected = (name: string) =>
    vi.fn(async () => {
      throw new Error(`unexpected ${name} call`)
    })
  return {
    processor: new StripeFundingProcessor({
      paymentIntents: {
        cancel: fns.cancel ?? unexpected('paymentIntents.cancel'),
        retrieve: fns.retrieve ?? unexpected('paymentIntents.retrieve'),
      },
      refunds: { create: fns.create ?? unexpected('refunds.create') },
    } as unknown as Stripe) as FundingProcessor,
  }
}

const VOID_INPUT = { transferId: TRANSFER_ID, paymentRef: 'pi_123', idempotencyKey: 'idem:void' }
const REFUND_INPUT = {
  transferId: TRANSFER_ID,
  paymentRef: 'pi_123',
  amountMinor: 20000,
  currency: 'USD' as const,
  idempotencyKey: 'idem:refund',
}

describe('stripe voidFunding', () => {
  it('cancels the PaymentIntent — voided, succeeded, sub-keyed :cancel', async () => {
    const cancel = vi.fn(async () => ({ id: 'pi_123', status: 'canceled' }))
    const { processor: p } = undoClient({ cancel })

    const undo = await p.voidFunding(VOID_INPUT)

    expect(undo).toEqual({ provider: 'stripe', ref: 'pi_123', status: 'succeeded', mode: 'voided' })
    expect(cancel).toHaveBeenCalledWith(
      'pi_123',
      { cancellation_reason: 'requested_by_customer' },
      { idempotencyKey: 'idem:void:cancel' },
    )
  })

  it('void→refund fallback: PI settled first → full refund, pending, sub-keyed :create', async () => {
    const cancel = vi.fn(async () => {
      throw NOT_CANCELABLE
    })
    const retrieve = vi.fn(async () => ({ id: 'pi_123', status: 'succeeded', amount: 20000 }))
    const create = vi.fn(async () => ({ id: 're_1', status: 'pending' }))
    const { processor: p } = undoClient({ cancel, retrieve, create })

    const undo = await p.voidFunding(VOID_INPUT)

    expect(undo).toEqual({ provider: 'stripe', ref: 're_1', status: 'pending', mode: 'refunded' })
    const [params, options] = create.mock.calls[0]! as unknown as [
      Record<string, unknown>,
      Record<string, unknown>,
    ]
    // No amount = FULL refund, and the Refund carries the transfer echo so its
    // tail events (refund.updated/failed) route without a join.
    expect(params).toEqual({
      payment_intent: 'pi_123',
      metadata: { transfer_id: TRANSFER_ID },
    })
    expect(options).toEqual({ idempotencyKey: 'idem:void:create' })
  })

  it('replay: cancel refused because a prior run already canceled → voided, no refund POST', async () => {
    const cancel = vi.fn(async () => {
      throw NOT_CANCELABLE
    })
    const retrieve = vi.fn(async () => ({ id: 'pi_123', status: 'canceled' }))
    const { processor: p } = undoClient({ cancel, retrieve })

    const undo = await p.voidFunding(VOID_INPUT)
    expect(undo).toEqual({ provider: 'stripe', ref: 'pi_123', status: 'succeeded', mode: 'voided' })
  })

  it('rethrows non-state errors without touching other endpoints', async () => {
    const cancel = vi.fn(async () => {
      throw Object.assign(new Error('rate limited'), { code: 'rate_limit' })
    })
    const { processor: p } = undoClient({ cancel })
    await expect(p.voidFunding(VOID_INPUT)).rejects.toThrow('rate limited')
  })

  it('rethrows the ORIGINAL refusal when the PI is in a state with no move (not canceled, not succeeded)', async () => {
    const cancel = vi.fn(async () => {
      throw NOT_CANCELABLE
    })
    // e.g. requires_action after a partial re-confirmation — nothing this seam can do
    const retrieve = vi.fn(async () => ({ id: 'pi_123', status: 'requires_action' }))
    const { processor: p } = undoClient({ cancel, retrieve })
    await expect(p.voidFunding(VOID_INPUT)).rejects.toThrow(/cannot cancel/)
  })
})

describe('stripe refund — settlement-aware', () => {
  it('settled PI → refunds.create with the exact amount, refunded, pending', async () => {
    const retrieve = vi.fn(async () => ({ id: 'pi_123', status: 'succeeded', amount: 20000 }))
    const create = vi.fn(async () => ({ id: 're_9', status: 'pending' }))
    const { processor: p } = undoClient({ retrieve, create })

    const undo = await p.refund(REFUND_INPUT)

    expect(undo).toEqual({ provider: 'stripe', ref: 're_9', status: 'pending', mode: 'refunded' })
    expect(create).toHaveBeenCalledWith(
      { payment_intent: 'pi_123', amount: 20000, metadata: { transfer_id: TRANSFER_ID } },
      { idempotencyKey: 'idem:refund:create' },
    )
  })

  it('a refund the sandbox settles instantly reports succeeded, not pending', async () => {
    const retrieve = vi.fn(async () => ({ id: 'pi_123', status: 'succeeded', amount: 20000 }))
    const create = vi.fn(async () => ({ id: 're_9', status: 'succeeded' }))
    const { processor: p } = undoClient({ retrieve, create })
    expect((await p.refund(REFUND_INPUT)).status).toBe('succeeded')
  })

  it('uncleared PI → VOID (the main ACH-timing path): cancel without a customer reason, sub-keyed :cancel', async () => {
    const retrieve = vi.fn(async () => ({ id: 'pi_123', status: 'processing', amount: 20000 }))
    const cancel = vi.fn(async () => ({ id: 'pi_123', status: 'canceled' }))
    const { processor: p } = undoClient({ retrieve, cancel })

    const undo = await p.refund(REFUND_INPUT)

    expect(undo).toEqual({ provider: 'stripe', ref: 'pi_123', status: 'succeeded', mode: 'voided' })
    expect(cancel).toHaveBeenCalledWith('pi_123', undefined, {
      idempotencyKey: 'idem:refund:cancel',
    })
  })

  it('crash-replay: PI already canceled → reports the void without any POST', async () => {
    const retrieve = vi.fn(async () => ({ id: 'pi_123', status: 'canceled' }))
    const { processor: p } = undoClient({ retrieve })
    expect(await p.refund(REFUND_INPUT)).toEqual({
      provider: 'stripe',
      ref: 'pi_123',
      status: 'succeeded',
      mode: 'voided',
    })
  })

  it('refuses a partial amount against an uncleared PI — cancel is all-or-nothing', async () => {
    const retrieve = vi.fn(async () => ({ id: 'pi_123', status: 'processing', amount: 30000 }))
    const { processor: p } = undoClient({ retrieve })
    await expect(p.refund(REFUND_INPUT)).rejects.toThrow(/voided in full/)
  })

  it('settlement races the read: cancel refused → re-resolve → refund arm', async () => {
    const retrieve = vi
      .fn()
      .mockResolvedValueOnce({ id: 'pi_123', status: 'processing', amount: 20000 })
      .mockResolvedValueOnce({ id: 'pi_123', status: 'succeeded', amount: 20000 })
    const cancel = vi.fn(async () => {
      throw NOT_CANCELABLE
    })
    const create = vi.fn(async () => ({ id: 're_2', status: 'pending' }))
    const { processor: p } = undoClient({ retrieve, cancel, create })

    const undo = await p.refund(REFUND_INPUT)
    expect(undo).toEqual({ provider: 'stripe', ref: 're_2', status: 'pending', mode: 'refunded' })
    expect(retrieve).toHaveBeenCalledTimes(2)
  })
})

describe('undoModeForRef — the persisted-ref mode encoding', () => {
  it.each([
    ['pi_abc123', 'voided'],
    ['mockvoid_9d1', 'voided'],
    ['re_abc123', 'refunded'],
    ['mockrefund_9d1', 'refunded'],
    // unknown namespace → the pre-S2 posting, whose error recon can see
    ['legacy_ref', 'refunded'],
  ] as const)('%s → %s', (ref, mode) => {
    expect(undoModeForRef(ref)).toBe(mode)
  })

  it('agrees with the mode the adapter reports on fresh undos (prefix IS the encoding)', async () => {
    const cancel = vi.fn(async () => ({ id: 'pi_123', status: 'canceled' }))
    const { processor: voidP } = undoClient({ cancel })
    const voided = await voidP.voidFunding(VOID_INPUT)
    expect(undoModeForRef(voided.ref)).toBe(voided.mode)

    const retrieve = vi.fn(async () => ({ id: 'pi_123', status: 'succeeded', amount: 20000 }))
    const create = vi.fn(async () => ({ id: 're_9', status: 'pending' }))
    const { processor: refundP } = undoClient({ retrieve, create })
    const refunded = await refundP.refund(REFUND_INPUT)
    expect(undoModeForRef(refunded.ref)).toBe(refunded.mode)
  })
})

describe('stripe parseEvent — refund tails (PR-S2)', () => {
  const refundEventBody = (
    type = 'refund.failed',
    objectOverrides: Record<string, unknown> = {},
  ) =>
    Buffer.from(
      JSON.stringify({
        id: 'evt_r1',
        type,
        data: {
          object: {
            id: 're_1',
            object: 'refund',
            payment_intent: 'pi_123',
            status: 'failed',
            failure_reason: 'declined',
            metadata: { transfer_id: TRANSFER_ID },
            ...objectOverrides,
          },
        },
      }),
    )

  it('refund.failed → refund_failed with the echo, the PI join key, the refund id, and the cause', () => {
    expect(processor.parseEvent(refundEventBody())).toEqual({
      outcome: 'event',
      event: {
        eventId: 'evt_r1',
        type: 'refund_failed',
        transferRef: TRANSFER_ID,
        paymentRef: 'pi_123',
        undoRef: 're_1',
        reason: 'declined',
      },
    })
  })

  it.each(['failed', 'canceled'])(
    'refund.updated carrying status=%s is also the bounce — a refund that will never arrive',
    (status) => {
      const parsed = processor.parseEvent(refundEventBody('refund.updated', { status }))
      expect(parsed.outcome === 'event' && parsed.event.type).toBe('refund_failed')
    },
  )

  it.each(['refund.updated', 'charge.refund.updated'])(
    '%s with status=succeeded → refund_settled, and never carries a reason',
    (type) => {
      const parsed = processor.parseEvent(refundEventBody(type, { status: 'succeeded' }))
      expect(parsed).toEqual({
        outcome: 'event',
        event: {
          eventId: 'evt_r1',
          type: 'refund_settled',
          transferRef: TRANSFER_ID,
          paymentRef: 'pi_123',
          undoRef: 're_1',
        },
      })
    },
  )

  it('acks pending-status churn and refunds with no PI join as unhandled', () => {
    expect(processor.parseEvent(refundEventBody('refund.updated', { status: 'pending' }))).toEqual({
      outcome: 'unhandled',
      eventId: 'evt_r1',
      eventType: 'refund.updated',
    })
    expect(processor.parseEvent(refundEventBody('refund.failed', { payment_intent: null }))).toEqual(
      { outcome: 'unhandled', eventId: 'evt_r1', eventType: 'refund.failed' },
    )
  })

  it('a dashboard-issued refund (no metadata echo) still maps, with a null transferRef for the route join', () => {
    const parsed = processor.parseEvent(refundEventBody('refund.failed', { metadata: {} }))
    expect(parsed.outcome === 'event' && parsed.event.transferRef).toBeNull()
    expect(parsed.outcome === 'event' && parsed.event.paymentRef).toBe('pi_123')
  })

  it('a refund envelope with no object payload is malformed', () => {
    expect(
      processor.parseEvent(Buffer.from(JSON.stringify({ id: 'evt_r1', type: 'refund.failed' }))),
    ).toEqual({ outcome: 'malformed' })
  })
})
