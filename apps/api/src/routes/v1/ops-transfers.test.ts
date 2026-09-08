import { describe, it, expect, beforeEach, vi } from 'vitest'
import supertest from 'supertest'
import Fastify from 'fastify'
import fp from 'fastify-plugin'

// The detail route's whole job is the GATE and the OUTPUT ALLOWLIST: allowlist
// first (before params validation — a malformed id must 404 for a non-admin,
// never 400), 404-never-403 with a body byte-identical to the router's own
// not-found, every field enumerated on the wire, fail-closed 500s. The read
// itself is pinned in services/ops-transfer-detail.test.ts, so it is mocked.

const envMock = vi.hoisted(() => ({
  OPS_ADMIN_USER_IDS: new Set<string>(),
  OPS_WRITE_ENABLED: false,
}))
vi.mock('../../config/env.js', () => ({ env: envMock }))

const buildOpsTransferDetail = vi.hoisted(() => vi.fn())
vi.mock('../../services/ops-transfer-detail.js', () => ({
  buildOpsTransferDetail: (...args: unknown[]) => buildOpsTransferDetail(...args),
}))

const { opsTransfersRoute } = await import('./ops-transfers.js')
const { errorHandlerPlugin } = await import('../../plugins/error-handler.js')

const ADMIN = 'aaaaaaaa-1111-4222-8333-444444444444'
const NON_ADMIN = 'bbbbbbbb-1111-4222-8333-444444444444'
const TRANSFER = 'cccccccc-1111-4222-8333-444444444444'

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
  // The REAL production error handler: the indistinguishability assertion
  // below must break if plugins/error-handler ever changes its not-found shape.
  await app.register(errorHandlerPlugin)
  await app.register(mockAuth)
  await app.register(opsTransfersRoute, { prefix: '/v1' })
  await app.ready()
  return app
}

const DETAIL = {
  generatedAt: '2026-09-08T12:00:00.000Z',
  transfer: {
    transferId: TRANSFER,
    state: 'FUNDED',
    sendAmountMinor: 30_000,
    sendCurrency: 'USD',
    receiveAmountMinor: 540_000,
    receiveCurrency: 'MXN',
    feeAmountMinor: 500,
    marginMinor: 0,
    fxRate: 18.0,
    fundingSourceType: 'ach',
    fundingProcessor: 'stripe_crypto',
    fundingCleared: false,
    fundingPaymentRef: 'cos_1',
    providerTransferRef: null,
    refundPaymentRef: null,
    payoutHoldReason: 'velocity_review',
    payoutHeldAt: '2026-09-08T11:00:00.000Z',
    submitAttemptedAt: null,
    cancellationRequestedAt: null,
    paymentClaimedAt: null,
    disclosureAcceptedAt: '2026-09-08T10:00:00.000Z',
    paymentAt: '2026-09-08T10:30:00.000Z',
    cancelableUntil: '2026-09-08T11:00:00.000Z',
    completedAt: null,
    refundedAt: null,
    createdAt: '2026-09-08T09:55:00.000Z',
    dwell: {
      enteredStateAt: '2026-09-08T10:30:00.000Z',
      dwellMinutes: 90,
      thresholdMinutes: 15,
      overThreshold: true,
    },
  },
  quote: {
    fxRate: 18.0,
    sourceRate: 18.2,
    marginMinor: 0,
    fxRateAt: '2026-09-08T09:54:00.000Z',
    expiresAt: '2026-09-08T10:24:00.000Z',
    createdAt: '2026-09-08T09:54:00.000Z',
    status: 'accepted',
  },
  destination: { status: 'active', hasProviderAccountRef: true, recipientStatus: 'active' },
  refund: {
    claimStatus: 'unclaimed',
    claimedAt: null,
    claimedBy: null,
    returnEventType: null,
    ledgerKeys: { bridgeReturn: false, refunded: false },
  },
  transitions: [
    {
      fromState: 'PENDING_PAYMENT',
      toState: 'FUNDED',
      actor: 'webhook:funding',
      reason: null,
      createdAt: '2026-09-08T10:30:00.000Z',
    },
  ],
  ledger: [
    {
      transition: 'FUNDED',
      idempotencyKey: `${TRANSFER}:FUNDED`,
      description: 'funded',
      postedAt: '2026-09-08T10:30:00.000Z',
      netMinor: 0,
      entries: [
        { accountCode: 'funding_receivable', direction: 'debit', amountMinor: 30_500, currency: 'USD' },
        { accountCode: 'transfer_payable', direction: 'credit', amountMinor: 30_000, currency: 'USD' },
        { accountCode: 'fee_revenue', direction: 'credit', amountMinor: 500, currency: 'USD' },
      ],
    },
  ],
  paymentEvents: [
    {
      id: 'ev-1',
      source: 'funding',
      eventType: 'funding_succeeded',
      status: 'processed',
      receivedAt: '2026-09-08T10:30:00.000Z',
      processedAt: '2026-09-08T10:30:01.000Z',
      providerRef: 'cos_1',
      hasError: false,
    },
  ],
  cancellationRequests: [],
  depositInstructions: null,
  disclosures: [{ type: 'prepayment', locale: 'en', presentedAt: '2026-09-08T09:56:00.000Z' }],
}

// Strip the per-request id so two 404 bodies can be compared for shape.
const withoutRequestId = (body: { error: Record<string, unknown> }) => ({
  ...body,
  error: { ...body.error, requestId: undefined },
})

beforeEach(() => {
  envMock.OPS_ADMIN_USER_IDS = new Set([ADMIN])
  envMock.OPS_WRITE_ENABLED = false
  buildOpsTransferDetail.mockReset().mockResolvedValue(DETAIL)
})

describe('GET /v1/ops/transfers/:id', () => {
  it('401s without a bearer token', async () => {
    const app = await buildApp()
    const res = await supertest(app.server).get(`/v1/ops/transfers/${TRANSFER}`)
    expect(res.status).toBe(401)
    expect(buildOpsTransferDetail).not.toHaveBeenCalled()
  })

  it('404s a non-admin with a body byte-identical to the router not-found', async () => {
    const app = await buildApp()
    const baseline = await supertest(app.server)
      .get('/v1/ops/nonexistent')
      .set('Authorization', `Bearer ${NON_ADMIN}`)
    const res = await supertest(app.server)
      .get(`/v1/ops/transfers/${TRANSFER}`)
      .set('Authorization', `Bearer ${NON_ADMIN}`)

    expect(baseline.status).toBe(404)
    expect(res.status).toBe(404)
    expect(withoutRequestId(res.body)).toEqual(withoutRequestId(baseline.body))
    expect(res.body.error.requestId).toEqual(expect.any(String))
    expect(buildOpsTransferDetail).not.toHaveBeenCalled()
  })

  // The route has a params schema; the gate must beat validation or a probing
  // non-admin learns the route exists from the 400.
  it('404s a non-admin BEFORE params validation — a malformed id never yields a 400', async () => {
    const app = await buildApp()
    const res = await supertest(app.server)
      .get('/v1/ops/transfers/not-a-uuid')
      .set('Authorization', `Bearer ${NON_ADMIN}`)
    expect(res.status).toBe(404)
    expect(res.body.error.code).toBe('not_found')
    expect(buildOpsTransferDetail).not.toHaveBeenCalled()
  })

  it('400s an admin on a malformed id without touching the service', async () => {
    const app = await buildApp()
    const res = await supertest(app.server)
      .get('/v1/ops/transfers/not-a-uuid')
      .set('Authorization', `Bearer ${ADMIN}`)
    expect(res.status).toBe(400)
    expect(res.body.error.code).toBe('validation_error')
    expect(buildOpsTransferDetail).not.toHaveBeenCalled()
  })

  it('404s an admin on an unknown transfer — honest, the gate has already passed', async () => {
    buildOpsTransferDetail.mockResolvedValue(null)
    const app = await buildApp()
    const res = await supertest(app.server)
      .get(`/v1/ops/transfers/${TRANSFER}`)
      .set('Authorization', `Bearer ${ADMIN}`)
    expect(res.status).toBe(404)
    expect(res.body.error).toMatchObject({ code: 'not_found', message: 'Transfer not found' })
    expect(buildOpsTransferDetail).toHaveBeenCalledWith(TRANSFER)
  })

  it('returns the detail with actionsEnabled reflecting the write gate', async () => {
    const app = await buildApp()
    const off = await supertest(app.server)
      .get(`/v1/ops/transfers/${TRANSFER}`)
      .set('Authorization', `Bearer ${ADMIN}`)
    expect(off.status).toBe(200)
    expect(off.body.transfer.transferId).toBe(TRANSFER)
    expect(off.body.transfer.payoutHoldReason).toBe('velocity_review')
    expect(off.body.refund.claimStatus).toBe('unclaimed')
    expect(off.body.ledger[0].netMinor).toBe(0)
    expect(off.body.actionsEnabled).toBe(false)

    envMock.OPS_WRITE_ENABLED = true
    const on = await supertest(app.server)
      .get(`/v1/ops/transfers/${TRANSFER}`)
      .set('Authorization', `Bearer ${ADMIN}`)
    expect(on.body.actionsEnabled).toBe(true)
  })

  it('strips unknown fields through the response schema — the wire is the allowlist', async () => {
    // A widened service read must not reach the operator's browser: names,
    // user ids, bank coordinates, raw payloads, transition metadata.
    buildOpsTransferDetail.mockResolvedValue({
      ...DETAIL,
      userId: 'u-1',
      transfer: { ...DETAIL.transfer, userId: 'u-1', bankAccountNumber: '000123456789' },
      destination: { ...DETAIL.destination, clabeLast4: '1234', recipientName: 'Jane' },
      transitions: [{ ...DETAIL.transitions[0], metadata: { secret: true } }],
      paymentEvents: [{ ...DETAIL.paymentEvents[0], payload: { raw: 'provider body' }, error: 'boom' }],
      depositInstructions: { bridgeTransferRef: 'x', currency: 'USD', amountMinor: 1, paymentRail: 'ach', depositMessage: 'm', attachedBy: null, bankAccountNumber: '1' },
    })
    const app = await buildApp()
    const res = await supertest(app.server)
      .get(`/v1/ops/transfers/${TRANSFER}`)
      .set('Authorization', `Bearer ${ADMIN}`)

    expect(res.status).toBe(200)
    const text = JSON.stringify(res.body)
    for (const forbidden of ['userId', 'bankAccountNumber', 'clabeLast4', 'recipientName', 'metadata', 'payload', '"error"']) {
      expect(text).not.toContain(forbidden)
    }
    expect(res.body.paymentEvents[0]).toEqual(DETAIL.paymentEvents[0])
  })

  it('500s with the generic envelope when the read throws, logging the message only', async () => {
    buildOpsTransferDetail.mockRejectedValue(new Error('ledger select failed: pii-free message'))
    const app = await buildApp()
    const res = await supertest(app.server)
      .get(`/v1/ops/transfers/${TRANSFER}`)
      .set('Authorization', `Bearer ${ADMIN}`)
    expect(res.status).toBe(500)
    expect(res.body.error).toMatchObject({ code: 'internal_error', message: 'Something went wrong' })
  })

  it('404s an admin when the allowlist drops them after registration', async () => {
    const app = await buildApp()
    envMock.OPS_ADMIN_USER_IDS = new Set()
    const res = await supertest(app.server)
      .get(`/v1/ops/transfers/${TRANSFER}`)
      .set('Authorization', `Bearer ${ADMIN}`)
    expect(res.status).toBe(404)
    expect(res.body.error.code).toBe('not_found')
    expect(buildOpsTransferDetail).not.toHaveBeenCalled()
  })
})
