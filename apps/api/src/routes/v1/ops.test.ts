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

// Same split for out-of-band funding: the appliers and every refusal rule are
// pinned in funding-apply tests; here the service is mocked so these cover only
// the gate, validation, and result→HTTP mapping.
const recordManualFunding = vi.hoisted(() => vi.fn())
vi.mock('../../services/funding-apply.js', () => ({
  recordManualFunding: (...args: unknown[]) => recordManualFunding(...args),
}))

// Same split for #199: the attach rules (Bridge fetch, amount verify, upsert)
// are pinned in deposit-instructions tests; here only gate + mapping.
const attachDepositInstructions = vi.hoisted(() => vi.fn())
const getDepositInstructions = vi.hoisted(() => vi.fn())
vi.mock('../../services/deposit-instructions.js', () => ({
  attachDepositInstructions: (...args: unknown[]) => attachDepositInstructions(...args),
  getDepositInstructions: (...args: unknown[]) => getDepositInstructions(...args),
}))

// The float top-up ledger rules are pinned in payouts tests — routes here
// cover only gate + ordering. Serves both callers: deposit-landed (slice 1 —
// cleared first, top-up on BOTH outcomes) and the ad-hoc treasury entry
// (slice 2 — after-balance echo). The PayoutValidationError class shape is
// mirrored so instanceof works in the slice-2 route's 400 branch.
const recordFloatTopUp = vi.hoisted(() => vi.fn())
class MockPayoutValidationError extends Error {}
vi.mock('../../services/payouts.js', () => ({
  recordFloatTopUp: (...args: unknown[]) => recordFloatTopUp(...args),
  PayoutValidationError: MockPayoutValidationError,
}))

const getAccountBalance = vi.hoisted(() => vi.fn())
vi.mock('../../services/ledger.js', () => ({
  getAccountBalance: (...args: unknown[]) => getAccountBalance(...args),
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
  workerHeartbeats: [
    { worker: 'worker', beatAt: '2026-08-01T11:58:00.000Z', ageSeconds: 120, stale: false },
  ],
}

beforeEach(() => {
  envMock.OPS_ADMIN_USER_IDS = new Set([ADMIN])
  envMock.OPS_WRITE_ENABLED = false
  buildOpsOverview.mockReset().mockResolvedValue(OVERVIEW)
  refundCancellation.mockReset()
  denyCancellation.mockReset()
  recordManualFunding.mockReset()
  attachDepositInstructions.mockReset()
  getDepositInstructions.mockReset().mockResolvedValue(null)
  recordFloatTopUp.mockReset().mockResolvedValue({ idempotencyKey: 'float_topup:x' })
  getAccountBalance.mockReset().mockResolvedValue({ amountMinor: 22_000, currency: 'USD' })
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

    it('404s a non-admin BEFORE validation and the idempotency plugin — a missing header or garbage body must not leak a 400', async () => {
      const app = await buildApp()
      // No Idempotency-Key and an invalid body: if the gate ran after
      // validation/preHandler, either would answer 400 and confirm the route
      // exists. The 404 posture requires the gate to win.
      const res = await supertest(app.server)
        .post(RESOLVE_PATH)
        .set('Authorization', `Bearer ${NON_ADMIN}`)
        .send({ nonsense: true })
      const missing = await supertest(app.server)
        .post('/v1/ops/nonexistent')
        .set('Authorization', `Bearer ${NON_ADMIN}`)
        .send({ nonsense: true })
      expect(res.status).toBe(404)
      expect(res.body.error.code).toBe(missing.body.error.code)
      expect(res.body.error.message).toBe(missing.body.error.message)
      expect(Object.keys(res.body.error).sort()).toEqual(Object.keys(missing.body.error).sort())
      // and the gate refusal never touched the idempotency store
      expect(from).not.toHaveBeenCalled()
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

const FUNDING_PATH = '/v1/ops/transfers/funding'
const EXTERNAL_REF = 'c8617cef-1adf-4dba-b978-c68150901663'

function fundingPost(app: Awaited<ReturnType<typeof buildApp>>, token: string) {
  return supertest(app.server)
    .post(FUNDING_PATH)
    .set('Authorization', `Bearer ${token}`)
    .set('Idempotency-Key', 'funding-key-1')
}

const FUNDED_BODY = {
  transferId: TRANSFER_ID,
  kind: 'funded' as const,
  externalRef: EXTERNAL_REF,
  amountMinor: 5100,
  currency: 'USD' as const,
}

describe('POST /v1/ops/transfers/funding', () => {
  beforeEach(() => {
    envMock.OPS_WRITE_ENABLED = true
    recordManualFunding.mockResolvedValue({ done: true, outcome: 'funded' })
  })

  describe('gate', () => {
    it('is not registered at all when OPS_WRITE_ENABLED is false (router 404)', async () => {
      envMock.OPS_WRITE_ENABLED = false
      const app = await buildApp()
      const res = await fundingPost(app, ADMIN).send(FUNDED_BODY)
      expect(res.status).toBe(404)
      expect(recordManualFunding).not.toHaveBeenCalled()
      await app.close()
    })

    it('401s an unauthenticated request', async () => {
      const app = await buildApp()
      const res = await supertest(app.server).post(FUNDING_PATH).send(FUNDED_BODY)
      expect(res.status).toBe(401)
      await app.close()
    })

    it('404s a non-admin with a body identical to a genuinely missing route', async () => {
      const app = await buildApp()
      const gated = await fundingPost(app, NON_ADMIN).send(FUNDED_BODY)
      const missing = await supertest(app.server)
        .post('/v1/ops/nonexistent')
        .set('Authorization', `Bearer ${NON_ADMIN}`)
        .send({})
      expect(gated.status).toBe(404)
      expect(gated.body.error.code).toBe(missing.body.error.code)
      expect(gated.body.error.message).toBe(missing.body.error.message)
      expect(Object.keys(gated.body.error).sort()).toEqual(Object.keys(missing.body.error).sort())
      expect(recordManualFunding).not.toHaveBeenCalled()
      await app.close()
    })

    it('404s a non-admin BEFORE validation and the idempotency plugin', async () => {
      // No Idempotency-Key and a garbage body: either would answer 400 and
      // confirm the route exists if the gate ran after validation.
      const app = await buildApp()
      const res = await supertest(app.server)
        .post(FUNDING_PATH)
        .set('Authorization', `Bearer ${NON_ADMIN}`)
        .send({ nonsense: true })
      expect(res.status).toBe(404)
      expect(res.body.error.code).toBe('not_found')
      expect(from).not.toHaveBeenCalled()
      await app.close()
    })

    it('404s even an admin when the write flag drops after registration', async () => {
      const app = await buildApp()
      envMock.OPS_WRITE_ENABLED = false
      const res = await fundingPost(app, ADMIN).send(FUNDED_BODY)
      expect(res.status).toBe(404)
      expect(recordManualFunding).not.toHaveBeenCalled()
      await app.close()
    })
  })

  describe('validation', () => {
    it('400s without an Idempotency-Key header (money-moving POST)', async () => {
      const app = await buildApp()
      const res = await supertest(app.server)
        .post(FUNDING_PATH)
        .set('Authorization', `Bearer ${ADMIN}`)
        .send(FUNDED_BODY)
      expect(res.status).toBe(400)
      expect(recordManualFunding).not.toHaveBeenCalled()
      await app.close()
    })

    it.each([
      ['transferId', { ...FUNDED_BODY, transferId: undefined }],
      ['kind', { ...FUNDED_BODY, kind: undefined }],
      ['externalRef', { ...FUNDED_BODY, externalRef: undefined }],
      ['amountMinor', { ...FUNDED_BODY, amountMinor: undefined }],
      ['currency', { ...FUNDED_BODY, currency: undefined }],
    ])('400s a missing %s', async (_field, body) => {
      const app = await buildApp()
      const res = await fundingPost(app, ADMIN).send(body)
      expect(res.status).toBe(400)
      expect(recordManualFunding).not.toHaveBeenCalled()
      await app.close()
    })

    it('400s an unknown kind', async () => {
      const app = await buildApp()
      const res = await fundingPost(app, ADMIN).send({ ...FUNDED_BODY, kind: 'settled' })
      expect(res.status).toBe(400)
      expect(recordManualFunding).not.toHaveBeenCalled()
      await app.close()
    })

    it('400s a non-USD currency — the ledger is USD-only', async () => {
      const app = await buildApp()
      const res = await fundingPost(app, ADMIN).send({ ...FUNDED_BODY, currency: 'MXN' })
      expect(res.status).toBe(400)
      expect(recordManualFunding).not.toHaveBeenCalled()
      await app.close()
    })

    it('400s a zero or negative amount', async () => {
      const app = await buildApp()
      expect((await fundingPost(app, ADMIN).send({ ...FUNDED_BODY, amountMinor: 0 })).status).toBe(400)
      expect(recordManualFunding).not.toHaveBeenCalled()
      await app.close()
    })

    it('strips an unknown field so it can never reach the service', async () => {
      // additionalProperties:false + Fastify's removeAdditional means unknown
      // input is dropped, not rejected. What matters is that a smuggled flag
      // (`force`) cannot influence a money-moving call.
      const app = await buildApp()
      const res = await fundingPost(app, ADMIN).send({ ...FUNDED_BODY, force: true })
      expect(res.status).toBe(200)
      expect(recordManualFunding).toHaveBeenCalledWith(
        expect.not.objectContaining({ force: expect.anything() }),
      )
      await app.close()
    })
  })

  describe('outcome mapping', () => {
    it('passes the authenticated admin as the operator', async () => {
      const app = await buildApp()
      await fundingPost(app, ADMIN).send(FUNDED_BODY)
      expect(recordManualFunding).toHaveBeenCalledWith({
        transferId: TRANSFER_ID,
        kind: 'funded',
        externalRef: EXTERNAL_REF,
        amountMinor: 5100,
        operator: ADMIN,
      })
      await app.close()
    })

    it('200s a recorded funding', async () => {
      const app = await buildApp()
      const res = await fundingPost(app, ADMIN).send(FUNDED_BODY)
      expect(res.status).toBe(200)
      expect(res.body).toEqual({ transferId: TRANSFER_ID, outcome: 'funded' })
      await app.close()
    })

    it('200s a cleared leg and a skipped one distinctly', async () => {
      const app = await buildApp()
      recordManualFunding.mockResolvedValue({ done: true, outcome: 'cleared_skipped', state: 'CANCELED' })
      const res = await fundingPost(app, ADMIN).send({ ...FUNDED_BODY, kind: 'cleared' })
      expect(res.status).toBe(200)
      expect(res.body.outcome).toBe('cleared_skipped')
      await app.close()
    })

    it.each([
      [{ done: false, reason: 'transfer_not_found' }, 404, 'not_found'],
      [{ done: false, reason: 'already_funded' }, 409, 'conflict'],
      [{ done: false, reason: 'not_pending_payment', state: 'SUBMITTED' }, 409, 'conflict'],
      [{ done: false, reason: 'funding_not_initiated' }, 409, 'conflict'],
      [{ done: false, reason: 'amount_mismatch', expectedMinor: 5100 }, 409, 'conflict'],
      [{ done: false, reason: 'stale' }, 409, 'conflict'],
      [{ done: false, reason: 'processor_not_manual', provider: 'stripe' }, 409, 'conflict'],
    ])('maps %j to %i', async (result, status, code) => {
      const app = await buildApp()
      recordManualFunding.mockResolvedValue(result)
      const res = await fundingPost(app, ADMIN).send(FUNDED_BODY)
      expect(res.status).toBe(status)
      expect(res.body.error.code).toBe(code)
      await app.close()
    })

    it('names the expected amount on a mismatch so the operator can self-correct', async () => {
      const app = await buildApp()
      recordManualFunding.mockResolvedValue({
        done: false,
        reason: 'amount_mismatch',
        expectedMinor: 7300,
      })
      const res = await fundingPost(app, ADMIN).send(FUNDED_BODY)
      expect(res.status).toBe(409)
      expect(JSON.stringify(res.body)).toContain('7300')
      await app.close()
    })

    it('500s a thrown service error without leaking the message', async () => {
      const app = await buildApp()
      recordManualFunding.mockRejectedValue(new Error('ledger post failed: account xyz'))
      const res = await fundingPost(app, ADMIN).send(FUNDED_BODY)
      expect(res.status).toBe(500)
      expect(res.body.error.code).toBe('internal_error')
      expect(JSON.stringify(res.body)).not.toContain('account xyz')
      await app.close()
    })
  })
})

describe('POST /v1/ops/transfers/deposit-instructions', () => {
  const PATH = '/v1/ops/transfers/deposit-instructions'
  const TRANSFER_ID = 'cccccccc-1111-4222-8333-444444444444'
  const ONRAMP_ID = 'dddddddd-1111-4222-8333-444444444444'
  const BODY = { transferId: TRANSFER_ID, bridgeTransferId: ONRAMP_ID }

  function post(app: Awaited<ReturnType<typeof buildApp>>, token: string) {
    return supertest(app.server).post(PATH).set('Authorization', `Bearer ${token}`)
  }

  beforeEach(() => {
    envMock.OPS_WRITE_ENABLED = true
    attachDepositInstructions.mockResolvedValue({
      outcome: 'attached',
      row: { deposit_message: 'BRGABCD1234' },
    })
  })

  it('404s when OPS_WRITE_ENABLED is false', async () => {
    envMock.OPS_WRITE_ENABLED = false
    const app = await buildApp()
    const res = await post(app, ADMIN).send(BODY)
    expect(res.status).toBe(404)
    expect(attachDepositInstructions).not.toHaveBeenCalled()
    await app.close()
  })

  it('404s a non-admin, 401s no auth', async () => {
    const app = await buildApp()
    expect((await post(app, NON_ADMIN).send(BODY)).status).toBe(404)
    expect((await supertest(app.server).post(PATH).send(BODY)).status).toBe(401)
    expect(attachDepositInstructions).not.toHaveBeenCalled()
    await app.close()
  })

  it('400s a non-uuid bridgeTransferId', async () => {
    const app = await buildApp()
    const res = await post(app, ADMIN).send({ ...BODY, bridgeTransferId: 'onramp-1' })
    expect(res.status).toBe(400)
    expect(attachDepositInstructions).not.toHaveBeenCalled()
    await app.close()
  })

  it('attaches and returns the reference code, with the operator as attached_by', async () => {
    const app = await buildApp()
    const res = await post(app, ADMIN).send(BODY)
    expect(res.status).toBe(200)
    expect(res.body).toEqual({
      transferId: TRANSFER_ID,
      outcome: 'attached',
      depositMessage: 'BRGABCD1234',
    })
    expect(attachDepositInstructions).toHaveBeenCalledWith({
      transferId: TRANSFER_ID,
      bridgeTransferId: ONRAMP_ID,
      operator: ADMIN,
    })
    await app.close()
  })

  it.each([
    [{ outcome: 'unknown_transfer' }, 404],
    [{ outcome: 'not_pending_payment', state: 'FUNDED' }, 409],
    [{ outcome: 'amount_mismatch', expectedMinor: 10000, bridgeMinor: 25000 }, 409],
    [{ outcome: 'instructions_unavailable' }, 409],
  ] as const)('maps %o to %i', async (outcome, status) => {
    attachDepositInstructions.mockResolvedValue(outcome)
    const app = await buildApp()
    const res = await post(app, ADMIN).send(BODY)
    expect(res.status).toBe(status)
    await app.close()
  })

  it('500s with the generic envelope when the service throws', async () => {
    attachDepositInstructions.mockRejectedValue(new Error('bridge exploded'))
    const app = await buildApp()
    const res = await post(app, ADMIN).send(BODY)
    expect(res.status).toBe(500)
    expect(res.body.error.message).not.toContain('bridge exploded')
    await app.close()
  })
})

describe('POST /v1/ops/transfers/deposit-landed', () => {
  const PATH = '/v1/ops/transfers/deposit-landed'
  const BODY = {
    transferId: TRANSFER_ID,
    externalRef: EXTERNAL_REF,
    amountMinor: 5100,
    currency: 'USD' as const,
  }
  const post = (app: Awaited<ReturnType<typeof buildApp>>, token: string) =>
    supertest(app.server).post(PATH).set('Authorization', `Bearer ${token}`)

  beforeEach(() => {
    envMock.OPS_WRITE_ENABLED = true
    recordManualFunding.mockResolvedValue({ done: true, outcome: 'cleared' })
  })

  describe('gate', () => {
    it('is not registered at all when OPS_WRITE_ENABLED is false (router 404)', async () => {
      envMock.OPS_WRITE_ENABLED = false
      const app = await buildApp()
      const res = await post(app, ADMIN).send(BODY)
      expect(res.status).toBe(404)
      expect(recordManualFunding).not.toHaveBeenCalled()
      expect(recordFloatTopUp).not.toHaveBeenCalled()
      await app.close()
    })

    it('401s an unauthenticated request', async () => {
      const app = await buildApp()
      const res = await supertest(app.server).post(PATH).send(BODY)
      expect(res.status).toBe(401)
      await app.close()
    })

    it('404s a non-admin with a body identical to a genuinely missing route', async () => {
      const app = await buildApp()
      const gated = await post(app, NON_ADMIN).send(BODY)
      const missing = await supertest(app.server)
        .post('/v1/ops/nonexistent')
        .set('Authorization', `Bearer ${NON_ADMIN}`)
        .send(BODY)
      expect(gated.status).toBe(404)
      expect(gated.body.error.code).toBe(missing.body.error.code)
      expect(gated.body.error.message).toBe(missing.body.error.message)
      expect(Object.keys(gated.body.error).sort()).toEqual(Object.keys(missing.body.error).sort())
      expect(recordManualFunding).not.toHaveBeenCalled()
      expect(recordFloatTopUp).not.toHaveBeenCalled()
      await app.close()
    })

    it('404s a non-admin BEFORE validation — garbage body must not leak a 400', async () => {
      const app = await buildApp()
      const res = await post(app, NON_ADMIN).send({ nonsense: true })
      expect(res.status).toBe(404)
      await app.close()
    })

    it('404s even an admin when the write flag drops after registration', async () => {
      const app = await buildApp()
      envMock.OPS_WRITE_ENABLED = false
      const res = await post(app, ADMIN).send(BODY)
      expect(res.status).toBe(404)
      await app.close()
    })
  })

  describe('validation', () => {
    it('400s a missing externalRef', async () => {
      const app = await buildApp()
      const rest: Record<string, unknown> = { ...BODY }
      delete rest.externalRef
      const res = await post(app, ADMIN).send(rest)
      expect(res.status).toBe(400)
      expect(recordManualFunding).not.toHaveBeenCalled()
      await app.close()
    })

    it('400s an all-whitespace externalRef BEFORE any leg runs — it would settle the receivable and then blow up the top-up', async () => {
      const app = await buildApp()
      const res = await post(app, ADMIN).send({ ...BODY, externalRef: '   ' })
      expect(res.status).toBe(400)
      expect(res.body.error.details[0].path).toBe('externalRef')
      expect(recordManualFunding).not.toHaveBeenCalled()
      expect(recordFloatTopUp).not.toHaveBeenCalled()
      await app.close()
    })

    it('400s a non-USD currency', async () => {
      const app = await buildApp()
      const res = await post(app, ADMIN).send({ ...BODY, currency: 'MXN' })
      expect(res.status).toBe(400)
      await app.close()
    })

    it('strips an unknown field so it can never reach the services', async () => {
      const app = await buildApp()
      const res = await post(app, ADMIN).send({ ...BODY, kind: 'funded' })
      expect(res.status).toBe(200)
      expect(recordManualFunding).toHaveBeenCalledWith(
        expect.objectContaining({ kind: 'cleared' }),
      )
      await app.close()
    })
  })

  describe('outcome mapping and ordering', () => {
    it('200s a cleared deposit and posts the top-up with the SAME trimmed ref', async () => {
      const app = await buildApp()
      const res = await post(app, ADMIN).send({ ...BODY, externalRef: `  ${EXTERNAL_REF}  ` })
      expect(res.status).toBe(200)
      expect(res.body).toEqual({ transferId: TRANSFER_ID, outcome: 'cleared' })
      expect(recordManualFunding).toHaveBeenCalledWith({
        transferId: TRANSFER_ID,
        kind: 'cleared',
        externalRef: EXTERNAL_REF,
        amountMinor: 5100,
        operator: ADMIN,
      })
      expect(recordFloatTopUp).toHaveBeenCalledWith({
        amountMinor: 5100,
        externalRef: EXTERNAL_REF,
      })
      await app.close()
    })

    it('still posts the top-up on cleared_skipped — the re-tap-heals invariant', async () => {
      recordManualFunding.mockResolvedValue({
        done: true,
        outcome: 'cleared_skipped',
        state: 'SUBMITTED',
      })
      const app = await buildApp()
      const res = await post(app, ADMIN).send(BODY)
      expect(res.status).toBe(200)
      expect(res.body).toEqual({ transferId: TRANSFER_ID, outcome: 'cleared_skipped' })
      expect(recordFloatTopUp).toHaveBeenCalledWith({
        amountMinor: 5100,
        externalRef: EXTERNAL_REF,
      })
      await app.close()
    })

    it('409s a ref that does not match the attached instructions — the cross-transfer typo guard', async () => {
      getDepositInstructions.mockResolvedValue({ bridge_transfer_ref: 'the-real-onramp-id' })
      const app = await buildApp()
      const res = await post(app, ADMIN).send({ ...BODY, externalRef: 'some-other-ref' })
      expect(res.status).toBe(409)
      expect(res.body.error.details[0].issue).toContain('the-real-onramp-id')
      // NEITHER book moved: the typo would have consumed another transfer's
      // float_topup key and left the float silently short until recon.
      expect(recordManualFunding).not.toHaveBeenCalled()
      expect(recordFloatTopUp).not.toHaveBeenCalled()
      await app.close()
    })

    it('accepts a ref that matches the attached instructions', async () => {
      getDepositInstructions.mockResolvedValue({ bridge_transfer_ref: EXTERNAL_REF })
      const app = await buildApp()
      const res = await post(app, ADMIN).send(BODY)
      expect(res.status).toBe(200)
      expect(recordFloatTopUp).toHaveBeenCalled()
      await app.close()
    })

    it('accepts an operator-asserted ref when nothing is attached (CLI-parity path)', async () => {
      getDepositInstructions.mockResolvedValue(null)
      const app = await buildApp()
      const res = await post(app, ADMIN).send(BODY)
      expect(res.status).toBe(200)
      await app.close()
    })

    it('never tops up when the cleared assertion refuses', async () => {
      recordManualFunding.mockResolvedValue({
        done: false,
        reason: 'amount_mismatch',
        expectedMinor: 5200,
      })
      const app = await buildApp()
      const res = await post(app, ADMIN).send(BODY)
      expect(res.status).toBe(409)
      expect(res.body.error.details[0].issue).toContain('5200')
      expect(recordFloatTopUp).not.toHaveBeenCalled()
      await app.close()
    })

    it('404s transfer_not_found without touching the ledger', async () => {
      recordManualFunding.mockResolvedValue({ done: false, reason: 'transfer_not_found' })
      const app = await buildApp()
      const res = await post(app, ADMIN).send(BODY)
      expect(res.status).toBe(404)
      expect(recordFloatTopUp).not.toHaveBeenCalled()
      await app.close()
    })

    it('409s processor_not_manual naming the configured provider', async () => {
      recordManualFunding.mockResolvedValue({
        done: false,
        reason: 'processor_not_manual',
        provider: 'stripe',
      })
      const app = await buildApp()
      const res = await post(app, ADMIN).send(BODY)
      expect(res.status).toBe(409)
      expect(res.body.error.message).toContain('stripe')
      await app.close()
    })

    it('500s (generic envelope) when the top-up throws AFTER cleared — the re-tap path', async () => {
      recordFloatTopUp.mockRejectedValue(new Error('ledger down'))
      const app = await buildApp()
      const res = await post(app, ADMIN).send(BODY)
      expect(res.status).toBe(500)
      expect(res.body.error.message).not.toContain('ledger down')
      await app.close()
    })
  })
})

describe('POST /v1/ops/treasury/float-topup', () => {
  const PATH = '/v1/ops/treasury/float-topup'
  const BODY = { amountMinor: 10_000, currency: 'USD' as const }
  const post = (app: Awaited<ReturnType<typeof buildApp>>, token: string, key = 'topup-key-1') =>
    supertest(app.server).post(PATH).set('Authorization', `Bearer ${token}`).set('Idempotency-Key', key)

  beforeEach(() => {
    envMock.OPS_WRITE_ENABLED = true
  })

  describe('gate', () => {
    it('is not registered at all when OPS_WRITE_ENABLED is false (router 404)', async () => {
      envMock.OPS_WRITE_ENABLED = false
      const app = await buildApp()
      const res = await post(app, ADMIN).send(BODY)
      expect(res.status).toBe(404)
      expect(recordFloatTopUp).not.toHaveBeenCalled()
      await app.close()
    })

    it('401s an unauthenticated request', async () => {
      const app = await buildApp()
      const res = await supertest(app.server).post(PATH).send(BODY)
      expect(res.status).toBe(401)
      await app.close()
    })

    it('404s a non-admin with a body identical to a genuinely missing route', async () => {
      const app = await buildApp()
      const gated = await post(app, NON_ADMIN).send(BODY)
      const missing = await supertest(app.server)
        .post('/v1/ops/nonexistent')
        .set('Authorization', `Bearer ${NON_ADMIN}`)
        .send(BODY)
      expect(gated.status).toBe(404)
      expect(gated.body.error.code).toBe(missing.body.error.code)
      expect(gated.body.error.message).toBe(missing.body.error.message)
      expect(Object.keys(gated.body.error).sort()).toEqual(Object.keys(missing.body.error).sort())
      expect(recordFloatTopUp).not.toHaveBeenCalled()
      await app.close()
    })

    it('404s a non-admin BEFORE validation and the idempotency plugin — a missing key or garbage body must not leak a 400', async () => {
      const app = await buildApp()
      const res = await supertest(app.server)
        .post(PATH)
        .set('Authorization', `Bearer ${NON_ADMIN}`)
        .send({ nonsense: true })
      expect(res.status).toBe(404)
      expect(from).not.toHaveBeenCalled()
      await app.close()
    })

    it('404s even an admin when the write flag drops after registration', async () => {
      const app = await buildApp()
      envMock.OPS_WRITE_ENABLED = false
      const res = await post(app, ADMIN).send(BODY)
      expect(res.status).toBe(404)
      await app.close()
    })
  })

  describe('validation', () => {
    it('400s without an Idempotency-Key header (money-moving POST)', async () => {
      const app = await buildApp()
      const res = await supertest(app.server)
        .post(PATH)
        .set('Authorization', `Bearer ${ADMIN}`)
        .send(BODY)
      expect(res.status).toBe(400)
      expect(res.body.error.code).toBe('validation_error')
      expect(recordFloatTopUp).not.toHaveBeenCalled()
      await app.close()
    })

    it('400s a missing amountMinor', async () => {
      const app = await buildApp()
      const res = await post(app, ADMIN).send({ currency: 'USD' })
      expect(res.status).toBe(400)
      await app.close()
    })

    it('400s a zero or negative amount', async () => {
      const app = await buildApp()
      const res = await post(app, ADMIN).send({ ...BODY, amountMinor: 0 })
      expect(res.status).toBe(400)
      await app.close()
    })

    it('400s a non-USD currency — the float ledger is USD-only', async () => {
      const app = await buildApp()
      const res = await post(app, ADMIN).send({ ...BODY, currency: 'MXN' })
      expect(res.status).toBe(400)
      await app.close()
    })

    it('strips an unknown field so it can never reach the service', async () => {
      const app = await buildApp()
      const res = await post(app, ADMIN).send({ ...BODY, transferId: 'not-a-thing' })
      expect(res.status).toBe(200)
      expect(recordFloatTopUp).toHaveBeenCalledWith({
        amountMinor: 10_000,
        externalRef: 'adhoc:topup-key-1',
      })
      await app.close()
    })
  })

  describe('outcome mapping', () => {
    it('books with the stated ref (trimmed) and echoes the after-balance', async () => {
      const app = await buildApp()
      const res = await post(app, ADMIN).send({ ...BODY, externalRef: '  bridge-tx-9  ' })
      expect(res.status).toBe(200)
      expect(res.body).toEqual({
        amountMinor: 10_000,
        externalRef: 'bridge-tx-9',
        floatBalanceMinor: 22_000,
      })
      expect(recordFloatTopUp).toHaveBeenCalledWith({
        amountMinor: 10_000,
        externalRef: 'bridge-tx-9',
      })
      expect(getAccountBalance).toHaveBeenCalledWith('bridge_wallet_float')
      await app.close()
    })

    it('derives adhoc:<Idempotency-Key> when the ref is absent — HTTP and ledger layers agree on identity', async () => {
      const app = await buildApp()
      const res = await post(app, ADMIN, 'phone-tap-42').send(BODY)
      expect(res.status).toBe(200)
      expect(res.body.externalRef).toBe('adhoc:phone-tap-42')
      expect(recordFloatTopUp).toHaveBeenCalledWith({
        amountMinor: 10_000,
        externalRef: 'adhoc:phone-tap-42',
      })
      await app.close()
    })

    it('treats a whitespace-only ref as absent', async () => {
      const app = await buildApp()
      const res = await post(app, ADMIN).send({ ...BODY, externalRef: '   ' })
      expect(res.status).toBe(200)
      expect(res.body.externalRef).toBe('adhoc:topup-key-1')
      await app.close()
    })

    it('400s a PayoutValidationError with its message (field-and-amount text only)', async () => {
      recordFloatTopUp.mockRejectedValue(new MockPayoutValidationError('amountMinor must be a positive integer, got 1e99'))
      const app = await buildApp()
      const res = await post(app, ADMIN).send(BODY)
      expect(res.status).toBe(400)
      expect(res.body.error.code).toBe('validation_error')
      expect(res.body.error.message).toContain('amountMinor')
      await app.close()
    })

    it('500s a thrown service error without leaking the message', async () => {
      recordFloatTopUp.mockRejectedValue(new Error('pg down'))
      const app = await buildApp()
      const res = await post(app, ADMIN).send(BODY)
      expect(res.status).toBe(500)
      expect(res.body.error.message).not.toContain('pg down')
      await app.close()
    })
  })
})
