import { describe, it, expect, beforeEach, vi } from 'vitest'
import supertest from 'supertest'
import Fastify from 'fastify'
import fp from 'fastify-plugin'

// The ops route's whole job is the GATE: allowlist-first, 404-never-403 with a
// body byte-identical to the router's own not-found, fail-closed 500s. The
// aggregate itself is pinned in services/ops-overview.test.ts, so it is mocked
// here.

const envMock = vi.hoisted(() => ({
  OPS_ADMIN_USER_IDS: new Set<string>(),
}))
vi.mock('../../config/env.js', () => ({ env: envMock }))

const buildOpsOverview = vi.hoisted(() => vi.fn())
vi.mock('../../services/ops-overview.js', () => ({
  buildOpsOverview: (...args: unknown[]) => buildOpsOverview(...args),
}))

const { opsRoute } = await import('./ops.js')
const { errorHandlerPlugin } = await import('../../plugins/error-handler.js')

const ADMIN = 'aaaaaaaa-1111-4222-8333-444444444444'
const NON_ADMIN = 'bbbbbbbb-1111-4222-8333-444444444444'

// mockAuth mirrors dev.test.ts: any bearer token authenticates; the token
// value selects the identity so admin vs non-admin is per-request.
const mockAuth = fp(async (server) => {
  server.addHook('onRequest', async (request, reply) => {
    const token = request.headers.authorization?.replace('Bearer ', '')
    if (!token) {
      return reply.code(401).send({ error: 'Unauthorized' })
    }
    request.user = { id: token }
  })
})

async function buildApp() {
  const app = Fastify({ logger: false })
  // The REAL production error handler, not a hand-copied envelope: the
  // indistinguishability assertion below must break if plugins/error-handler
  // ever changes its not-found shape (review finding).
  await app.register(errorHandlerPlugin)
  await app.register(mockAuth)
  await app.register(opsRoute, { prefix: '/v1' })
  await app.ready()
  return app
}

const OVERVIEW = {
  generatedAt: '2026-08-01T12:00:00.000Z',
  pendingCancellations: [],
  openTransfers: [],
  floatCeiling: { configured: false, tripped: null, balanceMinor: 0, ceilingMinor: null },
  transferCounts: [{ state: 'COMPLETED', count: 3 }],
  ledgerBalances: null,
  reconciliationRuns: [],
}

beforeEach(() => {
  envMock.OPS_ADMIN_USER_IDS = new Set([ADMIN])
  buildOpsOverview.mockReset().mockResolvedValue(OVERVIEW)
})

describe('GET /v1/ops/overview', () => {
  it('401s an unauthenticated request', async () => {
    const app = await buildApp()
    const res = await supertest(app.server).get('/v1/ops/overview')
    expect(res.status).toBe(401)
    await app.close()
  })

  it('404s a non-admin with a body identical to a genuinely missing route', async () => {
    const app = await buildApp()

    const gated = await supertest(app.server)
      .get('/v1/ops/overview')
      .set('Authorization', `Bearer ${NON_ADMIN}`)
    const missing = await supertest(app.server)
      .get('/v1/ops/nonexistent')
      .set('Authorization', `Bearer ${NON_ADMIN}`)

    expect(gated.status).toBe(404)
    expect(missing.status).toBe(404)
    // Same code + message; requestId naturally differs per request.
    expect(gated.body.error.code).toBe(missing.body.error.code)
    expect(gated.body.error.message).toBe(missing.body.error.message)
    expect(Object.keys(gated.body.error).sort()).toEqual(Object.keys(missing.body.error).sort())
    // And no read ever ran for the non-admin.
    expect(buildOpsOverview).not.toHaveBeenCalled()
    await app.close()
  })

  it('200s an allowlisted admin with the full overview', async () => {
    const app = await buildApp()
    const res = await supertest(app.server)
      .get('/v1/ops/overview')
      .set('Authorization', `Bearer ${ADMIN}`)
    expect(res.status).toBe(200)
    expect(res.body).toEqual(OVERVIEW)
    await app.close()
  })

  it('500s (fail closed) when a panel read throws — never an empty page', async () => {
    buildOpsOverview.mockRejectedValue(new Error('reconciliation_runs read failed'))
    const app = await buildApp()
    const res = await supertest(app.server)
      .get('/v1/ops/overview')
      .set('Authorization', `Bearer ${ADMIN}`)
    expect(res.status).toBe(500)
    expect(res.body.error.code).toBe('internal_error')
    // The upstream failure detail stays in logs, off the wire.
    expect(res.body.error.message).toBe('Something went wrong')
    await app.close()
  })

  it('strips unknown fields through the response schema (the output allowlist)', async () => {
    buildOpsOverview.mockResolvedValue({
      ...OVERVIEW,
      reconciliationRuns: [
        {
          createdAt: '2026-08-01T06:00:00.000Z',
          status: 'findings',
          findingsCount: 1,
          checks: [
            {
              name: 'bridge_wallet_float',
              status: 'findings',
              findingsCount: 1,
              // simulated future leak: a check field the schema does not know
              summary: { providerBody: 'SENSITIVE' },
            },
          ],
        },
      ],
      leakedTopLevel: 'SENSITIVE',
    })
    const app = await buildApp()
    const res = await supertest(app.server)
      .get('/v1/ops/overview')
      .set('Authorization', `Bearer ${ADMIN}`)
    expect(res.status).toBe(200)
    expect(res.body.leakedTopLevel).toBeUndefined()
    expect(res.body.reconciliationRuns[0].checks[0]).toEqual({
      name: 'bridge_wallet_float',
      status: 'findings',
      findingsCount: 1,
    })
    await app.close()
  })
})
