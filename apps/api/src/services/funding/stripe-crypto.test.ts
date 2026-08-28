import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

// The processor reads env at call time (isConfigured) — set the pair before
// import so the configured matrix can flip them per test via vi.stubEnv.
process.env.STRIPE_SECRET_KEY ??= 'sk_test_platform'
process.env.STRIPE_PUBLISHABLE_KEY ??= 'pk_test_platform'
process.env.ONRAMP_DESTINATION_ADDRESS ??= '0x' + 'a'.repeat(40)
process.env.STRIPE_CRYPTO_OAUTH_CLIENT_ID ??= 'lwlpk_test_client'
process.env.STRIPE_CRYPTO_OAUTH_CLIENT_SECRET ??= 'lwlsk_test_secret'

const { StripeCryptoFundingProcessor } = await import('./stripe-crypto.js')
const { env } = await import('../../config/env.js')

// isConfigured reads the parsed env singleton — stub IT, not process.env.
function stubEnv(key: keyof typeof env, value: unknown) {
  vi.spyOn(env, key, 'get').mockReturnValue(value as never)
}

describe('StripeCryptoFundingProcessor', () => {
  let processor: InstanceType<typeof StripeCryptoFundingProcessor>

  beforeEach(() => {
    processor = new StripeCryptoFundingProcessor()
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('carries its own provider name through the inherited machinery', () => {
    expect(processor.provider).toBe('stripe_crypto')
    expect(processor.deferredInitiation).toBe(true)
  })

  it('initiateFunding is unreachable by contract — it throws, never mints', async () => {
    await expect(processor.initiateFunding()).rejects.toThrow(/defers initiation/)
  })

  it('undo refs keep the onramprefund_ namespace (human-disbursed, refunded mode)', async () => {
    const undo = await processor.refund()
    expect(undo.provider).toBe('stripe_crypto')
    expect(undo.ref).toMatch(/^onramprefund_/)
    expect(undo.status).toBe('pending')
    expect(undo.mode).toBe('refunded')
  })

  it('inherits the widget rail webhook parsing — amount guard included', () => {
    const body = Buffer.from(
      JSON.stringify({
        id: 'evt_1',
        type: 'crypto.onramp_session.updated',
        data: {
          object: {
            id: 'cos_1',
            status: 'fulfillment_processing',
            metadata: { transfer_id: 'transfer-1' },
            transaction_details: { destination_amount: '200.00' },
          },
        },
      }),
    )
    const result = processor.parseEvent(body)
    expect(result).toEqual({
      outcome: 'event',
      event: {
        eventId: 'evt_1',
        type: 'funding_succeeded',
        transferRef: 'transfer-1',
        paymentRef: 'cos_1',
        deliveredAmountMicro: 200_000_000,
      },
    })
  })

  it('is configured only with the widget requirements PLUS the OAuth pair', () => {
    expect(processor.isConfigured()).toBe(true)

    stubEnv('STRIPE_CRYPTO_OAUTH_CLIENT_SECRET', undefined)
    expect(processor.isConfigured()).toBe(false)
  })
})
