import { describe, it, expect, beforeEach, vi } from 'vitest'
import supertest from 'supertest'
import Fastify from 'fastify'
import fp from 'fastify-plugin'
import { REQUIRED_CONSENTS } from '@puente/shared'

const from = vi.fn()

vi.mock('../../services/supabase.js', () => ({
  supabaseAdmin: {
    from: (...args: unknown[]) => from(...args),
  },
}))

const { consentsRoute } = await import('./consents.js')

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

// select('type, version, …').eq('user_id', …) — awaited directly (no .single)
function grantedSelect(rows: unknown[], error: unknown = null) {
  return { select: vi.fn(() => ({ eq: vi.fn(async () => ({ data: rows, error })) })) }
}

// Rows matching every currently required pair — the "fully consented" state.
const allGrantedRows = REQUIRED_CONSENTS.map((req) => ({
  type: req.type,
  version: req.version,
  locale: 'en',
  consented_at: '2026-08-27T12:00:00Z',
}))

async function buildApp() {
  const app = Fastify({ logger: false })
  await app.register(mockAuth)
  await app.register(consentsRoute, { prefix: '/v1' })
  await app.ready()
  return app
}

beforeEach(() => {
  from.mockReset()
})

describe('GET /v1/users/me/consents', () => {
  it('reports every required consent as missing for a fresh user', async () => {
    from.mockReturnValue(grantedSelect([]))
    const app = await buildApp()

    const res = await supertest(app.server)
      .get('/v1/users/me/consents')
      .set('Authorization', 'Bearer test-token')

    expect(res.status).toBe(200)
    expect(res.body.required).toEqual(REQUIRED_CONSENTS)
    expect(res.body.granted).toEqual([])
    expect(res.body.missing).toEqual(REQUIRED_CONSENTS)
    await app.close()
  })

  it('reports nothing missing once every required pair is granted', async () => {
    from.mockReturnValue(grantedSelect(allGrantedRows))
    const app = await buildApp()

    const res = await supertest(app.server)
      .get('/v1/users/me/consents')
      .set('Authorization', 'Bearer test-token')

    expect(res.status).toBe(200)
    expect(res.body.missing).toEqual([])
    expect(res.body.granted).toHaveLength(REQUIRED_CONSENTS.length)
    expect(res.body.granted[0]).toEqual({
      type: REQUIRED_CONSENTS[0]!.type,
      version: REQUIRED_CONSENTS[0]!.version,
      locale: 'en',
      consentedAt: '2026-08-27T12:00:00Z',
    })
    await app.close()
  })

  it('still requires a consent whose VERSION is stale, even if the type matches', async () => {
    const staleRows = [{ ...allGrantedRows[0]!, version: '2020-01-01' }]
    from.mockReturnValue(grantedSelect(staleRows))
    const app = await buildApp()

    const res = await supertest(app.server)
      .get('/v1/users/me/consents')
      .set('Authorization', 'Bearer test-token')

    expect(res.status).toBe(200)
    expect(res.body.missing).toContainEqual(REQUIRED_CONSENTS[0])
    await app.close()
  })

  it('returns 500 when the consents query fails', async () => {
    from.mockReturnValue(grantedSelect([], { code: 'XX000' }))
    const app = await buildApp()

    const res = await supertest(app.server)
      .get('/v1/users/me/consents')
      .set('Authorization', 'Bearer test-token')

    expect(res.status).toBe(500)
    await app.close()
  })

  it('returns 401 without a token', async () => {
    const app = await buildApp()
    const res = await supertest(app.server).get('/v1/users/me/consents')
    expect(res.status).toBe(401)
    await app.close()
  })
})

describe('POST /v1/users/me/consents', () => {
  const validBody = {
    consents: REQUIRED_CONSENTS.map(({ type, version }) => ({ type, version })),
    locale: 'es',
  }

  function consentsTable(upsertError: unknown = null) {
    const upsert = vi.fn(async () => ({ error: upsertError }))
    return {
      table: {
        upsert,
        select: vi.fn(() => ({ eq: vi.fn(async () => ({ data: allGrantedRows, error: null })) })),
      },
      upsert,
    }
  }

  it('records every posted pair with locale and evidence, idempotently', async () => {
    const { table, upsert } = consentsTable()
    from.mockReturnValue(table)
    const app = await buildApp()

    const res = await supertest(app.server)
      .post('/v1/users/me/consents')
      .set('Authorization', 'Bearer test-token')
      .set('User-Agent', 'vitest-agent')
      .send(validBody)

    expect(res.status).toBe(200)
    expect(res.body.missing).toEqual([])

    expect(upsert).toHaveBeenCalledTimes(1)
    const [rows, options] = upsert.mock.calls[0] as unknown as [
      Array<Record<string, unknown>>,
      Record<string, unknown>,
    ]
    expect(rows).toHaveLength(REQUIRED_CONSENTS.length)
    expect(rows[0]).toMatchObject({
      user_id: 'user-123',
      type: REQUIRED_CONSENTS[0]!.type,
      version: REQUIRED_CONSENTS[0]!.version,
      locale: 'es',
    })
    expect((rows[0]!.evidence as Record<string, unknown>).user_agent).toBe('vitest-agent')
    expect((rows[0]!.evidence as Record<string, unknown>).ip).toBeTruthy()
    // ON CONFLICT DO NOTHING — a duplicate grant must not rewrite evidence
    expect(options).toMatchObject({ onConflict: 'user_id,type,version', ignoreDuplicates: true })
    await app.close()
  })

  it('prefers the proxy-forwarded x-client-ip for evidence over the socket address', async () => {
    const { table, upsert } = consentsTable()
    from.mockReturnValue(table)
    const app = await buildApp()

    const res = await supertest(app.server)
      .post('/v1/users/me/consents')
      .set('Authorization', 'Bearer test-token')
      .set('X-Client-Ip', '203.0.113.7')
      .send(validBody)

    expect(res.status).toBe(200)
    const [rows] = upsert.mock.calls[0] as unknown as [Array<Record<string, unknown>>]
    expect((rows[0]!.evidence as Record<string, unknown>).ip).toBe('203.0.113.7')
    await app.close()
  })

  it('refuses a version the server does not currently require (stale client)', async () => {
    const { table, upsert } = consentsTable()
    from.mockReturnValue(table)
    const app = await buildApp()

    const res = await supertest(app.server)
      .post('/v1/users/me/consents')
      .set('Authorization', 'Bearer test-token')
      .send({ consents: [{ type: 'esign', version: '2020-01-01' }], locale: 'en' })

    expect(res.status).toBe(400)
    expect(res.body.error.code).toBe('validation_error')
    expect(upsert).not.toHaveBeenCalled()
    await app.close()
  })

  it('refuses bridge_tos — first-send paths write it server-side, never the client', async () => {
    const app = await buildApp()

    const res = await supertest(app.server)
      .post('/v1/users/me/consents')
      .set('Authorization', 'Bearer test-token')
      .send({ consents: [{ type: 'bridge_tos', version: '2026-08-27' }], locale: 'en' })

    expect(res.status).toBe(400)
    expect(from).not.toHaveBeenCalled()
    await app.close()
  })

  it('refuses an empty consents array', async () => {
    const app = await buildApp()

    const res = await supertest(app.server)
      .post('/v1/users/me/consents')
      .set('Authorization', 'Bearer test-token')
      .send({ consents: [], locale: 'en' })

    expect(res.status).toBe(400)
    await app.close()
  })

  it('refuses a missing locale — evidence must record the language presented', async () => {
    const app = await buildApp()

    const res = await supertest(app.server)
      .post('/v1/users/me/consents')
      .set('Authorization', 'Bearer test-token')
      .send({ consents: [{ type: 'esign', version: REQUIRED_CONSENTS[0]!.version }] })

    expect(res.status).toBe(400)
    await app.close()
  })

  it('returns 500 when the insert fails', async () => {
    const { table } = consentsTable({ code: 'XX000' })
    from.mockReturnValue(table)
    const app = await buildApp()

    const res = await supertest(app.server)
      .post('/v1/users/me/consents')
      .set('Authorization', 'Bearer test-token')
      .send(validBody)

    expect(res.status).toBe(500)
    await app.close()
  })

  it('returns 401 without a token', async () => {
    const app = await buildApp()
    const res = await supertest(app.server).post('/v1/users/me/consents').send(validBody)
    expect(res.status).toBe(401)
    await app.close()
  })
})
