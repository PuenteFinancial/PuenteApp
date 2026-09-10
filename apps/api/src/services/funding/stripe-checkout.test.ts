import { describe, it, expect, vi } from 'vitest'
import Stripe from 'stripe'
import { StripeCheckoutFundingProcessor, normalizeCheckoutStatus } from './stripe-checkout.js'
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

  it('acks payment_intent.processing as unhandled — completed is funding here, and processing beats it', () => {
    // Bank debit emits `processing` ~1s BEFORE `checkout.session.completed`
    // (cards never emit it). Falling through would fund the row a second
    // early under the PI's ref — the 2026-09-10 overwrite. The session event
    // carries everything this rail needs.
    const piProcessing = Buffer.from(
      JSON.stringify({
        id: 'evt_p',
        type: 'payment_intent.processing',
        data: { object: { id: 'pi_123', status: 'processing', metadata: { transfer_id: TRANSFER_ID } } },
      }),
    )
    const result = make().parseEvent(piProcessing)
    expect(result).toEqual({ outcome: 'unhandled', eventId: 'evt_p', eventType: 'payment_intent.processing' })
  })

  it('acks payment_intent.payment_failed as unhandled — a declined card must NOT kill the transfer', () => {
    // The premise this test used to encode ("pre-settlement returns need it")
    // was wrong: on this rail a delayed-method failure arrives as
    // checkout.session.async_payment_failed, and a card decline is
    // synchronous. Letting the PI event through failed a transfer on an
    // ordinary decline while the Element still offered a retry.
    const failed = Buffer.from(
      JSON.stringify({
        id: 'evt_f',
        type: 'payment_intent.payment_failed',
        data: { object: { id: 'pi_123', metadata: { transfer_id: TRANSFER_ID } } },
      }),
    )
    expect(make().parseEvent(failed)).toEqual({
      outcome: 'unhandled',
      eventId: 'evt_f',
      eventType: 'payment_intent.payment_failed',
    })
  })

  it('async_payment_failed IS the failure signal, and still maps', () => {
    const result = make().parseEvent(
      sessionEvent('checkout.session.async_payment_failed', { payment_status: 'unpaid' }),
    )
    expect(result.outcome).toBe('event')
    if (result.outcome !== 'event') return
    expect(result.event.type).toBe('funding_failed')
  })

  // The reachability question this rail's own PRD flags: funding_payment_ref
  // stores the SESSION id (cs_…), but a payment_intent.* event's paymentRef is
  // the PaymentIntent id (pi_…) — a different id space. IF a metadata-less
  // payment_intent.succeeded/payment_failed ever fell through to the parent
  // parser, a route-level fallback join on funding_payment_ref would compare
  // across those spaces and always miss. Confirmed unreachable instead
  // (stripe.ts parseEvent, researched 2026-09-09): the parser classifies this
  // as `unhandled` before any join is attempted, for both PI event types.
  it('a metadata-less PI event falls through to unhandled, not a mismatched fallback join', () => {
    for (const type of ['payment_intent.succeeded', 'payment_intent.payment_failed']) {
      const piEvent = Buffer.from(
        JSON.stringify({
          id: 'evt_pi_no_meta',
          type,
          data: { object: { id: 'pi_orphan', metadata: {} } },
        }),
      )
      expect(make().parseEvent(piEvent)).toEqual({
        outcome: 'unhandled',
        eventId: 'evt_pi_no_meta',
        eventType: type,
      })
    }
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

  it('accepts a ref that is already the PaymentIntent — the rows the ACH overwrite left behind', async () => {
    // Two staging rows carry a pi_ ref from 2026-09-10 (the overwrite is fixed
    // upstream, the rows remain). Retrieving a Session by a pi_ id 404s, which
    // would make exactly the transfers that exposed the bug un-refundable.
    const { retrieveSession, processor } = undoClient({ status: 'processing' })
    const undo = await processor.voidFunding({
      transferId: TRANSFER_ID,
      paymentRef: 'pi_already',
      idempotencyKey: 'key-pi',
    })
    expect(retrieveSession).not.toHaveBeenCalled()
    expect(undo.mode).toBe('voided')
  })

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

describe("StripeCheckoutFundingProcessor — expireFunding (the reaper's stale-tab guard)", () => {
  const client = (status: string) => {
    const expire = vi.fn().mockResolvedValue({ id: SESSION_ID, status: 'expired' })
    const retrieve = vi.fn().mockResolvedValue({ id: SESSION_ID, status, payment_status: 'unpaid' })
    return { expire, retrieve, processor: make({ checkout: { sessions: { create: vi.fn(), retrieve, expire } } }) }
  }

  it('expires an open session and says so', async () => {
    const { expire, processor } = client('open')
    await expect(processor.expireFunding({ paymentRef: SESSION_ID })).resolves.toBe('expired')
    expect(expire).toHaveBeenCalledWith(SESSION_ID)
  })

  it('a completed session is NOT ours to close — the sender paid, the webhook is coming', async () => {
    const { expire, processor } = client('complete')
    await expect(processor.expireFunding({ paymentRef: SESSION_ID })).resolves.toBe('not_open')
    expect(expire).not.toHaveBeenCalled()
  })

  it('the sender paying BETWEEN retrieve and expire is answered not_open, deliberately', async () => {
    // Stripe refuses to expire a completed session. Rather than lean on the
    // reaper skipping any throw, this re-reads and answers for what it sees.
    const expire = vi.fn().mockRejectedValue(
      Object.assign(new Error('Cannot expire a completed session'), { type: 'StripeInvalidRequestError' }),
    )
    const retrieve = vi
      .fn()
      .mockResolvedValueOnce({ id: SESSION_ID, status: 'open', payment_status: 'unpaid' })
      .mockResolvedValueOnce({ id: SESSION_ID, status: 'complete', payment_status: 'paid' })
    const processor = make({ checkout: { sessions: { create: vi.fn(), retrieve, expire } } })
    await expect(processor.expireFunding({ paymentRef: SESSION_ID })).resolves.toBe('not_open')
    expect(retrieve).toHaveBeenCalledTimes(2)
  })

  it('a transport failure on expire propagates — the reaper skips the tick, the window backstops', async () => {
    const expire = vi.fn().mockRejectedValue(new Error('ECONNRESET'))
    const retrieve = vi.fn().mockResolvedValue({ id: SESSION_ID, status: 'open', payment_status: 'unpaid' })
    const processor = make({ checkout: { sessions: { create: vi.fn(), retrieve, expire } } })
    await expect(processor.expireFunding({ paymentRef: SESSION_ID })).rejects.toThrow('ECONNRESET')
  })

  it("an already-expired session is Stripe's clock having won; nothing to do", async () => {
    const { expire, processor } = client('expired')
    await expect(processor.expireFunding({ paymentRef: SESSION_ID })).resolves.toBe('not_open')
    expect(expire).not.toHaveBeenCalled()
  })
})

describe('normalizeCheckoutStatus — the Session in reconciliation\'s vocabulary', () => {
  it('maps every shape a Session can take', () => {
    expect(normalizeCheckoutStatus('open', 'unpaid')).toBe('awaiting')
    expect(normalizeCheckoutStatus('expired', 'unpaid')).toBe('canceled')
    // Bank debit: completed but the pull is still settling and can still fail.
    expect(normalizeCheckoutStatus('complete', 'unpaid')).toBe('processing')
    // Card: settled on completion.
    expect(normalizeCheckoutStatus('complete', 'paid')).toBe('succeeded')
    expect(normalizeCheckoutStatus('complete', 'no_payment_required')).toBe('succeeded')
  })

  it('an unrecognized vocabulary degrades to awaiting — never to a page on every row', () => {
    expect(normalizeCheckoutStatus('unknown', 'unknown')).toBe('awaiting')
    expect(normalizeCheckoutStatus('some_new_state', 'paid')).toBe('awaiting')
  })

  it('a pi_ ref — the rows the overwrite left behind — is read from the PaymentIntent', async () => {
    const retrieveSession = vi.fn()
    const retrievePi = vi.fn().mockResolvedValue({ id: 'pi_left_behind', status: 'succeeded' })
    const processor = make({
      checkout: { sessions: { create: vi.fn(), retrieve: retrieveSession, expire: vi.fn() } },
      paymentIntents: { retrieve: retrievePi, cancel: vi.fn(), create: vi.fn() },
    })
    await expect(processor.getPaymentStatus({ paymentRef: 'pi_left_behind' })).resolves.toEqual({
      paymentRef: 'pi_left_behind',
      status: 'succeeded',
      normalized: 'succeeded',
    })
    expect(retrieveSession).not.toHaveBeenCalled()
  })

  it('getPaymentStatus carries both the raw pair and the normalized reading', async () => {
    const retrieve = vi.fn().mockResolvedValue({ id: SESSION_ID, status: 'complete', payment_status: 'unpaid' })
    const processor = make({ checkout: { sessions: { create: vi.fn(), retrieve, expire: vi.fn() } } })
    await expect(processor.getPaymentStatus({ paymentRef: SESSION_ID })).resolves.toEqual({
      paymentRef: SESSION_ID,
      status: 'complete/unpaid',
      normalized: 'processing',
    })
  })
})

describe('StripeCheckoutFundingProcessor — resolveAlternateFundingRef', () => {
  // The route's fallback join (charge.dispute.created / a dashboard-issued
  // refund) compares funding_payment_ref against a PaymentIntent id — a miss
  // on this rail, since funding_payment_ref holds the Session id. This is the
  // reverse lookup that closes it: Stripe's List Checkout Sessions endpoint
  // supports filtering by payment_intent.
  it('resolves the Session id behind a PaymentIntent id', async () => {
    const list = vi.fn().mockResolvedValue({ data: [{ id: SESSION_ID }] })
    const processor = make({ checkout: { sessions: { create: vi.fn(), retrieve: vi.fn(), list } } })
    const result = await processor.resolveAlternateFundingRef('pi_resolved')
    expect(list).toHaveBeenCalledWith({ payment_intent: 'pi_resolved', limit: 1 })
    expect(result).toBe(SESSION_ID)
  })

  it('returns null for a ref that is not a PaymentIntent id, without calling Stripe', async () => {
    const list = vi.fn()
    const processor = make({ checkout: { sessions: { create: vi.fn(), retrieve: vi.fn(), list } } })
    expect(await processor.resolveAlternateFundingRef('cs_not_a_pi')).toBeNull()
    expect(list).not.toHaveBeenCalled()
  })

  it('returns null when no Session matches the PaymentIntent', async () => {
    const list = vi.fn().mockResolvedValue({ data: [] })
    const processor = make({ checkout: { sessions: { create: vi.fn(), retrieve: vi.fn(), list } } })
    expect(await processor.resolveAlternateFundingRef('pi_orphan')).toBeNull()
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
