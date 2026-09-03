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
  createOnrampSession: vi.fn(),
  checkoutOnrampSession: vi.fn(),
}

// The money routes are live only under a deferred-initiation processor (K4).
const deferredInitiation = vi.fn(() => true)
const getPaymentStatus = vi.fn()
vi.mock('../../services/funding/index.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../services/funding/index.js')>()
  return {
    ...actual,
    getFundingProcessor: () => ({
      provider: 'stripe_crypto',
      signatureHeader: 'stripe-signature',
      isConfigured: () => true,
      deferredInitiation: deferredInitiation(),
      getPaymentStatus,
    }),
  }
})

vi.mock('../../services/stripe-crypto.js', async () => {
  const actual = await vi.importActual<typeof import('../../services/stripe-crypto.js')>(
    '../../services/stripe-crypto.js',
  )
  return {
    NoStoredTokenError: actual.NoStoredTokenError,
    StripeCryptoApiError: actual.StripeCryptoApiError,
    KYC_STEP_UP_CODES: actual.KYC_STEP_UP_CODES,
    isStripeCryptoConfigured: () => service.isStripeCryptoConfigured(),
    createOrReuseLinkAuthIntent: (...a: unknown[]) => service.createOrReuseLinkAuthIntent(...a),
    exchangeLinkAuthIntent: (...a: unknown[]) => service.exchangeLinkAuthIntent(...a),
    mintAccessToken: (...a: unknown[]) => service.mintAccessToken(...a),
    getCryptoCustomer: (...a: unknown[]) => service.getCryptoCustomer(...a),
    cacheKycStatus: (...a: unknown[]) => service.cacheKycStatus(...a),
    getOnrampQuote: (...a: unknown[]) => service.getOnrampQuote(...a),
    getTransactionLimits: (...a: unknown[]) => service.getTransactionLimits(...a),
    createOnrampSession: (...a: unknown[]) => service.createOnrampSession(...a),
    checkoutOnrampSession: (...a: unknown[]) => service.checkoutOnrampSession(...a),
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
  service.createOnrampSession.mockReset()
  service.checkoutOnrampSession.mockReset()
  deferredInitiation.mockReset()
  deferredInitiation.mockReturnValue(true)
  getPaymentStatus.mockReset()
})

// ── K4 pay-step money routes ────────────────────────────────────────────────

const TRANSFER_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1'

const payableTransfer = {
  id: TRANSFER_ID,
  state: 'PENDING_PAYMENT',
  disclosure_accepted_at: '2026-08-28T12:00:00Z',
  send_amount_minor: 19801,
  fee_amount_minor: 199,
  funding_payment_ref: null,
}

// Two-table dispatch used by the money routes: transfers (guard) + users (crc_).
function moneyTables(overrides: { transfer?: unknown; user?: unknown } = {}) {
  const transfer = 'transfer' in overrides ? overrides.transfer : payableTransfer
  const user = 'user' in overrides ? overrides.user : { stripe_crypto_customer_id: 'crc_1' }
  const update = vi.fn(() => ({ eq: vi.fn(() => ({ eq: vi.fn(async () => ({ error: null })) })) }))
  from.mockImplementation((table: string) => {
    if (table === 'transfers') {
      return {
        select: vi.fn(() => ({
          eq: vi.fn(() => ({
            eq: vi.fn(() => ({ maybeSingle: vi.fn(async () => ({ data: transfer, error: null })) })),
          })),
        })),
        update,
      }
    }
    return {
      select: vi.fn(() => ({ eq: vi.fn(() => ({ single: vi.fn(async () => ({ data: user, error: null })) })) })),
    }
  })
  return { update }
}

describe('POST /v1/crypto/transfers/:id/onramp-session', () => {
  const post = (app: Awaited<ReturnType<typeof buildApp>>, body: Record<string, unknown> = { paymentTokenId: 'cpt_1' }) =>
    supertest(app.server)
      .post(`/v1/crypto/transfers/${TRANSFER_ID}/onramp-session`)
      .set('Authorization', 'Bearer t')
      .set('X-Client-Ip', '203.0.113.7')
      .send(body)

  it('refuses when the active rail does not defer initiation', async () => {
    deferredInitiation.mockReturnValue(false)
    const app = await buildApp()
    const res = await post(app)
    expect(res.status).toBe(409)
    expect(service.createOnrampSession).not.toHaveBeenCalled()
    await app.close()
  })

  it('creates the session with server-pinned amount and IP, then stamps the ref', async () => {
    const { update } = moneyTables()
    service.mintAccessToken.mockResolvedValue('liwltoken_x')
    service.createOnrampSession.mockResolvedValue({ id: 'cos_1', status: 'initialized' })
    const app = await buildApp()

    const res = await post(app)

    expect(res.status).toBe(200)
    expect(res.body).toEqual({ sessionId: 'cos_1', status: 'initialized' })
    expect(service.createOnrampSession).toHaveBeenCalledWith({
      transferId: TRANSFER_ID,
      cryptoCustomerId: 'crc_1',
      paymentTokenId: 'cpt_1',
      destinationAmountUsd: '200.00',
      clientIp: '203.0.113.7',
      accessToken: 'liwltoken_x',
    })
    expect(update).toHaveBeenCalledWith({ funding_payment_ref: 'cos_1', funding_processor: 'stripe_crypto' })
    await app.close()
  })

  it('refuses replacement while a prior session is moving money', async () => {
    moneyTables({ transfer: { ...payableTransfer, funding_payment_ref: 'cos_old' } })
    getPaymentStatus.mockResolvedValue({ paymentRef: 'cos_old', status: 'fulfillment_processing' })
    const app = await buildApp()

    const res = await post(app)

    expect(res.status).toBe(409)
    expect(service.createOnrampSession).not.toHaveBeenCalled()
    await app.close()
  })

  it('allows replacement of an abandoned pre-checkout session', async () => {
    moneyTables({ transfer: { ...payableTransfer, funding_payment_ref: 'cos_old' } })
    getPaymentStatus.mockResolvedValue({ paymentRef: 'cos_old', status: 'requires_payment' })
    service.mintAccessToken.mockResolvedValue('liwltoken_x')
    service.createOnrampSession.mockResolvedValue({ id: 'cos_new', status: 'initialized' })
    const app = await buildApp()

    const res = await post(app)

    expect(res.status).toBe(200)
    expect(res.body.sessionId).toBe('cos_new')
    await app.close()
  })

  it('409s before Stripe when the user has no crypto customer yet', async () => {
    moneyTables({ user: { stripe_crypto_customer_id: null } })
    const app = await buildApp()

    const res = await post(app)

    expect(res.status).toBe(409)
    // link_auth_required, not the generic conflict: the client restarts Link
    // auth on this code and recollects payment on 'conflict' (K5).
    expect(res.body.error.code).toBe('link_auth_required')
    expect(service.mintAccessToken).not.toHaveBeenCalled()
    await app.close()
  })

  it('maps KYC step-up refusals to 400 kyc_required with the exact Stripe code', async () => {
    moneyTables()
    service.mintAccessToken.mockResolvedValue('liwltoken_x')
    service.createOnrampSession.mockRejectedValue(
      new StripeCryptoApiError(400, {
        error: { code: 'crypto_onramp_missing_identity_verification' },
      }),
    )
    const app = await buildApp()

    const res = await post(app)

    expect(res.status).toBe(400)
    expect(res.body.error.code).toBe('kyc_required')
    expect(res.body.error.details).toEqual([
      { path: 'kyc', issue: 'crypto_onramp_missing_identity_verification' },
    ])
    await app.close()
  })

  it('maps geo/profile refusals to the stable 403 funding_unsupported', async () => {
    moneyTables()
    service.mintAccessToken.mockResolvedValue('liwltoken_x')
    service.createOnrampSession.mockRejectedValue(
      new StripeCryptoApiError(400, { error: { code: 'crypto_onramp_unsupportable_customer' } }),
    )
    const app = await buildApp()

    const res = await post(app)

    expect(res.status).toBe(403)
    expect(res.body.error.code).toBe('funding_unsupported')
    await app.close()
  })

  it('rejects a malformed payment token at the schema', async () => {
    const app = await buildApp()
    const res = await post(app, { paymentTokenId: 'tok_not_cpt' })
    expect(res.status).toBe(400)
    await app.close()
  })
})

describe('POST /v1/crypto/transfers/:id/onramp-checkout', () => {
  const post = (app: Awaited<ReturnType<typeof buildApp>>, body: Record<string, unknown>) =>
    supertest(app.server)
      .post(`/v1/crypto/transfers/${TRANSFER_ID}/onramp-checkout`)
      .set('Authorization', 'Bearer t')
      .set('X-Client-Ip', '203.0.113.7')
      .set('User-Agent', 'test-browser')
      .send(body)

  it('binds checkout to the CURRENT session — a replaced session id is refused', async () => {
    moneyTables({ transfer: { ...payableTransfer, funding_payment_ref: 'cos_current' } })
    const app = await buildApp()

    const res = await post(app, { sessionId: 'cos_stale', paymentMethodType: 'card' })

    expect(res.status).toBe(409)
    expect(service.checkoutOnrampSession).not.toHaveBeenCalled()
    await app.close()
  })

  it('card checkout returns the client_secret with no mandate', async () => {
    moneyTables({ transfer: { ...payableTransfer, funding_payment_ref: 'cos_1' } })
    service.mintAccessToken.mockResolvedValue('liwltoken_x')
    service.checkoutOnrampSession.mockResolvedValue({ clientSecret: 'secret_x' })
    const app = await buildApp()

    const res = await post(app, { sessionId: 'cos_1', paymentMethodType: 'card' })

    expect(res.status).toBe(200)
    expect(res.body).toEqual({ clientSecret: 'secret_x' })
    expect(service.checkoutOnrampSession).toHaveBeenCalledWith({
      sessionId: 'cos_1',
      accessToken: 'liwltoken_x',
    })
    await app.close()
  })

  it('ACH checkout carries the mandate evidence from the accepting browser', async () => {
    moneyTables({ transfer: { ...payableTransfer, funding_payment_ref: 'cos_1' } })
    service.mintAccessToken.mockResolvedValue('liwltoken_x')
    service.checkoutOnrampSession.mockResolvedValue({ clientSecret: 'secret_x' })
    const app = await buildApp()

    const res = await post(app, { sessionId: 'cos_1', paymentMethodType: 'us_bank_account' })

    expect(res.status).toBe(200)
    expect(service.checkoutOnrampSession).toHaveBeenCalledWith({
      sessionId: 'cos_1',
      accessToken: 'liwltoken_x',
      achMandate: { clientIp: '203.0.113.7', userAgent: 'test-browser' },
    })
    await app.close()
  })

  it('an unusable session (other 4xx) maps to 409 — start a fresh attempt', async () => {
    moneyTables({ transfer: { ...payableTransfer, funding_payment_ref: 'cos_1' } })
    service.mintAccessToken.mockResolvedValue('liwltoken_x')
    service.checkoutOnrampSession.mockRejectedValue(
      new StripeCryptoApiError(400, { error: { code: 'crypto_onramp_quote_expired' } }),
    )
    const app = await buildApp()

    const res = await post(app, { sessionId: 'cos_1', paymentMethodType: 'card' })

    expect(res.status).toBe(409)
    expect(res.body.error.code).toBe('conflict')
    await app.close()
  })
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
    expect(res.body.error.code).toBe('link_auth_required')
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
