import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import Stripe from 'stripe'
import { env } from '../../config/env.js'
import {
  FundingInitiationError,
  undoModeForRef,
  undoRequiresManualDisbursement,
} from './index.js'
import { StripeOnrampFundingProcessor, StripeOnrampApiError } from './stripe-onramp.js'

// setup.ts provides STRIPE_WEBHOOK_SECRET (and deliberately NOT
// STRIPE_SECRET_KEY — the construction/isConfigured tests rely on that split).
const WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET!

// A real Stripe client (dummy key, never hits the network) so verifySignature
// exercises the SDK's actual constructEvent HMAC + tolerance logic, and
// generateTestHeaderString produces genuine signature vectors.
const realClient = new Stripe('sk_test_dummy')
const processor = new StripeOnrampFundingProcessor('sk_test_dummy')

const TRANSFER_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const DEST_ADDRESS = '0x00b5D64Db67dE9E1BdDc61cf1D0Cd704e0B9970A'

const fetchMock = vi.fn()
vi.stubGlobal('fetch', fetchMock)

function fetchResponds(status: number, body: unknown) {
  fetchMock.mockResolvedValue({
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  })
}

const SESSION = {
  id: 'cos_1',
  object: 'crypto.onramp_session',
  client_secret: 'cos_1_secret_x',
  status: 'initialized',
}

const sessionEventBody = (
  status = 'fulfillment_processing',
  objectOverrides: Record<string, unknown> = {},
  envelopeOverrides: Record<string, unknown> = {},
) =>
  Buffer.from(
    JSON.stringify({
      id: 'evt_1',
      type: 'crypto.onramp_session.updated',
      data: {
        object: {
          id: 'cos_1',
          object: 'crypto.onramp_session',
          status,
          metadata: { transfer_id: TRANSFER_ID },
          ...objectOverrides,
        },
      },
      ...envelopeOverrides,
    }),
  )

const signed = (body: Buffer, secret: string = WEBHOOK_SECRET, timestamp?: number) =>
  realClient.webhooks.generateTestHeaderString({
    payload: body.toString('utf8'),
    secret,
    ...(timestamp !== undefined && { timestamp }),
  })

let savedAddress: string | undefined
beforeEach(() => {
  fetchMock.mockReset()
  savedAddress = env.ONRAMP_DESTINATION_ADDRESS
  env.ONRAMP_DESTINATION_ADDRESS = DEST_ADDRESS
})
afterEach(() => {
  env.ONRAMP_DESTINATION_ADDRESS = savedAddress
})

describe('StripeOnrampFundingProcessor construction', () => {
  it('refuses default construction without STRIPE_SECRET_KEY', () => {
    expect(env.STRIPE_SECRET_KEY).toBeUndefined()
    expect(() => new StripeOnrampFundingProcessor()).toThrow(/STRIPE_SECRET_KEY/)
  })
})

describe('onramp isConfigured', () => {
  it('requires the stripe trio AND the destination address', () => {
    const savedSecret = env.STRIPE_SECRET_KEY
    const savedPublishable = env.STRIPE_PUBLISHABLE_KEY
    try {
      expect(env.STRIPE_WEBHOOK_SECRET).toBeTruthy()
      expect(processor.isConfigured()).toBe(false) // no secret key in test env
      env.STRIPE_SECRET_KEY = 'sk_test_dummy'
      env.STRIPE_PUBLISHABLE_KEY = 'pk_test_dummy'
      expect(processor.isConfigured()).toBe(true)
      // The address is load-bearing: without it a session couldn't lock the
      // delivery wallet, so the gate must refuse exactly like a missing key.
      env.ONRAMP_DESTINATION_ADDRESS = undefined
      expect(processor.isConfigured()).toBe(false)
    } finally {
      env.STRIPE_SECRET_KEY = savedSecret
      env.STRIPE_PUBLISHABLE_KEY = savedPublishable
      env.ONRAMP_DESTINATION_ADDRESS = DEST_ADDRESS
    }
  })
})

describe('onramp initiateFunding', () => {
  const input = {
    transferId: TRANSFER_ID,
    userId: 'user-1',
    totalAmountMinor: 20000,
    currency: 'USD' as const,
  }

  it('creates a destination-fixed, wallet-locked session with the transfer echo', async () => {
    fetchResponds(200, SESSION)

    const initiation = await processor.initiateFunding({
      ...input,
      clientIp: '203.0.113.7',
      customer: { firstName: 'Ana', lastName: 'García', email: 'ana@example.com' },
    })

    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [url, init] = fetchMock.mock.calls[0]! as [string, RequestInit]
    expect(url).toBe('https://api.stripe.com/v1/crypto/onramp_sessions')
    expect(init.method).toBe('POST')
    // Bounded waiting (funding-seam timeout contract)
    expect(init.signal).toBeInstanceOf(AbortSignal)
    const headers = init.headers as Record<string, string>
    expect(headers['Authorization']).toBe('Bearer sk_test_dummy')
    expect(headers['Content-Type']).toBe('application/x-www-form-urlencoded')
    // One session per transfer, ever — same key contract as the PI rail
    expect(headers['Idempotency-Key']).toBe(`funding_init_${TRANSFER_ID}`)

    const params = init.body as URLSearchParams
    // Amount is destination-fixed: send+fee in USDC at par, decimal string
    expect(params.get('destination_amount')).toBe('200.00')
    expect(params.get('source_currency')).toBe('usd')
    expect(params.get('destination_currency')).toBe('usdc')
    expect(params.get('destination_network')).toBe('base')
    // Single-value restriction arrays are what make the pin UNoverridable —
    // the singular fields alone are just widget defaults
    expect(params.get('destination_currencies[]')).toBe('usdc')
    expect(params.get('destination_networks[]')).toBe('base')
    // Singular on purpose — wallet_addresses[base] is parameter_unknown on
    // the live API (sandbox-verified 2026-08-25); see the adapter comment.
    expect(params.get('wallet_address')).toBe(DEST_ADDRESS)
    expect(params.has('wallet_addresses[base]')).toBe(false)
    expect(params.get('lock_wallet_address')).toBe('true')
    expect(params.get('metadata[transfer_id]')).toBe(TRANSFER_ID)
    expect(params.get('customer_ip_address')).toBe('203.0.113.7')
    expect(params.get('customer_information[first_name]')).toBe('Ana')
    expect(params.get('customer_information[last_name]')).toBe('García')
    expect(params.get('customer_information[email]')).toBe('ana@example.com')

    expect(initiation).toEqual({
      provider: 'stripe_onramp',
      method: 'onramp',
      paymentRef: 'cos_1',
      clientFields: { client_secret: 'cos_1_secret_x' },
    })
  })

  it('omits ip and prefill params when absent rather than sending empties', async () => {
    fetchResponds(200, SESSION)
    await processor.initiateFunding(input)
    const params = (fetchMock.mock.calls[0]![1] as RequestInit).body as URLSearchParams
    expect(params.has('customer_ip_address')).toBe(false)
    expect(params.has('customer_information[first_name]')).toBe(false)
    expect(params.has('customer_information[email]')).toBe(false)
  })

  it('fails loudly on a session created without a client_secret', async () => {
    fetchResponds(200, { ...SESSION, client_secret: null })
    await expect(processor.initiateFunding(input)).rejects.toThrow(/client_secret/)
  })

  it('fails loudly on a session created without an id', async () => {
    fetchResponds(200, { ...SESSION, id: undefined })
    await expect(processor.initiateFunding(input)).rejects.toThrow(/id/)
  })

  it('refuses when ONRAMP_DESTINATION_ADDRESS is unset — never mints an unlocked session', async () => {
    env.ONRAMP_DESTINATION_ADDRESS = undefined
    await expect(processor.initiateFunding(input)).rejects.toThrow(/ONRAMP_DESTINATION_ADDRESS/)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it.each(['crypto_onramp_unsupportable_customer', 'crypto_onramp_unsupported_country'])(
    'maps a %s 400 to FundingInitiationError(unsupported)',
    async (code) => {
      fetchResponds(400, { error: { type: 'invalid_request_error', code } })
      await expect(processor.initiateFunding(input)).rejects.toThrow(
        expect.objectContaining({ name: 'FundingInitiationError', code: 'unsupported' }),
      )
    },
  )

  it('maps the crypto_onramp_disabled kill switch to FundingInitiationError(disabled)', async () => {
    fetchResponds(400, { error: { type: 'api_error', code: 'crypto_onramp_disabled' } })
    const err = await processor.initiateFunding(input).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(FundingInitiationError)
    expect((err as FundingInitiationError).code).toBe('disabled')
  })

  it('rethrows other Stripe errors untranslated, with the body unprintable', async () => {
    fetchResponds(402, { error: { code: 'something_else', message: 'Ana García owes money' } })
    const err = await processor.initiateFunding(input).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(StripeOnrampApiError)
    expect((err as StripeOnrampApiError).status).toBe(402)
    // PII discipline (BridgeApiError precedent): the body is readable for
    // branching but never enumerable — inspect/JSON output stays status-only.
    expect(JSON.stringify(err)).not.toContain('Ana')
    expect((err as Error).message).not.toContain('Ana')
  })

  it('names the error code and param in the message — enums only, never error.message', async () => {
    // The 2026-08-25 staging smoke: a bare "status 400" forced a dashboard
    // log dive to learn WHICH param Stripe refused. code + param are machine
    // strings and safe; error.message can interpolate request values.
    fetchResponds(400, {
      error: {
        code: 'parameter_unknown',
        param: 'wallet_addresses[base]',
        message: 'Received unknown parameter: wallet_addresses[base]',
        type: 'invalid_request_error',
      },
    })
    const err = await processor.initiateFunding(input).catch((e: unknown) => e)
    expect((err as Error).message).toBe(
      'Stripe onramp API request failed with status 400 (parameter_unknown: wallet_addresses[base])',
    )
  })
})

describe('onramp getClientSession', () => {
  it('retrieves the live session and returns secret + publishable key + status', async () => {
    const savedPk = env.STRIPE_PUBLISHABLE_KEY
    env.STRIPE_PUBLISHABLE_KEY = 'pk_test_dummy'
    try {
      fetchResponds(200, { ...SESSION, status: 'requires_payment' })
      const session = await processor.getClientSession({ paymentRef: 'cos_1' })
      const [url, init] = fetchMock.mock.calls[0]! as [string, RequestInit]
      expect(url).toBe('https://api.stripe.com/v1/crypto/onramp_sessions/cos_1')
      expect(init.method).toBe('GET')
      expect(session).toEqual({
        provider: 'stripe_onramp',
        fields: {
          clientSecret: 'cos_1_secret_x',
          publishableKey: 'pk_test_dummy',
          status: 'requires_payment',
        },
      })
    } finally {
      env.STRIPE_PUBLISHABLE_KEY = savedPk
    }
  })

  it('fails loudly on a session retrieved without a client_secret', async () => {
    fetchResponds(200, { ...SESSION, client_secret: '' })
    await expect(processor.getClientSession({ paymentRef: 'cos_1' })).rejects.toThrow(
      /client_secret/,
    )
  })
})

describe('onramp verifySignature (real SDK vectors)', () => {
  const body = sessionEventBody()

  it('accepts a genuine signature over the exact bytes', () => {
    expect(processor.verifySignature(body, signed(body))).toBe(true)
  })

  it('rejects a signature under the wrong secret', () => {
    expect(processor.verifySignature(body, signed(body, 'whsec_wrong_secret_x'))).toBe(false)
  })

  it('rejects a stale timestamp (replay window)', () => {
    const stale = Math.floor(Date.now() / 1000) - 600
    expect(processor.verifySignature(body, signed(body, WEBHOOK_SECRET, stale))).toBe(false)
  })

  it('rejects a tampered body', () => {
    const tampered = sessionEventBody('fulfillment_complete')
    expect(processor.verifySignature(tampered, signed(body))).toBe(false)
  })

  it('rejects when the header is empty', () => {
    expect(processor.verifySignature(body, '')).toBe(false)
  })
})

describe('onramp parseEvent', () => {
  it.each([
    ['fulfillment_processing', 'funding_succeeded'],
    ['fulfillment_complete', 'funding_cleared'],
    ['rejected', 'funding_failed'],
  ])('maps session status %s to %s', (status, expected) => {
    const result = processor.parseEvent(sessionEventBody(status))
    expect(result).toEqual({
      outcome: 'event',
      event: {
        eventId: 'evt_1',
        type: expected,
        transferRef: TRANSFER_ID,
        paymentRef: 'cos_1',
      },
    })
  })

  it.each(['initialized', 'requires_payment', 'some_future_status'])(
    'acks pre-payment / unknown status %s as unhandled — never evidence money moved',
    (status) => {
      expect(processor.parseEvent(sessionEventBody(status))).toEqual({
        outcome: 'unhandled',
        eventId: 'evt_1',
        eventType: 'crypto.onramp_session.updated',
      })
    },
  )

  it('acks other event types as unhandled', () => {
    const body = sessionEventBody('fulfillment_complete', {}, { type: 'payment.exploded' })
    expect(processor.parseEvent(body)).toMatchObject({
      outcome: 'unhandled',
      eventType: 'payment.exploded',
    })
  })

  it('acks a session without the transfer echo (not minted by this rail)', () => {
    const body = sessionEventBody('fulfillment_complete', { metadata: {} })
    expect(processor.parseEvent(body)).toMatchObject({ outcome: 'unhandled' })
  })

  it.each([
    ['garbage bytes', Buffer.from('not json')],
    ['missing envelope id/type', Buffer.from(JSON.stringify({ data: {} }))],
    [
      'session without an id',
      sessionEventBody('fulfillment_complete', { id: undefined }),
    ],
    ['session without a status', sessionEventBody('fulfillment_complete', { status: null })],
  ])('classifies %s as malformed without throwing', (_label, body) => {
    expect(processor.parseEvent(body)).toEqual({ outcome: 'malformed' })
  })
})

describe('onramp undo ops', () => {
  it.each(['voidFunding', 'refund'] as const)(
    '%s issues nothing and reports a pending manual refund obligation',
    async (op) => {
      const undo = await processor[op]()
      expect(undo.provider).toBe('stripe_onramp')
      expect(undo.ref).toMatch(/^onramprefund_/)
      // The money is real and collected (USDC in the treasury) and the onramp
      // has no refund API — claiming 'succeeded' would tell the sender they
      // were made whole when no disbursement exists.
      expect(undo.status).toBe('pending')
      expect(undo.mode).toBe('refunded')
    },
  )

  it('the ref namespace round-trips through the crash-recovery helpers', () => {
    expect(undoModeForRef('onramprefund_abc')).toBe('refunded')
    expect(undoRequiresManualDisbursement('onramprefund_abc')).toBe(true)
  })
})
