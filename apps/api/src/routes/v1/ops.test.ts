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
  OPS_WRITE_ENABLED: false,
}))
vi.mock('../../config/env.js', () => ({ env: envMock }))

const buildOpsOverview = vi.hoisted(() => vi.fn())
vi.mock('../../services/ops-overview.js', () => ({
  buildOpsOverview: (...args: unknown[]) => buildOpsOverview(...args),
}))

// The decision services are pinned in cancellation-review.test.ts /
// .db.test.ts; here they are mocked so the route tests cover ONLY the gate,
// validation, and ReviewOutcome→HTTP mapping.
const refundCancellation = vi.hoisted(() => vi.fn())
const denyCancellation = vi.hoisted(() => vi.fn())
vi.mock('../../services/cancellation-review.js', () => ({
  refundCancellation: (...args: unknown[]) => refundCancellation(...args),
  denyCancellation: (...args: unknown[]) => denyCancellation(...args),
}))

// supabaseAdmin backs only the idempotency plugin here — claims always win.
const from = vi.hoisted(() => vi.fn())
vi.mock('../../services/supabase.js', () => ({
  supabaseAdmin: { from: (...args: unknown[]) => from(...args) },
}))

const { opsRoute } = await import('./ops.js')
const { errorHandlerPlugin } = await import('../../plugins/error-handler.js')
const { idempotencyPlugin } = await import('../../plugins/idempotency.js')

function chain(result: { data?: unknown; error?: unknown }) {
  const resolved = { data: result.data ?? null, error: result.error ?? null }
  const b: Record<string, ReturnType<typeof vi.fn>> & {
    then?: (resolve: (v: unknown) => void) => void
  } = {} as never
  for (const m of ['select', 'insert', 'update', 'delete', 'eq', 'is', 'not', 'or', 'order', 'limit'] as const) {
    b[m] = vi.fn(() => b)
  }
  b['single'] = vi.fn(async () => resolved)
  b.then = (resolve) => resolve(resolved)
  return b
}

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
  // The REAL idempotency plugin (claims always win via the supabase mock) so
  // the required-header contract is exercised, not asserted by config probing.
  await app.register(idempotencyPlugin)
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
  envMock.OPS_WRITE_ENABLED = false
  buildOpsOverview.mockReset().mockResolvedValue(OVERVIEW)
  refundCancellation.mockReset()
  denyCancellation.mockReset()
  from.mockReset().mockImplementation(() => chain({ data: { id: 'claim-1' } }))
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

  it('200s an allowlisted admin with the full overview (actions dark)', async () => {
    const app = await buildApp()
    const res = await supertest(app.server)
      .get('/v1/ops/overview')
      .set('Authorization', `Bearer ${ADMIN}`)
    expect(res.status).toBe(200)
    expect(res.body).toEqual({ ...OVERVIEW, actionsEnabled: false })
    await app.close()
  })

  it('reports actionsEnabled true when the write capability is on', async () => {
    envMock.OPS_WRITE_ENABLED = true
    const app = await buildApp()
    const res = await supertest(app.server)
      .get('/v1/ops/overview')
      .set('Authorization', `Bearer ${ADMIN}`)
    expect(res.status).toBe(200)
    expect(res.body.actionsEnabled).toBe(true)
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

const TRANSFER_ID = 'cccccccc-1111-4222-8333-444444444444'
const RESOLVE_PATH = '/v1/ops/cancellations/resolve'
const DEPOSITED_AT = '2026-08-01T15:00:00.000Z'

function resolvePost(app: Awaited<ReturnType<typeof buildApp>>, token: string) {
  return supertest(app.server)
    .post(RESOLVE_PATH)
    .set('Authorization', `Bearer ${token}`)
    .set('Idempotency-Key', 'test-key-1')
}

describe('POST /v1/ops/cancellations/resolve', () => {
  beforeEach(() => {
    envMock.OPS_WRITE_ENABLED = true
    refundCancellation.mockResolvedValue({ done: true, outcome: 'refunded' })
    denyCancellation.mockResolvedValue({ done: true, outcome: 'denied' })
  })

  describe('gate', () => {
    it('is not registered at all when OPS_WRITE_ENABLED is false (router 404)', async () => {
      envMock.OPS_WRITE_ENABLED = false
      const app = await buildApp()
      const res = await resolvePost(app, ADMIN).send({ transferId: TRANSFER_ID, decision: 'refund' })
      expect(res.status).toBe(404)
      expect(res.body.error.code).toBe('not_found')
      // the read surface is untouched by the write flag
      const read = await supertest(app.server)
        .get('/v1/ops/overview')
        .set('Authorization', `Bearer ${ADMIN}`)
      expect(read.status).toBe(200)
      await app.close()
    })

    it('401s an unauthenticated request', async () => {
      const app = await buildApp()
      const res = await supertest(app.server)
        .post(RESOLVE_PATH)
        .send({ transferId: TRANSFER_ID, decision: 'refund' })
      expect(res.status).toBe(401)
      await app.close()
    })

    it('404s a non-admin with a body identical to a genuinely missing route', async () => {
      const app = await buildApp()
      const gated = await resolvePost(app, NON_ADMIN).send({
        transferId: TRANSFER_ID,
        decision: 'refund',
      })
      const missing = await supertest(app.server)
        .post('/v1/ops/nonexistent')
        .set('Authorization', `Bearer ${NON_ADMIN}`)
        .send({})
      expect(gated.status).toBe(404)
      expect(missing.status).toBe(404)
      expect(gated.body.error.code).toBe(missing.body.error.code)
      expect(gated.body.error.message).toBe(missing.body.error.message)
      expect(Object.keys(gated.body.error).sort()).toEqual(Object.keys(missing.body.error).sort())
      expect(refundCancellation).not.toHaveBeenCalled()
      expect(denyCancellation).not.toHaveBeenCalled()
      await app.close()
    })

    it('404s even an admin when the write flag drops after registration (handler re-check)', async () => {
      const app = await buildApp()
      envMock.OPS_WRITE_ENABLED = false
      const res = await resolvePost(app, ADMIN).send({ transferId: TRANSFER_ID, decision: 'refund' })
      expect(res.status).toBe(404)
      expect(res.body.error.code).toBe('not_found')
      expect(res.body.error.message).toBe('Route not found')
      expect(refundCancellation).not.toHaveBeenCalled()
      await app.close()
    })
  })

  describe('validation', () => {
    it('400s without an Idempotency-Key header (money-moving POST)', async () => {
      const app = await buildApp()
      const res = await supertest(app.server)
        .post(RESOLVE_PATH)
        .set('Authorization', `Bearer ${ADMIN}`)
        .send({ transferId: TRANSFER_ID, decision: 'refund' })
      expect(res.status).toBe(400)
      expect(res.body.error.code).toBe('validation_error')
      expect(refundCancellation).not.toHaveBeenCalled()
      await app.close()
    })

    it('400s a missing transferId', async () => {
      const app = await buildApp()
      const res = await resolvePost(app, ADMIN).send({ decision: 'refund' })
      expect(res.status).toBe(400)
      await app.close()
    })

    it('400s a non-uuid transferId', async () => {
      const app = await buildApp()
      const res = await resolvePost(app, ADMIN).send({ transferId: 'not-a-uuid', decision: 'refund' })
      expect(res.status).toBe(400)
      await app.close()
    })

    it('400s a decision outside the enum', async () => {
      const app = await buildApp()
      const res = await resolvePost(app, ADMIN).send({ transferId: TRANSFER_ID, decision: 'approve' })
      expect(res.status).toBe(400)
      await app.close()
    })

    it('400s a deny without depositedAt, naming the field', async () => {
      const app = await buildApp()
      const res = await resolvePost(app, ADMIN).send({ transferId: TRANSFER_ID, decision: 'deny' })
      expect(res.status).toBe(400)
      expect(res.body.error.code).toBe('validation_error')
      expect(res.body.error.details).toEqual([
        { path: 'depositedAt', issue: 'required when decision is deny' },
      ])
      expect(denyCancellation).not.toHaveBeenCalled()
      await app.close()
    })

    it('400s a refund WITH depositedAt — evidence input is never silently ignored', async () => {
      const app = await buildApp()
      const res = await resolvePost(app, ADMIN).send({
        transferId: TRANSFER_ID,
        decision: 'refund',
        depositedAt: DEPOSITED_AT,
      })
      expect(res.status).toBe(400)
      expect(res.body.error.details).toEqual([
        { path: 'depositedAt', issue: 'only allowed when decision is deny' },
      ])
      expect(refundCancellation).not.toHaveBeenCalled()
      await app.close()
    })

    it('400s an unparseable depositedAt at the schema — the service throw path is unreachable', async () => {
      const app = await buildApp()
      const res = await resolvePost(app, ADMIN).send({
        transferId: TRANSFER_ID,
        decision: 'deny',
        depositedAt: 'yesterday-ish',
      })
      expect(res.status).toBe(400)
      expect(denyCancellation).not.toHaveBeenCalled()
      await app.close()
    })
  })

  describe('outcome mapping', () => {
    it('200s a refund, attributing the authenticated admin as operator', async () => {
      const app = await buildApp()
      const res = await resolvePost(app, ADMIN).send({ transferId: TRANSFER_ID, decision: 'refund' })
      expect(res.status).toBe(200)
      expect(res.body).toEqual({ transferId: TRANSFER_ID, outcome: 'refunded' })
      expect(refundCancellation).toHaveBeenCalledWith({ transferId: TRANSFER_ID, operator: ADMIN })
      await app.close()
    })

    it('200s a deny, passing the cited depositedAt through', async () => {
      const app = await buildApp()
      const res = await resolvePost(app, ADMIN).send({
        transferId: TRANSFER_ID,
        decision: 'deny',
        depositedAt: DEPOSITED_AT,
      })
      expect(res.status).toBe(200)
      expect(res.body).toEqual({ transferId: TRANSFER_ID, outcome: 'denied' })
      expect(denyCancellation).toHaveBeenCalledWith({
        transferId: TRANSFER_ID,
        operator: ADMIN,
        depositedAt: DEPOSITED_AT,
      })
      await app.close()
    })

    it.each(['already_disbursed', 'already_refunded'] as const)(
      '200s the crash-recovery outcome %s distinctly (no money moved this run)',
      async (outcome) => {
        refundCancellation.mockResolvedValue({ done: true, outcome })
        const app = await buildApp()
        const res = await resolvePost(app, ADMIN).send({ transferId: TRANSFER_ID, decision: 'refund' })
        expect(res.status).toBe(200)
        expect(res.body).toEqual({ transferId: TRANSFER_ID, outcome })
        await app.close()
      },
    )

    it('404s transfer_not_found with a plain not_found (post-gate: an admin may learn this)', async () => {
      refundCancellation.mockResolvedValue({ done: false, reason: 'transfer_not_found' })
      const app = await buildApp()
      const res = await resolvePost(app, ADMIN).send({ transferId: TRANSFER_ID, decision: 'refund' })
      expect(res.status).toBe(404)
      expect(res.body.error.code).toBe('not_found')
      expect(res.body.error.message).toBe('Transfer not found')
      await app.close()
    })

    it('409 conflict for not_under_review, carrying the actual state', async () => {
      refundCancellation.mockResolvedValue({
        done: false,
        reason: 'not_under_review',
        state: 'SUBMITTED',
      })
      const app = await buildApp()
      const res = await resolvePost(app, ADMIN).send({ transferId: TRANSFER_ID, decision: 'refund' })
      expect(res.status).toBe(409)
      expect(res.body.error.code).toBe('conflict')
      expect(res.body.error.message).toContain('SUBMITTED')
      await app.close()
    })

    it('409 conflict for no_pending_request (stale board)', async () => {
      denyCancellation.mockResolvedValue({ done: false, reason: 'no_pending_request' })
      const app = await buildApp()
      const res = await resolvePost(app, ADMIN).send({
        transferId: TRANSFER_ID,
        decision: 'deny',
        depositedAt: DEPOSITED_AT,
      })
      expect(res.status).toBe(409)
      expect(res.body.error.code).toBe('conflict')
      await app.close()
    })

    it('409 conflict for claim_taken (transient — retry after refresh)', async () => {
      refundCancellation.mockResolvedValue({
        done: false,
        reason: 'claim_taken',
        claimedAt: '2026-08-01T14:00:00.000Z',
        claimedBy: 'ops:someone-else',
      })
      const app = await buildApp()
      const res = await resolvePost(app, ADMIN).send({ transferId: TRANSFER_ID, decision: 'refund' })
      expect(res.status).toBe(409)
      expect(res.body.error.code).toBe('conflict')
      await app.close()
    })

    it('409 claim_abandoned as its OWN code — the danger state must not read as a retryable conflict', async () => {
      refundCancellation.mockResolvedValue({
        done: false,
        reason: 'claim_abandoned',
        claimedAt: '2026-08-01T02:00:00.000Z',
        claimedBy: 'ops:crashed-run',
      })
      const app = await buildApp()
      const res = await resolvePost(app, ADMIN).send({ transferId: TRANSFER_ID, decision: 'refund' })
      expect(res.status).toBe(409)
      expect(res.body.error.code).toBe('claim_abandoned')
      await app.close()
    })

    it('409 refund_owed for request_precedes_deposit — the permanent legal refusal', async () => {
      denyCancellation.mockResolvedValue({ done: false, reason: 'request_precedes_deposit' })
      const app = await buildApp()
      const res = await resolvePost(app, ADMIN).send({
        transferId: TRANSFER_ID,
        decision: 'deny',
        depositedAt: DEPOSITED_AT,
      })
      expect(res.status).toBe(409)
      expect(res.body.error.code).toBe('refund_owed')
      await app.close()
    })

    it('409 deposit_evidence_conflict with the legal bounds in details', async () => {
      denyCancellation.mockResolvedValue({
        done: false,
        reason: 'deposit_evidence_conflict',
        paymentAt: '2026-08-01T10:00:00.000Z',
        depositEvidenceAt: '2026-08-01T12:00:00.000Z',
      })
      const app = await buildApp()
      const res = await resolvePost(app, ADMIN).send({
        transferId: TRANSFER_ID,
        decision: 'deny',
        depositedAt: DEPOSITED_AT,
      })
      expect(res.status).toBe(409)
      expect(res.body.error.code).toBe('deposit_evidence_conflict')
      expect(res.body.error.details).toEqual([
        {
          path: 'depositedAt',
          issue: 'must lie between 2026-08-01T10:00:00.000Z and 2026-08-01T12:00:00.000Z',
        },
      ])
      await app.close()
    })

    it('500s (fail closed, message off the wire) when the service throws', async () => {
      refundCancellation.mockRejectedValue(new Error('ledger post failed: SENSITIVE'))
      const app = await buildApp()
      const res = await resolvePost(app, ADMIN).send({ transferId: TRANSFER_ID, decision: 'refund' })
      expect(res.status).toBe(500)
      expect(res.body.error.code).toBe('internal_error')
      expect(res.body.error.message).toBe('Something went wrong')
      await app.close()
    })

    it('strips unknown fields through the response schema (the output allowlist)', async () => {
      refundCancellation.mockResolvedValue({
        done: true,
        outcome: 'refunded',
        leakedProviderBody: 'SENSITIVE',
      })
      const app = await buildApp()
      const res = await resolvePost(app, ADMIN).send({ transferId: TRANSFER_ID, decision: 'refund' })
      expect(res.status).toBe(200)
      expect(res.body).toEqual({ transferId: TRANSFER_ID, outcome: 'refunded' })
      await app.close()
    })
  })
})
