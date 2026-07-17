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

const { recipientsRoute } = await import('./recipients.js')

const mockAuth = fp(async (server) => {
  server.addHook('onRequest', async (request, reply) => {
    if (request.routeOptions?.config?.public) return
    if (!request.headers.authorization?.startsWith('Bearer ')) {
      return reply.code(401).send({ error: 'Unauthorized' })
    }
    request.user = { id: 'user-123' }
  })
})

// Generic chainable PostgREST fake: every builder method returns the chain,
// `single()` and `await` both resolve to the supplied result. Call args are
// inspectable via chain.calls.<method>.
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

const recipientRow = {
  id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  first_name: 'María del Carmen',
  last_name: 'García López',
  relationship: 'mother',
  country: 'MX',
  status: 'active',
  created_at: '2026-07-16T12:00:00.000Z',
  updated_at: '2026-07-16T12:00:00.000Z',
}

async function buildApp() {
  const app = Fastify({ logger: false })
  await app.register(mockAuth)
  await app.register(recipientsRoute, { prefix: '/v1' })
  await app.ready()
  return app
}

beforeEach(() => {
  from.mockReset()
})

describe('POST /v1/recipients', () => {
  const validBody = {
    firstName: 'María del Carmen',
    lastName: 'García López',
    relationship: 'mother',
    country: 'MX',
  }

  it('creates a recipient with snake_case columns and trimmed values', async () => {
    const users = chain({ data: approvedUser })
    const insert = chain({ data: recipientRow })
    from.mockReturnValueOnce(users).mockReturnValueOnce(insert)
    const app = await buildApp()

    const res = await supertest(app.server)
      .post('/v1/recipients')
      .set('Authorization', 'Bearer test-token')
      .send({ ...validBody, firstName: '  María del Carmen  ' })

    expect(res.status).toBe(201)
    expect(res.body).toMatchObject({
      id: recipientRow.id,
      firstName: 'María del Carmen',
      lastName: 'García López',
      relationship: 'mother',
      country: 'MX',
      status: 'active',
    })
    expect(from).toHaveBeenNthCalledWith(2, 'recipients')
    expect(insert['insert']).toHaveBeenCalledWith({
      user_id: 'user-123',
      first_name: 'María del Carmen',
      last_name: 'García López',
      relationship: 'mother',
      country: 'MX',
    })
    await app.close()
  })

  it('403s when the user is not KYC-approved and never touches recipients', async () => {
    from.mockReturnValueOnce(chain({ data: { kyc_status: 'pending', bridge_customer_id: null } }))
    const app = await buildApp()

    const res = await supertest(app.server)
      .post('/v1/recipients')
      .set('Authorization', 'Bearer test-token')
      .send(validBody)

    expect(res.status).toBe(403)
    expect(from).toHaveBeenCalledTimes(1)
    expect(from).toHaveBeenCalledWith('users')
    await app.close()
  })

  it('strips unknown properties (Fastify removeAdditional) instead of rejecting', async () => {
    const users = chain({ data: approvedUser })
    const insert = chain({ data: recipientRow })
    from.mockReturnValueOnce(users).mockReturnValueOnce(insert)
    const app = await buildApp()

    const res = await supertest(app.server)
      .post('/v1/recipients')
      .set('Authorization', 'Bearer test-token')
      .send({ ...validBody, fullName: 'stripped' })

    expect(res.status).toBe(201)
    // the handler builds the insert from destructured fields — nothing
    // unknown can pass through even before the schema strip
    expect(insert['insert']).toHaveBeenCalledWith(
      expect.not.objectContaining({ fullName: expect.anything() }),
    )
    await app.close()
  })

  it.each([
    ['lowercase country', { ...validBody, country: 'mx' }],
    ['3-letter country', { ...validBody, country: 'MEX' }],
    ['missing lastName', { firstName: 'A', relationship: 'mother', country: 'MX' }],
    ['empty firstName', { ...validBody, firstName: '' }],
    // whitespace-only passes minLength:1 but trims to '' at insert — the
    // schema pattern turns what was a DB-constraint 500 into a clean 400
    ['whitespace-only firstName', { ...validBody, firstName: '   ' }],
    ['whitespace-only lastName', { ...validBody, lastName: '\t ' }],
    ['whitespace-only relationship', { ...validBody, relationship: '  ' }],
  ])('400s on %s without touching the DB', async (_name, body) => {
    const app = await buildApp()
    const res = await supertest(app.server)
      .post('/v1/recipients')
      .set('Authorization', 'Bearer test-token')
      .send(body)
    expect(res.status).toBe(400)
    expect(from).not.toHaveBeenCalled()
    await app.close()
  })

  it('401s without a bearer token', async () => {
    const app = await buildApp()
    const res = await supertest(app.server).post('/v1/recipients').send(validBody)
    expect(res.status).toBe(401)
    await app.close()
  })
})

describe('GET /v1/recipients', () => {
  it('lists active recipients with nextCursor null when the page is not full', async () => {
    const list = chain({ data: [recipientRow] })
    from.mockReturnValueOnce(list)
    const app = await buildApp()

    const res = await supertest(app.server)
      .get('/v1/recipients')
      .set('Authorization', 'Bearer test-token')

    expect(res.status).toBe(200)
    expect(res.body.data).toHaveLength(1)
    expect(res.body.data[0].firstName).toBe('María del Carmen')
    expect(res.body.nextCursor).toBeNull()
    expect(list['eq']).toHaveBeenCalledWith('user_id', 'user-123')
    expect(list['eq']).toHaveBeenCalledWith('status', 'active')
    await app.close()
  })

  it('emits nextCursor when limit+1 rows come back and honors an incoming cursor', async () => {
    const second = { ...recipientRow, id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb' }
    const third = { ...recipientRow, id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc' }
    const list = chain({ data: [recipientRow, second, third] })
    from.mockReturnValueOnce(list)
    const app = await buildApp()

    const res = await supertest(app.server)
      .get('/v1/recipients?limit=2')
      .set('Authorization', 'Bearer test-token')

    expect(res.status).toBe(200)
    expect(res.body.data).toHaveLength(2)
    expect(res.body.nextCursor).toEqual(expect.any(String))

    // feed the cursor back — the keyset .or() filter must be applied
    const page2 = chain({ data: [third] })
    from.mockReturnValueOnce(page2)
    const res2 = await supertest(app.server)
      .get(`/v1/recipients?limit=2&cursor=${encodeURIComponent(res.body.nextCursor)}`)
      .set('Authorization', 'Bearer test-token')

    expect(res2.status).toBe(200)
    expect(page2['or']).toHaveBeenCalledWith(
      `created_at.lt.${second.created_at},and(created_at.eq.${second.created_at},id.lt.${second.id})`,
    )
    await app.close()
  })

  it('400s on a malformed cursor', async () => {
    const app = await buildApp()
    const res = await supertest(app.server)
      .get('/v1/recipients?cursor=%2Enot-valid%2E')
      .set('Authorization', 'Bearer test-token')
    expect(res.status).toBe(400)
    await app.close()
  })
})

describe('GET /v1/recipients/:id', () => {
  it('returns the mapped recipient', async () => {
    from.mockReturnValueOnce(chain({ data: recipientRow }))
    const app = await buildApp()

    const res = await supertest(app.server)
      .get(`/v1/recipients/${recipientRow.id}`)
      .set('Authorization', 'Bearer test-token')

    expect(res.status).toBe(200)
    expect(res.body.lastName).toBe('García López')
    await app.close()
  })

  it("404s on another user's recipient (query scoped by user_id misses)", async () => {
    from.mockReturnValueOnce(chain({ data: null, error: { code: 'PGRST116' } }))
    const app = await buildApp()

    const res = await supertest(app.server)
      .get(`/v1/recipients/${recipientRow.id}`)
      .set('Authorization', 'Bearer test-token')

    expect(res.status).toBe(404)
    await app.close()
  })
})

describe('PATCH /v1/recipients/:id', () => {
  it('updates fields', async () => {
    const users = chain({ data: approvedUser })
    const update = chain({ data: { ...recipientRow, relationship: 'aunt' } })
    from.mockReturnValueOnce(users).mockReturnValueOnce(update)
    const app = await buildApp()

    const res = await supertest(app.server)
      .patch(`/v1/recipients/${recipientRow.id}`)
      .set('Authorization', 'Bearer test-token')
      .send({ relationship: 'aunt' })

    expect(res.status).toBe(200)
    expect(res.body.relationship).toBe('aunt')
    expect(update['update']).toHaveBeenCalledWith({ relationship: 'aunt' })
    await app.close()
  })

  it('archive cascades: destinations archived before the recipient', async () => {
    const users = chain({ data: approvedUser })
    const owned = chain({ data: { id: recipientRow.id } })
    const cascade = chain({ data: null })
    const update = chain({ data: { ...recipientRow, status: 'archived' } })
    from
      .mockReturnValueOnce(users)
      .mockReturnValueOnce(owned)
      .mockReturnValueOnce(cascade)
      .mockReturnValueOnce(update)
    const app = await buildApp()

    const res = await supertest(app.server)
      .patch(`/v1/recipients/${recipientRow.id}`)
      .set('Authorization', 'Bearer test-token')
      .send({ status: 'archived' })

    expect(res.status).toBe(200)
    expect(res.body.status).toBe('archived')
    // call order: users, recipients (ownership), payout_destinations
    // (cascade), recipients (archive)
    expect(from.mock.calls.map((c) => c[0])).toEqual([
      'users',
      'recipients',
      'payout_destinations',
      'recipients',
    ])
    expect(cascade['update']).toHaveBeenCalledWith({ status: 'archived' })
    expect(cascade['eq']).toHaveBeenCalledWith('recipient_id', recipientRow.id)
    expect(cascade['eq']).toHaveBeenCalledWith('status', 'active')
    await app.close()
  })

  it("archive 404s on another user's recipient before touching destinations", async () => {
    const users = chain({ data: approvedUser })
    const owned = chain({ data: null, error: { code: 'PGRST116' } })
    from.mockReturnValueOnce(users).mockReturnValueOnce(owned)
    const app = await buildApp()

    const res = await supertest(app.server)
      .patch(`/v1/recipients/${recipientRow.id}`)
      .set('Authorization', 'Bearer test-token')
      .send({ status: 'archived' })

    expect(res.status).toBe(404)
    expect(from).toHaveBeenCalledTimes(2)
    await app.close()
  })

  it.each([
    ['empty body', {}],
    ['country change', { country: 'US' }],
    ['unknown status', { status: 'deleted' }],
    ['whitespace-only firstName', { firstName: '   ' }],
  ])('400s on %s', async (_name, body) => {
    const app = await buildApp()
    const res = await supertest(app.server)
      .patch(`/v1/recipients/${recipientRow.id}`)
      .set('Authorization', 'Bearer test-token')
      .send(body)
    expect(res.status).toBe(400)
    expect(from).not.toHaveBeenCalled()
    await app.close()
  })

  it('403s when the user is not KYC-approved', async () => {
    from.mockReturnValueOnce(chain({ data: { kyc_status: 'rejected', bridge_customer_id: null } }))
    const app = await buildApp()

    const res = await supertest(app.server)
      .patch(`/v1/recipients/${recipientRow.id}`)
      .set('Authorization', 'Bearer test-token')
      .send({ relationship: 'aunt' })

    expect(res.status).toBe(403)
    await app.close()
  })
})
