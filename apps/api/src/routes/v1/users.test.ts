import { describe, it, expect, beforeEach, vi } from 'vitest'
import supertest from 'supertest'
import Fastify from 'fastify'
import fp from 'fastify-plugin'

const from = vi.fn()
const updateUserById = vi.fn(async (..._args: unknown[]) => ({ data: {}, error: null }))

vi.mock('../../services/supabase.js', () => ({
  supabaseAdmin: {
    from: (...args: unknown[]) => from(...args),
    auth: { admin: { updateUserById: (...args: unknown[]) => updateUserById(...args) } },
  },
}))

const createBridgeCustomer = vi.fn()
const createTosLink = vi.fn()
const getKycLink = vi.fn()

vi.mock('../../services/bridge.js', async () => {
  const actual = await vi.importActual<typeof import('../../services/bridge.js')>(
    '../../services/bridge.js',
  )
  return {
    BridgeApiError: actual.BridgeApiError,
    createBridgeCustomer: (...args: unknown[]) => createBridgeCustomer(...args),
    createTosLink: (...args: unknown[]) => createTosLink(...args),
    getKycLink: (...args: unknown[]) => getKycLink(...args),
  }
})

const { usersRoute } = await import('./users.js')
const { BridgeApiError } = await import('../../services/bridge.js')

// Stand-in for the real JWT plugin: any non-empty bearer token authenticates
// as a fixed test user; requests without one get 401.
const mockAuth = fp(async (server) => {
  server.addHook('onRequest', async (request, reply) => {
    if (request.routeOptions?.config?.public) return
    if (!request.headers.authorization?.startsWith('Bearer ')) {
      return reply.code(401).send({ error: 'Unauthorized' })
    }
    request.user = { id: 'user-123' }
  })
})

const userRow = {
  id: 'user-123',
  first_name: 'Test',
  last_name: 'User',
  email: 'test@example.com',
  kyc_status: 'not_started',
  bridge_customer_id: null,
}

function selectResult(result: { data: unknown; error: unknown }) {
  return {
    select: vi.fn(() => ({ eq: vi.fn(() => ({ single: vi.fn(async () => result) })) })),
  }
}

function updateReturningResult(result: { data: unknown; error: unknown }) {
  return {
    update: vi.fn(() => ({
      eq: vi.fn(() => ({ select: vi.fn(() => ({ single: vi.fn(async () => result) })) })),
    })),
  }
}

function updateResult(result: { error: unknown }) {
  return { update: vi.fn(() => ({ eq: vi.fn(async () => result) })) }
}

async function buildApp() {
  const app = Fastify({ logger: false })
  await app.register(mockAuth)
  await app.register(usersRoute, { prefix: '/v1' })
  await app.ready()
  return app
}

beforeEach(() => {
  from.mockReset()
  updateUserById.mockClear()
  createBridgeCustomer.mockReset()
  createTosLink.mockReset()
  getKycLink.mockReset()
})

describe('POST /v1/users/me/tos-link', () => {
  it('returns a session-scoped Bridge ToS url', async () => {
    createTosLink.mockResolvedValue({ url: 'https://dashboard.bridge.xyz/accept-terms-of-service?session_token=tok' })
    const app = await buildApp()

    const res = await supertest(app.server)
      .post('/v1/users/me/tos-link')
      .set('Authorization', 'Bearer test-token')

    expect(res.status).toBe(200)
    expect(res.body.url).toContain('session_token=tok')
    expect(createTosLink).toHaveBeenCalledWith(expect.stringContaining('/onboarding/kyc/tos-return'))
    await app.close()
  })

  it('returns 401 without a token', async () => {
    const app = await buildApp()
    const res = await supertest(app.server).post('/v1/users/me/tos-link')
    expect(res.status).toBe(401)
    await app.close()
  })

  it('returns 502 when Bridge errors', async () => {
    createTosLink.mockRejectedValue(new BridgeApiError(500, { code: 'server_error' }))
    const app = await buildApp()

    const res = await supertest(app.server)
      .post('/v1/users/me/tos-link')
      .set('Authorization', 'Bearer test-token')

    expect(res.status).toBe(502)
    await app.close()
  })
})

describe('GET /v1/users/me', () => {
  it('returns the current user in camelCase', async () => {
    from.mockReturnValue(selectResult({ data: userRow, error: null }))
    const app = await buildApp()

    const res = await supertest(app.server)
      .get('/v1/users/me')
      .set('Authorization', 'Bearer test-token')

    expect(res.status).toBe(200)
    expect(res.body).toEqual({
      id: 'user-123',
      firstName: 'Test',
      lastName: 'User',
      email: 'test@example.com',
      kycStatus: 'not_started',
      bridgeCustomerId: null,
    })
    await app.close()
  })

  it('returns 401 without a token', async () => {
    const app = await buildApp()
    const res = await supertest(app.server).get('/v1/users/me')
    expect(res.status).toBe(401)
    await app.close()
  })

  it('returns 404 when the user row is missing', async () => {
    from.mockReturnValue(selectResult({ data: null, error: { code: 'PGRST116' } }))
    const app = await buildApp()

    const res = await supertest(app.server)
      .get('/v1/users/me')
      .set('Authorization', 'Bearer test-token')

    expect(res.status).toBe(404)
    await app.close()
  })
})

describe('PATCH /v1/users/me', () => {
  it('updates the profile and triggers email verification', async () => {
    from.mockReturnValue(
      updateReturningResult({ data: { ...userRow, first_name: 'Ana' }, error: null }),
    )
    const app = await buildApp()

    const res = await supertest(app.server)
      .patch('/v1/users/me')
      .set('Authorization', 'Bearer test-token')
      .send({ firstName: 'Ana', lastName: 'User', email: 'test@example.com' })

    expect(res.status).toBe(200)
    expect(res.body.firstName).toBe('Ana')
    expect(updateUserById).toHaveBeenCalledWith('user-123', { email: 'test@example.com' })
    await app.close()
  })

  it('returns 400 when a required field is missing', async () => {
    const app = await buildApp()
    const res = await supertest(app.server)
      .patch('/v1/users/me')
      .set('Authorization', 'Bearer test-token')
      .send({ firstName: 'Ana' })
    expect(res.status).toBe(400)
    expect(from).not.toHaveBeenCalled()
    await app.close()
  })

  it('returns 400 for an invalid email', async () => {
    const app = await buildApp()
    const res = await supertest(app.server)
      .patch('/v1/users/me')
      .set('Authorization', 'Bearer test-token')
      .send({ firstName: 'Ana', lastName: 'User', email: 'not-an-email' })
    expect(res.status).toBe(400)
    await app.close()
  })

  it('returns 401 without a token', async () => {
    const app = await buildApp()
    const res = await supertest(app.server)
      .patch('/v1/users/me')
      .send({ firstName: 'Ana', lastName: 'User', email: 'test@example.com' })
    expect(res.status).toBe(401)
    await app.close()
  })
})

describe('POST /v1/users/me/kyc-link', () => {
  it('creates a Bridge customer on first call and returns the KYC url', async () => {
    from
      .mockReturnValueOnce(selectResult({ data: userRow, error: null }))
      .mockReturnValueOnce(updateResult({ error: null }))
    createBridgeCustomer.mockResolvedValue({ id: 'cust_new' })
    getKycLink.mockResolvedValue({ url: 'https://bridge.example/kyc/xyz' })
    const app = await buildApp()

    const res = await supertest(app.server)
      .post('/v1/users/me/kyc-link')
      .set('Authorization', 'Bearer test-token')
      .send({ signed_agreement_id: 'agr_123' })

    expect(res.status).toBe(200)
    expect(res.body).toEqual({ url: 'https://bridge.example/kyc/xyz' })
    expect(createBridgeCustomer).toHaveBeenCalledWith({
      firstName: 'Test',
      lastName: 'User',
      email: 'test@example.com',
      signedAgreementId: 'agr_123',
    })
    expect(getKycLink).toHaveBeenCalledWith(
      'cust_new',
      expect.stringContaining('/onboarding/kyc/return'),
    )
    await app.close()
  })

  it('reuses an existing Bridge customer', async () => {
    from.mockReturnValueOnce(
      selectResult({ data: { ...userRow, bridge_customer_id: 'cust_existing' }, error: null }),
    )
    getKycLink.mockResolvedValue({ url: 'https://bridge.example/kyc/xyz' })
    const app = await buildApp()

    const res = await supertest(app.server)
      .post('/v1/users/me/kyc-link')
      .set('Authorization', 'Bearer test-token')
      .send({ signed_agreement_id: 'agr_123' })

    expect(res.status).toBe(200)
    expect(createBridgeCustomer).not.toHaveBeenCalled()
    expect(getKycLink).toHaveBeenCalledWith('cust_existing', expect.any(String))
    await app.close()
  })

  it('returns 400 when the profile is incomplete', async () => {
    from.mockReturnValueOnce(
      selectResult({ data: { ...userRow, first_name: null }, error: null }),
    )
    const app = await buildApp()

    const res = await supertest(app.server)
      .post('/v1/users/me/kyc-link')
      .set('Authorization', 'Bearer test-token')
      .send({ signed_agreement_id: 'agr_123' })

    expect(res.status).toBe(400)
    expect(createBridgeCustomer).not.toHaveBeenCalled()
    await app.close()
  })

  it('returns 400 when signed_agreement_id is missing', async () => {
    const app = await buildApp()
    const res = await supertest(app.server)
      .post('/v1/users/me/kyc-link')
      .set('Authorization', 'Bearer test-token')
      .send({})
    expect(res.status).toBe(400)
    await app.close()
  })

  it('returns 502 when Bridge errors', async () => {
    from.mockReturnValueOnce(selectResult({ data: userRow, error: null }))
    createBridgeCustomer.mockRejectedValue(new BridgeApiError(500, { code: 'server_error' }))
    const app = await buildApp()

    const res = await supertest(app.server)
      .post('/v1/users/me/kyc-link')
      .set('Authorization', 'Bearer test-token')
      .send({ signed_agreement_id: 'agr_123' })

    expect(res.status).toBe(502)
    await app.close()
  })
})
