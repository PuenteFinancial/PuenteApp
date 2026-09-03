import { describe, it, expect, beforeEach, vi } from 'vitest'
import supertest from 'supertest'
import Fastify from 'fastify'
import fp from 'fastify-plugin'
import { BRIDGE_TOS_VERSION, REQUIRED_CONSENTS } from '@puente/shared'

const from = vi.fn()

vi.mock('../../services/supabase.js', () => ({
  supabaseAdmin: {
    from: (...args: unknown[]) => from(...args),
  },
}))

const { consentsRoute, hasBridgeTos } = await import('./consents.js')

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

describe('hasBridgeTos', () => {
  it('is true only for a bridge_tos row at the current version', () => {
    expect(hasBridgeTos([])).toBe(false)
    expect(hasBridgeTos([{ type: 'bridge_tos', version: 'v1' }])).toBe(false)
    expect(hasBridgeTos([{ type: 'esign', version: BRIDGE_TOS_VERSION }])).toBe(false)
    expect(hasBridgeTos([{ type: 'bridge_tos', version: BRIDGE_TOS_VERSION }])).toBe(true)
  })
})

describe('POST /v1/users/me/bridge-tos (K6)', () => {
  // Two tables: the consents evidence upsert, then the users pointer update.
  function bridgeTosTables(opts: { consentError?: unknown; pointerError?: unknown } = {}) {
    const upsert = vi.fn(async (..._args: unknown[]) => ({ error: opts.consentError ?? null }))
    const eq = vi.fn(async (..._args: unknown[]) => ({ error: opts.pointerError ?? null }))
    const update = vi.fn((..._args: unknown[]) => ({ eq }))
    from.mockImplementation((table: string) =>
      table === 'consents' ? { upsert } : table === 'users' ? { update } : undefined,
    )
    return { upsert, update, eq }
  }

  it('records the evidence row and the latest agreement pointer', async () => {
    const { upsert, update, eq } = bridgeTosTables()
    const app = await buildApp()

    const res = await supertest(app.server)
      .post('/v1/users/me/bridge-tos')
      .set('Authorization', 'Bearer test-token')
      .set('x-client-ip', '203.0.113.7')
      .set('user-agent', 'drive/1.0')
      .send({ signed_agreement_id: 'a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d', locale: 'es' })

    expect(res.status).toBe(200)
    expect(res.body).toEqual({ bridgeTosAccepted: true })
    expect(upsert).toHaveBeenCalledWith(
      {
        user_id: 'user-123',
        type: 'bridge_tos',
        version: BRIDGE_TOS_VERSION,
        locale: 'es',
        evidence: {
          ip: '203.0.113.7',
          user_agent: 'drive/1.0',
          signed_agreement_id: 'a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d',
        },
      },
      { onConflict: 'user_id,type,version', ignoreDuplicates: true },
    )
    expect(update).toHaveBeenCalledWith({
      bridge_signed_agreement_id: 'a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d',
    })
    expect(eq).toHaveBeenCalledWith('id', 'user-123')
    await app.close()
  })

  it('defaults the locale to en', async () => {
    const { upsert } = bridgeTosTables()
    const app = await buildApp()
    const res = await supertest(app.server)
      .post('/v1/users/me/bridge-tos')
      .set('Authorization', 'Bearer test-token')
      .send({ signed_agreement_id: 'agr-12345678' })
    expect(res.status).toBe(200)
    expect(upsert.mock.calls[0]![0]).toMatchObject({ locale: 'en' })
    await app.close()
  })

  it('refuses an agreement id that could carry URL syntax', async () => {
    const { upsert } = bridgeTosTables()
    const app = await buildApp()

    const bad = await supertest(app.server)
      .post('/v1/users/me/bridge-tos')
      .set('Authorization', 'Bearer test-token')
      .send({ signed_agreement_id: 'agr_123?next=https://evil.test' })
    expect(bad.status).toBe(400)
    expect(upsert).not.toHaveBeenCalled()
    await app.close()
  })

  it('strips unknown fields — the consent type can never be chosen by the client', async () => {
    // Fastify's default Ajv removes properties additionalProperties:false
    // forbids rather than 400ing; either way `type` is fixed server-side.
    const { upsert } = bridgeTosTables()
    const app = await buildApp()
    const res = await supertest(app.server)
      .post('/v1/users/me/bridge-tos')
      .set('Authorization', 'Bearer test-token')
      .send({ signed_agreement_id: 'agr-12345678', type: 'esign', version: '2020-01-01' })
    expect(res.status).toBe(200)
    expect(upsert.mock.calls[0]![0]).toMatchObject({ type: 'bridge_tos', version: BRIDGE_TOS_VERSION })
    await app.close()
  })

  it('returns 401 without a token', async () => {
    const app = await buildApp()
    const res = await supertest(app.server)
      .post('/v1/users/me/bridge-tos')
      .send({ signed_agreement_id: 'agr-12345678' })
    expect(res.status).toBe(401)
    await app.close()
  })

  it('500s and never writes the pointer when the evidence row fails', async () => {
    const { update } = bridgeTosTables({ consentError: { code: 'XX000' } })
    const app = await buildApp()
    const res = await supertest(app.server)
      .post('/v1/users/me/bridge-tos')
      .set('Authorization', 'Bearer test-token')
      .send({ signed_agreement_id: 'agr-12345678' })
    expect(res.status).toBe(500)
    expect(update).not.toHaveBeenCalled()
    await app.close()
  })

  it('500s when the pointer write fails', async () => {
    bridgeTosTables({ pointerError: { code: 'XX000' } })
    const app = await buildApp()
    const res = await supertest(app.server)
      .post('/v1/users/me/bridge-tos')
      .set('Authorization', 'Bearer test-token')
      .send({ signed_agreement_id: 'agr-12345678' })
    expect(res.status).toBe(500)
    await app.close()
  })
})
