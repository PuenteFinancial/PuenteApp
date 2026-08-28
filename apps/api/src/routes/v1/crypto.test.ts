import { describe, it, expect, beforeEach, vi } from 'vitest'
import supertest from 'supertest'
import Fastify from 'fastify'
import fp from 'fastify-plugin'

const from = vi.fn()
vi.mock('../../services/supabase.js', () => ({
  supabaseAdmin: { from: (...args: unknown[]) => from(...args) },
}))

const service = {
  isStripeCryptoConfigured: vi.fn(() => true),
  createOrReuseLinkAuthIntent: vi.fn(),
  exchangeLinkAuthIntent: vi.fn(),
  mintAccessToken: vi.fn(),
  getCryptoCustomer: vi.fn(),
  cacheKycStatus: vi.fn(),
  getOnrampQuote: vi.fn(),
  getTransactionLimits: vi.fn(),
}

vi.mock('../../services/stripe-crypto.js', async () => {
  const actual = await vi.importActual<typeof import('../../services/stripe-crypto.js')>(
    '../../services/stripe-crypto.js',
  )
  return {
    NoStoredTokenError: actual.NoStoredTokenError,
    StripeCryptoApiError: actual.StripeCryptoApiError,
    isStripeCryptoConfigured: () => service.isStripeCryptoConfigured(),
    createOrReuseLinkAuthIntent: (...a: unknown[]) => service.createOrReuseLinkAuthIntent(...a),
    exchangeLinkAuthIntent: (...a: unknown[]) => service.exchangeLinkAuthIntent(...a),
    mintAccessToken: (...a: unknown[]) => service.mintAccessToken(...a),
    getCryptoCustomer: (...a: unknown[]) => service.getCryptoCustomer(...a),
    cacheKycStatus: (...a: unknown[]) => service.cacheKycStatus(...a),
    getOnrampQuote: (...a: unknown[]) => service.getOnrampQuote(...a),
    getTransactionLimits: (...a: unknown[]) => service.getTransactionLimits(...a),
  }
})

const { cryptoRoute } = await import('./crypto.js')
const { NoStoredTokenError, StripeCryptoApiError } = await import('../../services/stripe-crypto.js')

const mockAuth = fp(async (server) => {
  server.addHook('onRequest', async (request, reply) => {
    if (request.routeOptions?.config?.public) return
    if (!request.headers.authorization?.startsWith('Bearer ')) {
      return reply.code(401).send({ error: 'Unauthorized' })
    }
    request.user = { id: 'user-123' }
  })
})

function selectRow(row: unknown) {
  return {
    select: vi.fn(() => ({
      eq: vi.fn(() => ({
        maybeSingle: vi.fn(async () => ({ data: row, error: null })),
        single: vi.fn(async () => ({ data: row, error: null })),
      })),
    })),
  }
}

async function buildApp() {
  const app = Fastify({ logger: false })
  await app.register(mockAuth)
  await app.register(cryptoRoute, { prefix: '/v1' })
  await app.ready()
  return app
}

beforeEach(() => {
  from.mockReset()
  service.isStripeCryptoConfigured.mockReturnValue(true)
  service.createOrReuseLinkAuthIntent.mockReset()
  service.exchangeLinkAuthIntent.mockReset()
  service.mintAccessToken.mockReset()
  service.getCryptoCustomer.mockReset()
  service.cacheKycStatus.mockReset()
  service.getOnrampQuote.mockReset()
  service.getTransactionLimits.mockReset()
})

describe('crypto surface configuration gate', () => {
  it('answers 503 not_configured on every route when the OAuth pair is absent', async () => {
    service.isStripeCryptoConfigured.mockReturnValue(false)
    const app = await buildApp()

    for (const [method, path] of [
      ['post', '/v1/crypto/link-auth-intent'],
      ['post', '/v1/crypto/link-auth-intent/exchange'],
      ['get', '/v1/crypto/kyc-status'],
      ['get', '/v1/crypto/quote?amount=25.00'],
      ['get', '/v1/crypto/limits'],
    ] as const) {
      const res = await supertest(app.server)[method](path).set('Authorization', 'Bearer t')
      expect(res.status).toBe(503)
      expect(res.body.error.code).toBe('not_configured')
    }
    await app.close()
  })

  it('requires auth before anything else', async () => {
    const app = await buildApp()
    const res = await supertest(app.server).post('/v1/crypto/link-auth-intent')
    expect(res.status).toBe(401)
    await app.close()
  })
})

describe('POST /v1/crypto/link-auth-intent', () => {
  it('reads the email from the user row — never from the request', async () => {
    from.mockReturnValue(selectRow({ email: 'me@example.com' }))
    service.createOrReuseLinkAuthIntent.mockResolvedValue({
      id: 'lai_1',
      expiresAt: 1893456000,
      linkAccountExists: true,
    })
    const app = await buildApp()

    const res = await supertest(app.server)
      .post('/v1/crypto/link-auth-intent')
      .set('Authorization', 'Bearer t')
      .send({})

    expect(res.status).toBe(200)
    expect(res.body).toEqual({ authIntentId: 'lai_1', expiresAt: 1893456000, linkAccountExists: true })
    expect(service.createOrReuseLinkAuthIntent).toHaveBeenCalledWith('user-123', 'me@example.com')
    await app.close()
  })

  it('refuses when the profile has no email yet', async () => {
    from.mockReturnValue(selectRow({ email: null }))
    const app = await buildApp()

    const res = await supertest(app.server)
      .post('/v1/crypto/link-auth-intent')
      .set('Authorization', 'Bearer t')

    expect(res.status).toBe(400)
    expect(service.createOrReuseLinkAuthIntent).not.toHaveBeenCalled()
    await app.close()
  })
})

describe('POST /v1/crypto/link-auth-intent/exchange', () => {
  it('exchanges only the intent stored for this user', async () => {
    from.mockReturnValue(selectRow({ auth_intent_id: 'lai_mine' }))
    service.exchangeLinkAuthIntent.mockResolvedValue('liwltoken_x')
    const app = await buildApp()

    const res = await supertest(app.server)
      .post('/v1/crypto/link-auth-intent/exchange')
      .set('Authorization', 'Bearer t')
      .send({ authIntentId: 'lai_mine' })

    expect(res.status).toBe(200)
    expect(res.body).toEqual({ ok: true })
    // The access token must never surface in the response
    expect(JSON.stringify(res.body)).not.toContain('liwltoken')
    await app.close()
  })

  it("refuses someone else's intent id — identity grafting guard", async () => {
    from.mockReturnValue(selectRow({ auth_intent_id: 'lai_mine' }))
    const app = await buildApp()

    const res = await supertest(app.server)
      .post('/v1/crypto/link-auth-intent/exchange')
      .set('Authorization', 'Bearer t')
      .send({ authIntentId: 'lai_theirs' })

    expect(res.status).toBe(403)
    expect(service.exchangeLinkAuthIntent).not.toHaveBeenCalled()
    await app.close()
  })

  it('rejects malformed intent ids at the schema', async () => {
    const app = await buildApp()
    const res = await supertest(app.server)
      .post('/v1/crypto/link-auth-intent/exchange')
      .set('Authorization', 'Bearer t')
      .send({ authIntentId: 'not-a-lai; DROP TABLE users' })
    expect(res.status).toBe(400)
    await app.close()
  })
})

describe('POST /v1/crypto/customer', () => {
  it('verifies the id against Stripe under the user’s token before persisting', async () => {
    service.mintAccessToken.mockResolvedValue('liwltoken_x')
    service.getCryptoCustomer.mockResolvedValue({
      customerId: 'crc_1',
      verifications: [{ type: 'kyc_verified', status: 'verified' }],
    })
    const app = await buildApp()

    const res = await supertest(app.server)
      .post('/v1/crypto/customer')
      .set('Authorization', 'Bearer t')
      .send({ customerId: 'crc_1' })

    expect(res.status).toBe(200)
    expect(service.getCryptoCustomer).toHaveBeenCalledWith('crc_1', 'liwltoken_x')
    expect(service.cacheKycStatus).toHaveBeenCalledWith('user-123', {
      customerId: 'crc_1',
      verifications: [{ type: 'kyc_verified', status: 'verified' }],
    })
    await app.close()
  })

  it('rejects a malformed customer id at the schema', async () => {
    const app = await buildApp()
    const res = await supertest(app.server)
      .post('/v1/crypto/customer')
      .set('Authorization', 'Bearer t')
      .send({ customerId: 'cus_wrong_object' })
    expect(res.status).toBe(400)
    await app.close()
  })
})

describe('GET /v1/crypto/kyc-status', () => {
  it('404s before any provider call when no customer exists yet', async () => {
    from.mockReturnValue(selectRow({ stripe_crypto_customer_id: null }))
    const app = await buildApp()

    const res = await supertest(app.server)
      .get('/v1/crypto/kyc-status')
      .set('Authorization', 'Bearer t')

    expect(res.status).toBe(404)
    expect(service.mintAccessToken).not.toHaveBeenCalled()
    await app.close()
  })

  it('maps a missing/revoked token to 409 — the re-authenticate signal', async () => {
    from.mockReturnValue(selectRow({ stripe_crypto_customer_id: 'crc_1' }))
    service.mintAccessToken.mockRejectedValue(new NoStoredTokenError())
    const app = await buildApp()

    const res = await supertest(app.server)
      .get('/v1/crypto/kyc-status')
      .set('Authorization', 'Bearer t')

    expect(res.status).toBe(409)
    expect(res.body.error.code).toBe('conflict')
    await app.close()
  })

  it('polls, caches, and returns the normalized status', async () => {
    from.mockReturnValue(selectRow({ stripe_crypto_customer_id: 'crc_1' }))
    service.mintAccessToken.mockResolvedValue('liwltoken_x')
    service.getCryptoCustomer.mockResolvedValue({
      customerId: 'crc_1',
      verifications: [{ type: 'kyc_verified', status: 'pending' }],
    })
    const app = await buildApp()

    const res = await supertest(app.server)
      .get('/v1/crypto/kyc-status')
      .set('Authorization', 'Bearer t')

    expect(res.status).toBe(200)
    expect(res.body.verifications).toEqual([{ type: 'kyc_verified', status: 'pending' }])
    expect(service.cacheKycStatus).toHaveBeenCalled()
    await app.close()
  })

  it('maps provider failures to 502 without leaking the body', async () => {
    from.mockReturnValue(selectRow({ stripe_crypto_customer_id: 'crc_1' }))
    service.mintAccessToken.mockResolvedValue('liwltoken_x')
    service.getCryptoCustomer.mockRejectedValue(
      new StripeCryptoApiError(500, { error: { message: 'internal detail' } }),
    )
    const app = await buildApp()

    const res = await supertest(app.server)
      .get('/v1/crypto/kyc-status')
      .set('Authorization', 'Bearer t')

    expect(res.status).toBe(502)
    expect(JSON.stringify(res.body)).not.toContain('internal detail')
    await app.close()
  })
})

describe('GET /v1/crypto/quote', () => {
  it('quotes the fixed USDC-on-Base corridor for a valid amount', async () => {
    service.getOnrampQuote.mockResolvedValue({
      destinationCurrency: 'usdc',
      destinationAmount: '24.50',
      destinationNetwork: 'base',
      networkFee: '0.10',
      transactionFee: '0.40',
      sourceTotalAmount: '25.00',
    })
    const app = await buildApp()

    const res = await supertest(app.server)
      .get('/v1/crypto/quote?amount=25.00')
      .set('Authorization', 'Bearer t')

    expect(res.status).toBe(200)
    expect(res.body.sourceTotalAmount).toBe('25.00')
    expect(service.getOnrampQuote).toHaveBeenCalledWith({
      sourceAmount: '25.00',
      destinationCurrency: 'usdc',
      destinationNetwork: 'base',
    })
    await app.close()
  })

  it('rejects a malformed amount at the schema', async () => {
    const app = await buildApp()
    const res = await supertest(app.server)
      .get('/v1/crypto/quote?amount=25.001')
      .set('Authorization', 'Bearer t')
    expect(res.status).toBe(400)
    await app.close()
  })

  it('404s when Stripe returns no quote for the corridor', async () => {
    service.getOnrampQuote.mockResolvedValue(null)
    const app = await buildApp()
    const res = await supertest(app.server)
      .get('/v1/crypto/quote?amount=25.00')
      .set('Authorization', 'Bearer t')
    expect(res.status).toBe(404)
    await app.close()
  })
})

describe('GET /v1/crypto/limits', () => {
  it('passes the provider payload through under limits', async () => {
    service.mintAccessToken.mockResolvedValue('liwltoken_x')
    service.getTransactionLimits.mockResolvedValue({ weekly_remaining: '475.00' })
    const app = await buildApp()

    const res = await supertest(app.server).get('/v1/crypto/limits').set('Authorization', 'Bearer t')

    expect(res.status).toBe(200)
    expect(res.body).toEqual({ limits: { weekly_remaining: '475.00' } })
    await app.close()
  })
})
