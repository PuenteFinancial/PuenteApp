import { describe, it, expect, vi } from 'vitest'
import Stripe from 'stripe'
import { StripeCheckoutFundingProcessor } from './stripe-checkout.js'
import { undoModeForRef } from './index.js'

// The Checkout Sessions rail. Mirrors stripe.test.ts's harness — a real Stripe
// client with a dummy key so verifySignature exercises the SDK's genuine HMAC
// logic, and the API surface stubbed per test.
const WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET!
const realClient = new Stripe('sk_test_dummy')
const TRANSFER_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const SESSION_ID = 'cs_test_123'

const make = (overrides: Record<string, unknown> = {}) =>
  new StripeCheckoutFundingProcessor({
    ...realClient,
    checkout: { sessions: { create: vi.fn(), retrieve: vi.fn() } },
    paymentIntents: { cancel: vi.fn(), retrieve: vi.fn(), create: vi.fn() },
    refunds: { create: vi.fn() },
    webhooks: realClient.webhooks,
    ...overrides,
  } as unknown as Stripe)

const sessionEvent = (type: string, object: Record<string, unknown> = {}) =>
  Buffer.from(
    JSON.stringify({
      id: 'evt_1',
      type,
      data: {
        object: {
          id: SESSION_ID,
          object: 'checkout.session',
          metadata: { transfer_id: TRANSFER_ID },
          ...object,
        },
      },
    }),
  )

describe('StripeCheckoutFundingProcessor — event mapping', () => {
  // THE money bug this rail nearly shipped with. `completed` on a card arrives
  // payment_status='paid', which reads like "cleared". Mapping it that way
  // would set a flag on a transfer still at PENDING_PAYMENT, post NO ledger
  // entry (applyFundingCleared skips the posting for that state), and let the
  // abandonment sweep fail the transfer — after the sender's card was charged.
  it('completed ALWAYS means funded — including a card that is already paid', () => {
    for (const paymentStatus of ['unpaid', 'paid', 'no_payment_required']) {
      const result = make().parseEvent(
        sessionEvent('checkout.session.completed', { payment_status: paymentStatus }),
      )
      expect(result.outcome, paymentStatus).toBe('event')
      if (result.outcome !== 'event') return
      expect(result.event.type, `payment_status=${paymentStatus}`).toBe('funding_succeeded')
      expect(result.event.paymentRef).toBe(SESSION_ID)
      expect(result.event.transferRef).toBe(TRANSFER_ID)
    }
  })

  it('maps the two async outcomes', () => {
    const ok = make().parseEvent(sessionEvent('checkout.session.async_payment_succeeded'))
    expect(ok.outcome === 'event' && ok.event.type).toBe('funding_cleared')
    const bad = make().parseEvent(sessionEvent('checkout.session.async_payment_failed'))
    expect(bad.outcome === 'event' && bad.event.type).toBe('funding_failed')
  })

  // Card clearing arrives ONLY as payment_intent.succeeded — a card session
  // emits no async event ever. The parent class already parses PI events, so
  // the fall-through is what makes card transfers clear at all.
  it('falls through to the parent for payment_intent events — card clearing depends on it', () => {
    const piEvent = Buffer.from(
      JSON.stringify({
        id: 'evt_2',
        type: 'payment_intent.succeeded',
        data: {
          object: { id: 'pi_123', metadata: { transfer_id: TRANSFER_ID } },
        },
      }),
    )
    const result = make().parseEvent(piEvent)
    expect(result.outcome).toBe('event')
    if (result.outcome !== 'event') return
    expect(result.event.type).toBe('funding_cleared')
    expect(result.event.transferRef).toBe(TRANSFER_ID)
  })

  it('acks a session we did not create rather than 400ing into a redelivery loop', () => {
    const orphan = Buffer.from(
      JSON.stringify({
        id: 'evt_3',
        type: 'checkout.session.completed',
        data: { object: { id: 'cs_other', metadata: {} } },
      }),
    )
    expect(make().parseEvent(orphan).outcome).toBe('unhandled')
  })

  it('rejects malformed bodies', () => {
    expect(make().parseEvent(Buffer.from('not json')).outcome).toBe('malformed')
  })
})

describe('StripeCheckoutFundingProcessor — session creation', () => {
  it('creates an elements-mode session, echoes the transfer on BOTH objects, and forces instant bank verification', async () => {
    const create = vi.fn().mockResolvedValue({ id: SESSION_ID, client_secret: 'cs_secret_x' })
    const processor = make({ checkout: { sessions: { create, retrieve: vi.fn() } } })

    const initiation = await processor.initiateFunding({
      transferId: TRANSFER_ID,
      userId: 'user-1',
      totalAmountMinor: 10_200,
      currency: 'USD',
    })

    const [params, options] = create.mock.calls[0]!
    expect(params.ui_mode).toBe('elements')
    expect(params.mode).toBe('payment')
    expect(params.line_items[0].price_data.unit_amount).toBe(10_200)
    // The echo has to be on the PaymentIntent too, or card clearing can never
    // be joined back to a transfer.
    expect(params.metadata).toEqual({ transfer_id: TRANSFER_ID })
    expect(params.payment_intent_data.metadata).toEqual({ transfer_id: TRANSFER_ID })
    // Micro-deposits take days and outlive both the abandonment clock and the
    // FX quote, so this rail never offers them.
    expect(params.payment_method_options.us_bank_account.verification_method).toBe('instant')
    // No payment_method_types: the whole point of this rail is that the method
    // list is Dashboard configuration, not a hard-coded array.
    expect(params.payment_method_types).toBeUndefined()
    expect(options).toEqual({ idempotencyKey: `checkout_init_${TRANSFER_ID}` })

    // The SESSION id is what gets persisted — it exists from confirm onward,
    // where the PaymentIntent does not exist until the sender pays.
    expect(initiation.paymentRef).toBe(SESSION_ID)
    expect(initiation.provider).toBe('stripe_checkout')
    expect(initiation).not.toHaveProperty('clientFields')
  })

  it('never puts PII in the session — only the join key', async () => {
    const create = vi.fn().mockResolvedValue({ id: SESSION_ID, client_secret: 'x' })
    const processor = make({ checkout: { sessions: { create, retrieve: vi.fn() } } })
    await processor.initiateFunding({
      transferId: TRANSFER_ID,
      userId: 'user-secret-1',
      totalAmountMinor: 10_200,
      currency: 'USD',
    })
    expect(JSON.stringify(create.mock.calls[0]![0])).not.toContain('user-secret-1')
  })

  it('throws rather than returning a session the Payment Element cannot mount', async () => {
    const create = vi.fn().mockResolvedValue({ id: SESSION_ID, client_secret: null })
    const processor = make({ checkout: { sessions: { create, retrieve: vi.fn() } } })
    await expect(
      processor.initiateFunding({
        transferId: TRANSFER_ID,
        userId: 'u',
        totalAmountMinor: 100,
        currency: 'USD',
      }),
    ).rejects.toThrow(/client_secret/)
  })
})

describe('StripeCheckoutFundingProcessor — undos resolve the session first', () => {
  const undoClient = (piState: Record<string, unknown>, extra: Record<string, unknown> = {}) => {
    const retrieveSession = vi.fn().mockResolvedValue({
      id: SESSION_ID,
      status: 'complete',
      payment_status: 'paid',
      payment_intent: 'pi_resolved',
      ...extra,
    })
    return {
      retrieveSession,
      processor: make({
        checkout: { sessions: { create: vi.fn(), retrieve: retrieveSession } },
        paymentIntents: {
          cancel: vi.fn().mockResolvedValue({ id: 'pi_resolved', status: 'canceled' }),
          retrieve: vi.fn().mockResolvedValue({ id: 'pi_resolved', amount: 10_200, ...piState }),
          create: vi.fn(),
        },
        refunds: { create: vi.fn().mockResolvedValue({ id: 're_1', status: 'succeeded' }) },
      }),
    }
  }

  it('void translates the stored session ref into a PaymentIntent, then reuses the parent', async () => {
    const { retrieveSession, processor } = undoClient({ status: 'processing' })
    const undo = await processor.voidFunding({
      transferId: TRANSFER_ID,
      paymentRef: SESSION_ID,
      idempotencyKey: 'key-1',
    })
    expect(retrieveSession).toHaveBeenCalledWith(SESSION_ID)
    expect(undo.mode).toBe('voided')
    expect(undo.provider).toBe('stripe_checkout')
    // The ref-prefix convention still decodes correctly for the crash-recovery
    // path, which reaches the ledger holding nothing but this string.
    expect(undoModeForRef(undo.ref)).toBe('voided')
  })

  it('an uncleared pull is voided, a settled one is refunded — the parent decides, not us', async () => {
    const uncleared = undoClient({ status: 'processing' })
    const a = await uncleared.processor.refund({
      transferId: TRANSFER_ID,
      paymentRef: SESSION_ID,
      amountMinor: 10_200,
      currency: 'USD',
      idempotencyKey: 'k',
    })
    expect(a.mode).toBe('voided')

    const settled = undoClient({ status: 'succeeded' })
    const b = await settled.processor.refund({
      transferId: TRANSFER_ID,
      paymentRef: SESSION_ID,
      amountMinor: 10_200,
      currency: 'USD',
      idempotencyKey: 'k',
    })
    expect(b.mode).toBe('refunded')
    expect(undoModeForRef(b.ref)).toBe('refunded')
  })

  // Both undo paths are only reachable from FUNDED, which this rail only
  // reaches via checkout.session.completed — a completed session always has a
  // PaymentIntent. Missing one means the row is wrong, and guessing would
  // either strand a real payment or report an undo that moved no money.
  it('throws rather than guessing when the session has no PaymentIntent', async () => {
    const { processor } = undoClient({}, { payment_intent: null })
    await expect(
      processor.voidFunding({
        transferId: TRANSFER_ID,
        paymentRef: SESSION_ID,
        idempotencyKey: 'k',
      }),
    ).rejects.toThrow(/no payment_intent/)
  })
})

describe('StripeCheckoutFundingProcessor — signature verification', () => {
  it('accepts a genuine signature and rejects a forged one', () => {
    const body = sessionEvent('checkout.session.completed')
    const good = realClient.webhooks.generateTestHeaderString({
      payload: body.toString('utf8'),
      secret: WEBHOOK_SECRET,
    })
    expect(make().verifySignature(body, good)).toBe(true)
    expect(make().verifySignature(body, 't=1,v1=deadbeef')).toBe(false)
  })
})
