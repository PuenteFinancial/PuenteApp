import { describe, it, expect, beforeEach, vi } from 'vitest'
import supertest from 'supertest'
import Fastify from 'fastify'
import fp from 'fastify-plugin'

const from = vi.fn()

vi.mock('../../services/supabase.js', () => ({
  supabaseAdmin: {
    from: (...args: unknown[]) => from(...args),
  },
}))

const getExchangeRate = vi.fn()

vi.mock('../../services/bridge.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../services/bridge.js')>()
  return {
    ...actual,
    getExchangeRate: (...args: unknown[]) => getExchangeRate(...args),
  }
})

const { quotesRoute } = await import('./quotes.js')
const { BridgeApiError } = await import('../../services/bridge.js')

// Token doubles as the user id (default user-123) so tests can exercise
// multi-user behavior — e.g. proving rate-limit buckets are per-user.
const mockAuth = fp(async (server) => {
  server.addHook('onRequest', async (request, reply) => {
    if (request.routeOptions?.config?.public) return
    if (!request.headers.authorization?.startsWith('Bearer ')) {
      return reply.code(401).send({ error: 'Unauthorized' })
    }
    const token = request.headers.authorization.slice('Bearer '.length)
    request.user = { id: token === 'test-token' ? 'user-123' : token }
  })
})

// Generic chainable PostgREST fake (same shape as recipients.test.ts).
function chain(result: { data?: unknown; error?: unknown }) {
  const resolved = { data: result.data ?? null, error: result.error ?? null }
  const b: Record<string, ReturnType<typeof vi.fn>> & {
    then?: (resolve: (v: unknown) => void) => void
  } = {} as never
  for (const m of ['select', 'insert', 'update', 'eq', 'or', 'order', 'limit'] as const) {
    b[m] = vi.fn(() => b)
  }
  b['single'] = vi.fn(async () => resolved)
  b.then = (resolve) => resolve(resolved)
  return b
}

const approvedUser = { kyc_status: 'approved', bridge_customer_id: 'cust_1' }

const destinationId = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd'
const quoteId = 'qqqqqqqq-1111-4111-8111-111111111111'.replace(/q/g, 'a')

const ownedDestination = {
  id: destinationId,
  currency: 'MXN',
  status: 'active',
  recipients: { user_id: 'user-123', status: 'active' },
}

const sandboxRate = {
  midmarketRate: '20.00025',
  buyRate: '20.10025100',
  sellRate: '19.900249',
  updatedAt: '2026-07-17T14:00:00.000Z',
}

// What priceQuote produces from buyRate 20.10025100 with default config
// (fee 100 bps, buffer 50 bps) on a $200.00 total.
const quoteRow = {
  id: quoteId,
  payout_destination_id: destinationId,
  send_amount_minor: 19801,
  send_currency: 'USD',
  receive_amount_minor: 396014,
  receive_currency: 'MXN',
  fee_amount_minor: 199,
  fee_currency: 'USD',
  fx_rate: 19.9997, // numeric arrives as a JSON number from PostgREST
  status: 'active',
  expires_at: '2036-01-01T00:00:00.000Z', // far future: derived-expiry must not trip
  created_at: '2026-07-17T14:00:00.000Z',
}

async function buildApp(options: { rateLimit?: boolean } = {}) {
  const app = Fastify({ logger: false })
  if (options.rateLimit) {
    const rateLimit = (await import('@fastify/rate-limit')).default
    await app.register(rateLimit, { max: 100, timeWindow: '1 minute' })
  }
  await app.register(mockAuth)
  await app.register(quotesRoute, { prefix: '/v1' })
  await app.ready()
  return app
}

beforeEach(() => {
  from.mockReset()
  getExchangeRate.mockReset()
})

const validBody = {
  payoutDestinationId: destinationId,
  totalAmount: { amountMinor: 20000, currency: 'USD' },
}

describe('POST /v1/quotes', () => {
  it('prices and persists a quote off the buffered buy_rate', async () => {
    const users = chain({ data: approvedUser })
    const dest = chain({ data: ownedDestination })
    const insert = chain({ data: quoteRow })
    from.mockReturnValueOnce(users).mockReturnValueOnce(dest).mockReturnValueOnce(insert)
    getExchangeRate.mockResolvedValue(sandboxRate)
    const app = await buildApp()

    const res = await supertest(app.server)
      .post('/v1/quotes')
      .set('Authorization', 'Bearer test-token')
      .send(validBody)

    expect(res.status).toBe(201)
    expect(res.body).toMatchObject({
      id: quoteId,
      payoutDestinationId: destinationId,
      totalAmount: { amountMinor: 20000, currency: 'USD' },
      sendAmount: { amountMinor: 19801, currency: 'USD' },
      feeAmount: { amountMinor: 199, currency: 'USD' },
      receiveAmount: { amountMinor: 396014, currency: 'MXN' },
      fxRate: '19.9997',
      status: 'active',
      expiresAt: quoteRow.expires_at,
    })

    expect(getExchangeRate).toHaveBeenCalledWith('usd', 'mxn')
    expect(from).toHaveBeenNthCalledWith(3, 'quotes')
    const inserted = insert['insert']!.mock.calls[0]![0] as Record<string, unknown>
    expect(inserted).toMatchObject({
      user_id: 'user-123',
      payout_destination_id: destinationId,
      send_amount_minor: 19801,
      send_currency: 'USD',
      receive_amount_minor: 396014,
      receive_currency: 'MXN',
      fee_amount_minor: 199,
      fee_currency: 'USD',
      fx_rate: '19.9997', // written as the fixed-scale string, never a float
      source_rate: '20.10025100', // Bridge string passthrough for reconciliation
    })
    const expiresAt = new Date(inserted['expires_at'] as string).getTime()
    expect(expiresAt).toBeGreaterThan(Date.now() + 890_000)
    expect(expiresAt).toBeLessThanOrEqual(Date.now() + 900_000)
    expect(typeof inserted['fx_rate_at']).toBe('string')
    await app.close()
  })

  it('rejects malformed bodies at the schema layer', async () => {
    const app = await buildApp()
    const cases = [
      {},
      { payoutDestinationId: destinationId },
      { ...validBody, totalAmount: { amountMinor: 20000, currency: 'EUR' } },
      { ...validBody, totalAmount: { amountMinor: 1.5, currency: 'USD' } },
      { ...validBody, totalAmount: { amountMinor: 0, currency: 'USD' } },
      { ...validBody, totalAmount: { amountMinor: 2_000_000_000_000, currency: 'USD' } },
      { ...validBody, payoutDestinationId: 'not-a-uuid' },
      // note: unknown top-level fields are STRIPPED (AJV removeAdditional),
      // not rejected — same contract as recipients/destinations
    ]
    for (const body of cases) {
      const res = await supertest(app.server)
        .post('/v1/quotes')
        .set('Authorization', 'Bearer test-token')
        .send(body)
      expect(res.status, JSON.stringify(body)).toBe(400)
    }
    expect(from).not.toHaveBeenCalled()
    await app.close()
  })

  it('403s when the user is not KYC-approved and never fetches a rate', async () => {
    from.mockReturnValueOnce(chain({ data: { kyc_status: 'pending', bridge_customer_id: null } }))
    const app = await buildApp()

    const res = await supertest(app.server)
      .post('/v1/quotes')
      .set('Authorization', 'Bearer test-token')
      .send(validBody)

    expect(res.status).toBe(403)
    expect(getExchangeRate).not.toHaveBeenCalled()
    await app.close()
  })

  it('404s when the destination is missing or not owned', async () => {
    from.mockReturnValueOnce(chain({ data: approvedUser })).mockReturnValueOnce(chain({ data: null }))
    const app = await buildApp()

    const res = await supertest(app.server)
      .post('/v1/quotes')
      .set('Authorization', 'Bearer test-token')
      .send(validBody)

    expect(res.status).toBe(404)
    expect(getExchangeRate).not.toHaveBeenCalled()
    await app.close()
  })

  it('400s on archived destinations, archived recipients, and non-MXN corridors', async () => {
    const variants = [
      { ...ownedDestination, status: 'archived' },
      { ...ownedDestination, recipients: { user_id: 'user-123', status: 'archived' } },
      { ...ownedDestination, currency: 'USD' },
    ]
    const app = await buildApp()
    for (const destination of variants) {
      from.mockReset()
      getExchangeRate.mockReset()
      from
        .mockReturnValueOnce(chain({ data: approvedUser }))
        .mockReturnValueOnce(chain({ data: destination }))

      const res = await supertest(app.server)
        .post('/v1/quotes')
        .set('Authorization', 'Bearer test-token')
        .send(validBody)

      expect(res.status, JSON.stringify(destination)).toBe(400)
      expect(getExchangeRate).not.toHaveBeenCalled()
    }
    await app.close()
  })

  it('503s when the rate fetch fails, on network errors, and on malformed rates', async () => {
    const failures = [
      () => getExchangeRate.mockRejectedValue(new BridgeApiError(503, null)),
      () => getExchangeRate.mockRejectedValue(new TypeError('fetch failed')),
      () => getExchangeRate.mockResolvedValue({ ...sandboxRate, buyRate: 'not-a-rate' }),
    ]
    const app = await buildApp()
    for (const arm of failures) {
      from.mockReset()
      getExchangeRate.mockReset()
      from
        .mockReturnValueOnce(chain({ data: approvedUser }))
        .mockReturnValueOnce(chain({ data: ownedDestination }))
      arm()

      const res = await supertest(app.server)
        .post('/v1/quotes')
        .set('Authorization', 'Bearer test-token')
        .send(validBody)

      expect(res.status).toBe(503)
      // no insert may happen after a failed rate fetch
      expect(from).toHaveBeenCalledTimes(2)
    }
    await app.close()
  })

  it('400s amounts too small to price without touching the database again', async () => {
    from
      .mockReturnValueOnce(chain({ data: approvedUser }))
      .mockReturnValueOnce(chain({ data: ownedDestination }))
    getExchangeRate.mockResolvedValue(sandboxRate)
    const app = await buildApp()

    const res = await supertest(app.server)
      .post('/v1/quotes')
      .set('Authorization', 'Bearer test-token')
      .send({ ...validBody, totalAmount: { amountMinor: 1, currency: 'USD' } })

    expect(res.status).toBe(400)
    expect(from).toHaveBeenCalledTimes(2)
    await app.close()
  })

  it('401s without a token', async () => {
    const app = await buildApp()
    const res = await supertest(app.server).post('/v1/quotes').send(validBody)
    expect(res.status).toBe(401)
    await app.close()
  })

  it('429s past the per-route rate limit', async () => {
    from.mockImplementation((table: unknown) => {
      if (table === 'users') return chain({ data: approvedUser })
      if (table === 'payout_destinations') return chain({ data: ownedDestination })
      return chain({ data: quoteRow })
    })
    getExchangeRate.mockResolvedValue(sandboxRate)
    const app = await buildApp({ rateLimit: true })

    let last = 0
    for (let i = 0; i < 11; i++) {
      const res = await supertest(app.server)
        .post('/v1/quotes')
        .set('Authorization', 'Bearer test-token')
        .send(validBody)
      last = res.status
    }
    expect(last).toBe(429)
    await app.close()
  })

  it('rate-limit buckets are per-user, not per-IP', async () => {
    from.mockImplementation((table: unknown) => {
      if (table === 'users') return chain({ data: approvedUser })
      if (table === 'payout_destinations') return chain({ data: ownedDestination })
      return chain({ data: quoteRow })
    })
    getExchangeRate.mockResolvedValue(sandboxRate)
    const app = await buildApp({ rateLimit: true })

    // Exhaust user A's bucket from one IP…
    for (let i = 0; i < 10; i++) {
      await supertest(app.server)
        .post('/v1/quotes')
        .set('Authorization', 'Bearer user-aaa')
        .send(validBody)
    }
    const exhausted = await supertest(app.server)
      .post('/v1/quotes')
      .set('Authorization', 'Bearer user-aaa')
      .send(validBody)
    expect(exhausted.status).toBe(429)

    // …user B from the SAME IP must still be admitted. If the keyGenerator
    // fell back to IP (request.user unset when the limiter runs), this would
    // 429 — so this test pins the auth-before-limiter hook ordering.
    const otherUser = await supertest(app.server)
      .post('/v1/quotes')
      .set('Authorization', 'Bearer user-bbb')
      .send(validBody)
    expect(otherUser.status).toBe(201)
    await app.close()
  })
})

describe('GET /v1/quotes/:id', () => {
  it('returns an owned quote', async () => {
    const lookup = chain({ data: quoteRow })
    from.mockReturnValueOnce(lookup)
    const app = await buildApp()

    const res = await supertest(app.server)
      .get(`/v1/quotes/${quoteId}`)
      .set('Authorization', 'Bearer test-token')

    expect(res.status).toBe(200)
    expect(res.body).toMatchObject({
      id: quoteId,
      totalAmount: { amountMinor: 20000, currency: 'USD' },
      fxRate: '19.9997',
      status: 'active',
    })
    expect(lookup['eq']).toHaveBeenCalledWith('user_id', 'user-123')
    await app.close()
  })

  it("404s another user's quote", async () => {
    from.mockReturnValueOnce(chain({ data: null }))
    const app = await buildApp()

    const res = await supertest(app.server)
      .get(`/v1/quotes/${quoteId}`)
      .set('Authorization', 'Bearer test-token')

    expect(res.status).toBe(404)
    await app.close()
  })

  it('reports a past-expiry active quote as expired without writing', async () => {
    const stale = { ...quoteRow, expires_at: '2026-01-01T00:00:00.000Z' }
    const lookup = chain({ data: stale })
    from.mockReturnValueOnce(lookup)
    const app = await buildApp()

    const res = await supertest(app.server)
      .get(`/v1/quotes/${quoteId}`)
      .set('Authorization', 'Bearer test-token')

    expect(res.status).toBe(200)
    expect(res.body.status).toBe('expired')
    expect(lookup['update']).not.toHaveBeenCalled()
    expect(from).toHaveBeenCalledTimes(1)
    await app.close()
  })
})
