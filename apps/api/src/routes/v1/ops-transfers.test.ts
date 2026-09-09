import { describe, it, expect, beforeEach, vi } from 'vitest'
import supertest from 'supertest'
import Fastify from 'fastify'
import fp from 'fastify-plugin'

// The detail route's whole job is the GATE and the OUTPUT ALLOWLIST: allowlist
// first (before params validation — a malformed id must 404 for a non-admin,
// never 400), 404-never-403 with a body byte-identical to the router's own
// not-found, every field enumerated on the wire, fail-closed 500s. The read
// itself is pinned in services/ops-transfer-detail.test.ts, so it is mocked.
//
// The two writes (O-B) add: the same gate quintet, the Idempotency-Key
// contract (real plugin), input validation as policy (the hold-reason enum
// excludes sender_kyc_pending; the note is bounded), the refund's STEP ORDER
// (interlock → claim → refund → ledger proof → provenance, each refusal
// stopping the chain before any write), outcome→HTTP mapping with refusals as
// non-2xx, and provenance recorded on 2xx ONLY. The services themselves are
// pinned in payout-holds.test.ts / refunds.test.ts and mocked here.

const envMock = vi.hoisted(() => ({
  OPS_ADMIN_USER_IDS: new Set<string>(),
  OPS_WRITE_ENABLED: false,
}))
vi.mock('../../config/env.js', () => ({ env: envMock }))

const buildOpsTransferDetail = vi.hoisted(() => vi.fn())
vi.mock('../../services/ops-transfer-detail.js', () => ({
  buildOpsTransferDetail: (...args: unknown[]) => buildOpsTransferDetail(...args),
}))

const releaseHold = vi.hoisted(() => vi.fn())
vi.mock('../../services/payout-holds.js', () => ({
  // Mirrors the real const (pinned in payout-holds.test.ts) so the route's
  // schema enum is built the same way it is in production.
  RELEASABLE_HOLD_REASONS: ['fx_drift', 'payability', 'velocity_review', 'submit_error'],
  releaseHold: (...args: unknown[]) => releaseHold(...args),
}))

const verifyPrincipalReturned = vi.hoisted(() => vi.fn())
const refundClaimStatus = vi.hoisted(() => vi.fn())
const refundPayoutFailure = vi.hoisted(() => vi.fn())
const refundLedgerBatches = vi.hoisted(() => vi.fn())
vi.mock('../../services/refunds.js', () => ({
  verifyPrincipalReturned: (...args: unknown[]) => verifyPrincipalReturned(...args),
  refundClaimStatus: (...args: unknown[]) => refundClaimStatus(...args),
  refundPayoutFailure: (...args: unknown[]) => refundPayoutFailure(...args),
  refundLedgerBatches: (...args: unknown[]) => refundLedgerBatches(...args),
}))

const recordOpsAction = vi.hoisted(() => vi.fn())
vi.mock('../../services/ops-actions.js', () => ({
  recordOpsAction: (...args: unknown[]) => recordOpsAction(...args),
}))

const captureMessage = vi.hoisted(() => vi.fn())
const setFingerprint = vi.hoisted(() => vi.fn())
vi.mock('@sentry/node', () => ({
  withScope: (fn: (scope: unknown) => void) => fn({ setFingerprint, setContext: vi.fn() }),
  captureMessage: (...args: unknown[]) => captureMessage(...args),
}))

// supabaseAdmin backs only the idempotency plugin here — claims always win.
const from = vi.hoisted(() => vi.fn())
vi.mock('../../services/supabase.js', () => ({
  supabaseAdmin: { from: (...args: unknown[]) => from(...args) },
}))

const { opsTransfersRoute } = await import('./ops-transfers.js')
const { errorHandlerPlugin } = await import('../../plugins/error-handler.js')
const { idempotencyPlugin } = await import('../../plugins/idempotency.js')
// Real, not mocked: the refund route branches on the error CLASS the Bridge
// client throws, so the test must throw the genuine one.
const { BridgeApiError } = await import('../../services/bridge.js')

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
const TRANSFER = 'cccccccc-1111-4222-8333-444444444444'
const NOTE = 'Spoke with the sender; both sends today are legitimate.'

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
  // The REAL idempotency plugin (claims always win via the supabase mock) so
  // the required-header contract is exercised, not asserted by config probing.
  await app.register(idempotencyPlugin)
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
  // Slice 2: the transfer's ops history — note and derived changes ride here.
  activity: [
    {
      id: 'act-1',
      createdAt: '2026-09-08T11:30:00.000Z',
      actor: `ops:${ADMIN}`,
      action: 'hold_release',
      transferId: TRANSFER,
      reason: 'velocity_review',
      note: 'Verified the sender by phone.',
      changes: [
        { key: 'payoutHoldReason', before: 'velocity_review', after: null },
        { key: 'payoutHeldAt', before: '2026-09-08T11:00:00.000Z', after: null },
      ],
      requestId: 'req-9',
    },
  ],
}

// Strip the per-request id so two 404 bodies can be compared for shape.
const withoutRequestId = (body: { error: Record<string, unknown> }) => ({
  ...body,
  error: { ...body.error, requestId: undefined },
})

const BOTH_KEYS = [
  { transition: 'PAYOUT_FAILED', idempotency_key: `${TRANSFER}:bridge_return` },
  { transition: 'REFUNDED', idempotency_key: `${TRANSFER}:REFUNDED` },
]

beforeEach(() => {
  envMock.OPS_ADMIN_USER_IDS = new Set([ADMIN])
  envMock.OPS_WRITE_ENABLED = false
  buildOpsTransferDetail.mockReset().mockResolvedValue(DETAIL)
  releaseHold.mockReset().mockResolvedValue({ done: true, outcome: 'released', enqueued: true })
  verifyPrincipalReturned
    .mockReset()
    .mockResolvedValue({ returned: true, bridgeState: 'refunded', eventType: 'transfer.returned' })
  refundClaimStatus.mockReset().mockResolvedValue({ claimStatus: 'unclaimed', claimedAt: null, claimedBy: null })
  refundPayoutFailure.mockReset().mockResolvedValue({ done: true, outcome: 'refunded' })
  refundLedgerBatches.mockReset().mockResolvedValue(BOTH_KEYS)
  recordOpsAction.mockReset().mockResolvedValue(true)
  captureMessage.mockReset()
  setFingerprint.mockReset()
  from.mockReset().mockImplementation(() => chain({ data: { id: 'claim-1' } }))
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
      // Slice 2: a raw before/after object leaking past the service must not
      // reach the wire; only the derived string changes may.
      activity: [
        {
          ...DETAIL.activity[0],
          before: { payoutHoldReason: 'velocity_review', rawRow: 'SENSITIVE' },
          after: {},
          changes: [{ ...DETAIL.activity[0]!.changes[0]!, rawValue: { secret: true } }, DETAIL.activity[0]!.changes[1]!],
        },
      ],
    })
    const app = await buildApp()
    const res = await supertest(app.server)
      .get(`/v1/ops/transfers/${TRANSFER}`)
      .set('Authorization', `Bearer ${ADMIN}`)

    expect(res.status).toBe(200)
    const text = JSON.stringify(res.body)
    for (const forbidden of ['userId', 'bankAccountNumber', 'clabeLast4', 'recipientName', 'metadata', 'payload', '"error"', 'rawRow', 'rawValue']) {
      expect(text).not.toContain(forbidden)
    }
    expect(res.body.paymentEvents[0]).toEqual(DETAIL.paymentEvents[0])
    expect(res.body.activity).toEqual(DETAIL.activity)
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

// ---------------------------------------------------------------------------
// The write surface (O-B). Shared gate quintet, then per-route contracts.
// ---------------------------------------------------------------------------

function writeGateQuintet(path: string, body: Record<string, unknown>, serviceSpies: Array<ReturnType<typeof vi.fn>>) {
  const post = (app: Awaited<ReturnType<typeof buildApp>>, token: string) =>
    supertest(app.server).post(path).set('Authorization', `Bearer ${token}`).set('Idempotency-Key', 'k-1')

  describe('gate', () => {
    it('is not registered at all when OPS_WRITE_ENABLED is false (router 404) — the read stays up', async () => {
      envMock.OPS_WRITE_ENABLED = false
      const app = await buildApp()
      const res = await post(app, ADMIN).send(body)
      expect(res.status).toBe(404)
      expect(res.body.error.code).toBe('not_found')
      const read = await supertest(app.server)
        .get(`/v1/ops/transfers/${TRANSFER}`)
        .set('Authorization', `Bearer ${ADMIN}`)
      expect(read.status).toBe(200)
      for (const spy of serviceSpies) expect(spy).not.toHaveBeenCalled()
    })

    it('401s an unauthenticated request', async () => {
      const app = await buildApp()
      const res = await supertest(app.server).post(path).set('Idempotency-Key', 'k-1').send(body)
      expect(res.status).toBe(401)
    })

    it('404s a non-admin with a body byte-identical to the router not-found', async () => {
      const app = await buildApp()
      const gated = await post(app, NON_ADMIN).send(body)
      const missing = await supertest(app.server)
        .post('/v1/ops/nonexistent')
        .set('Authorization', `Bearer ${NON_ADMIN}`)
        .send({})
      expect(gated.status).toBe(404)
      expect(missing.status).toBe(404)
      expect(withoutRequestId(gated.body)).toEqual(withoutRequestId(missing.body))
      for (const spy of serviceSpies) expect(spy).not.toHaveBeenCalled()
    })

    it('404s a non-admin BEFORE validation and the idempotency plugin — no key + garbage body must not leak a 400', async () => {
      const app = await buildApp()
      const res = await supertest(app.server)
        .post(path)
        .set('Authorization', `Bearer ${NON_ADMIN}`)
        .send({ nonsense: true })
      expect(res.status).toBe(404)
      expect(res.body.error.code).toBe('not_found')
      // The idempotency plugin never reached the database either.
      expect(from).not.toHaveBeenCalled()
      for (const spy of serviceSpies) expect(spy).not.toHaveBeenCalled()
    })

    it('404s even an admin when the allowlist drops them after registration (handler re-check)', async () => {
      const app = await buildApp()
      envMock.OPS_ADMIN_USER_IDS = new Set()
      const res = await post(app, ADMIN).send(body)
      expect(res.status).toBe(404)
      for (const spy of serviceSpies) expect(spy).not.toHaveBeenCalled()
    })
  })

  return post
}

describe('POST /v1/ops/transfers/hold-release', () => {
  const PATH = '/v1/ops/transfers/hold-release'
  const BODY = { transferId: TRANSFER, reason: 'velocity_review', note: NOTE }

  beforeEach(() => {
    envMock.OPS_WRITE_ENABLED = true
  })

  const post = writeGateQuintet(PATH, BODY, [releaseHold, recordOpsAction])

  describe('validation — the schema is the policy', () => {
    it('400s without an Idempotency-Key header', async () => {
      const app = await buildApp()
      const res = await supertest(app.server).post(PATH).set('Authorization', `Bearer ${ADMIN}`).send(BODY)
      expect(res.status).toBe(400)
      expect(releaseHold).not.toHaveBeenCalled()
    })

    it('400s sender_kyc_pending — the auto-released hold has no button', async () => {
      const app = await buildApp()
      const res = await post(app, ADMIN).send({ ...BODY, reason: 'sender_kyc_pending' })
      expect(res.status).toBe(400)
      expect(res.body.error.code).toBe('validation_error')
      expect(releaseHold).not.toHaveBeenCalled()
    })

    it.each([
      ['a note under 10 chars', { note: 'too short' }],
      ['a note over 500 chars', { note: 'x'.repeat(501) }],
      ['a missing note', { note: undefined }],
      ['a non-uuid transferId', { transferId: 'not-a-uuid' }],
      ['a missing reason', { reason: undefined }],
    ])('400s %s', async (_label, overrides) => {
      const app = await buildApp()
      const res = await post(app, ADMIN).send({ ...BODY, ...overrides })
      expect(res.status).toBe(400)
      expect(releaseHold).not.toHaveBeenCalled()
    })

    it('strips an unknown field so it can never reach the service', async () => {
      const app = await buildApp()
      const res = await post(app, ADMIN).send({ ...BODY, reclaim: true, actor: 'ops:someone-else' })
      expect(res.status).toBe(200)
      // Actor comes from the JWT, never the body.
      expect(releaseHold).toHaveBeenCalledWith(expect.objectContaining({ actor: `ops:${ADMIN}` }), expect.anything())
    })
  })

  describe('outcome mapping', () => {
    it('200s a release, attributing the authenticated admin, trimming the note, passing the request id', async () => {
      const app = await buildApp()
      const res = await post(app, ADMIN).send({ ...BODY, note: `  ${NOTE}  ` })
      expect(res.status).toBe(200)
      expect(res.body).toEqual({ transferId: TRANSFER, outcome: 'released', enqueued: true })
      expect(releaseHold).toHaveBeenCalledWith(
        {
          transferId: TRANSFER,
          reason: 'velocity_review',
          actor: `ops:${ADMIN}`,
          note: NOTE,
          requestId: expect.any(String),
        },
        expect.anything(),
      )
      // The provenance row is the service's job on this route (it knows the
      // `before`); the route does not double-record.
      expect(recordOpsAction).not.toHaveBeenCalled()
    })

    it('passes enqueued:false through — the operator learns the sweep will pick it up', async () => {
      releaseHold.mockResolvedValue({ done: true, outcome: 'released', enqueued: false })
      const app = await buildApp()
      const res = await post(app, ADMIN).send(BODY)
      expect(res.status).toBe(200)
      expect(res.body.enqueued).toBe(false)
    })

    it('404s transfer_not_found with a plain not_found (post-gate: an admin may learn this)', async () => {
      releaseHold.mockResolvedValue({ done: false, reason: 'transfer_not_found' })
      const app = await buildApp()
      const res = await post(app, ADMIN).send(BODY)
      expect(res.status).toBe(404)
      expect(res.body.error).toMatchObject({ code: 'not_found', message: 'Transfer not found' })
    })

    it.each([
      [{ done: false, reason: 'not_funded', state: 'SUBMITTED' }, { path: 'transferId', issue: 'state is SUBMITTED' }],
      [{ done: false, reason: 'not_held' }, { path: 'transferId', issue: 'no hold on this transfer' }],
      [{ done: false, reason: 'hold_reason_mismatch', actual: 'submit_error' }, { path: 'reason', issue: 'hold is submit_error' }],
    ])('409 conflict for %o with the detail the operator needs', async (outcome, detail) => {
      releaseHold.mockResolvedValue(outcome)
      const app = await buildApp()
      const res = await post(app, ADMIN).send(BODY)
      expect(res.status).toBe(409)
      expect(res.body.error.code).toBe('conflict')
      expect(res.body.error.details).toEqual([detail])
    })

    it('500s (fail closed, message off the wire) when the service throws', async () => {
      releaseHold.mockRejectedValue(new Error('hold release update failed: pii-free message'))
      const app = await buildApp()
      const res = await post(app, ADMIN).send(BODY)
      expect(res.status).toBe(500)
      expect(res.body.error).toEqual({ code: 'internal_error', message: 'Something went wrong', requestId: expect.any(String) })
    })

    it('strips unknown fields through the response schema (the output allowlist)', async () => {
      releaseHold.mockResolvedValue({ done: true, outcome: 'released', enqueued: true, userId: 'u-1', row: { user_id: 'u-1' } })
      const app = await buildApp()
      const res = await post(app, ADMIN).send(BODY)
      expect(res.status).toBe(200)
      expect(res.body).toEqual({ transferId: TRANSFER, outcome: 'released', enqueued: true })
    })
  })
})

describe('POST /v1/ops/transfers/refund', () => {
  const PATH = '/v1/ops/transfers/refund'
  const BODY = { transferId: TRANSFER, note: NOTE }
  const REASON = 'ops board refund — AUTO_REFUND off'

  beforeEach(() => {
    envMock.OPS_WRITE_ENABLED = true
  })

  const post = writeGateQuintet(PATH, BODY, [
    verifyPrincipalReturned,
    refundClaimStatus,
    refundPayoutFailure,
    refundLedgerBatches,
    recordOpsAction,
  ])

  describe('validation', () => {
    it('400s without an Idempotency-Key header (money-moving POST)', async () => {
      const app = await buildApp()
      const res = await supertest(app.server).post(PATH).set('Authorization', `Bearer ${ADMIN}`).send(BODY)
      expect(res.status).toBe(400)
      expect(verifyPrincipalReturned).not.toHaveBeenCalled()
    })

    it.each([
      ['a note under 10 chars', { note: 'too short' }],
      ['a note over 500 chars', { note: 'x'.repeat(501) }],
      ['a missing transferId', { transferId: undefined }],
      ['a non-uuid transferId', { transferId: 'not-a-uuid' }],
    ])('400s %s before the Bridge call', async (_label, overrides) => {
      const app = await buildApp()
      const res = await post(app, ADMIN).send({ ...BODY, ...overrides })
      expect(res.status).toBe(400)
      expect(verifyPrincipalReturned).not.toHaveBeenCalled()
    })

    it('strips a reclaim flag — there is no --reclaim on the board, ever', async () => {
      const app = await buildApp()
      const res = await post(app, ADMIN).send({ ...BODY, reclaim: true })
      expect(res.status).toBe(200)
      expect(refundPayoutFailure).toHaveBeenCalledTimes(1)
    })
  })

  describe('step order — every refusal stops the chain before any write', () => {
    it('(1) interlock: no_return_event → 409 principal_not_returned; nothing further runs', async () => {
      verifyPrincipalReturned.mockResolvedValue({ returned: false, reason: 'no_return_event', bridgeState: 'payment_processed' })
      const app = await buildApp()
      const res = await post(app, ADMIN).send(BODY)
      expect(res.status).toBe(409)
      expect(res.body.error.code).toBe('principal_not_returned')
      expect(res.body.error.message).not.toMatch(/refund_failed/)
      expect(res.body.error.details).toEqual([
        { path: 'transferId', issue: 'no_return_event; bridge=payment_processed; event=none' },
      ])
      expect(verifyPrincipalReturned).toHaveBeenCalledWith(TRANSFER)
      expect(refundClaimStatus).not.toHaveBeenCalled()
      expect(refundPayoutFailure).not.toHaveBeenCalled()
      expect(recordOpsAction).not.toHaveBeenCalled()
    })

    it('(1) interlock: bridge_disagrees with refund_failed → the escalation message', async () => {
      verifyPrincipalReturned.mockResolvedValue({
        returned: false,
        reason: 'bridge_disagrees',
        bridgeState: 'refund_failed',
        eventType: 'transfer.returned',
      })
      const app = await buildApp()
      const res = await post(app, ADMIN).send(BODY)
      expect(res.status).toBe(409)
      expect(res.body.error.code).toBe('principal_not_returned')
      expect(res.body.error.message).toMatch(/refund_failed/)
      expect(res.body.error.message).toMatch(/manual-refund/)
      expect(res.body.error.details[0].issue).toBe('bridge_disagrees; bridge=refund_failed; event=transfer.returned')
      expect(refundPayoutFailure).not.toHaveBeenCalled()
    })

    it('(1) interlock: transfer_not_found → 404', async () => {
      verifyPrincipalReturned.mockResolvedValue({ returned: false, reason: 'transfer_not_found' })
      const app = await buildApp()
      const res = await post(app, ADMIN).send(BODY)
      expect(res.status).toBe(404)
      expect(res.body.error.code).toBe('not_found')
      expect(refundClaimStatus).not.toHaveBeenCalled()
    })

    it.each([
      ['undici transport failure', new TypeError('fetch failed')],
      ['the BRIDGE_TIMEOUT_SECONDS signal', Object.assign(new Error('The operation was aborted due to timeout'), { name: 'TimeoutError' })],
      ['a Bridge 503', new BridgeApiError(503, null)],
    ])('(1) interlock: Bridge unreachable (%s) → 502 provider_unavailable, nothing written, retry is the instruction', async (_label, err) => {
      verifyPrincipalReturned.mockRejectedValue(err)
      const app = await buildApp()
      const res = await post(app, ADMIN).send(BODY)
      expect(res.status).toBe(502)
      expect(res.body.error.code).toBe('provider_unavailable')
      expect(res.body.error.message).toMatch(/nothing was changed/i)
      expect(refundClaimStatus).not.toHaveBeenCalled()
      expect(refundPayoutFailure).not.toHaveBeenCalled()
      expect(recordOpsAction).not.toHaveBeenCalled()
    })

    it('(1) interlock: a Bridge 4xx is an answer, not an outage → 409 principal_not_returned with the status in details', async () => {
      verifyPrincipalReturned.mockRejectedValue(new BridgeApiError(404, { code: 'not_found' }))
      const app = await buildApp()
      const res = await post(app, ADMIN).send(BODY)
      expect(res.status).toBe(409)
      expect(res.body.error.code).toBe('principal_not_returned')
      expect(res.body.error.details).toEqual([
        { path: 'transferId', issue: 'bridge_lookup_failed; bridge=http_404; event=unknown' },
      ])
      expect(refundPayoutFailure).not.toHaveBeenCalled()
    })

    it('(1) interlock: a database failure inside the check is still a 500 — only Bridge transport maps to 502', async () => {
      verifyPrincipalReturned.mockRejectedValue(new Error('refund interlock transfer load failed: pii-free'))
      const app = await buildApp()
      const res = await post(app, ADMIN).send(BODY)
      expect(res.status).toBe(500)
      expect(res.body.error.code).toBe('internal_error')
      expect(refundClaimStatus).not.toHaveBeenCalled()
    })

    it('(1) interlock: not_submitted PASSES (#254) and the ledger proof expects only the REFUNDED batch', async () => {
      verifyPrincipalReturned.mockResolvedValue({ returned: false, reason: 'not_submitted' })
      refundLedgerBatches.mockResolvedValue([{ transition: 'REFUNDED', idempotency_key: `${TRANSFER}:REFUNDED` }])
      const app = await buildApp()
      const res = await post(app, ADMIN).send(BODY)
      expect(res.status).toBe(200)
      expect(res.body).toEqual({
        transferId: TRANSFER,
        outcome: 'refunded',
        ledgerComplete: true,
        ledgerKeys: [`${TRANSFER}:REFUNDED`],
      })
      expect(captureMessage).not.toHaveBeenCalled()
      expect(recordOpsAction).toHaveBeenCalledWith(
        expect.objectContaining({ action: 'refund', before: expect.objectContaining({ preSubmit: true }) }),
        expect.anything(),
      )
    })

    it('(2) claim: unknown transfer at the claim read → 404', async () => {
      refundClaimStatus.mockResolvedValue(null)
      const app = await buildApp()
      const res = await post(app, ADMIN).send(BODY)
      expect(res.status).toBe(404)
      expect(refundPayoutFailure).not.toHaveBeenCalled()
    })

    it('(2) claim: abandoned → 409 claim_abandoned BEFORE any write — the STOP state', async () => {
      refundClaimStatus.mockResolvedValue({
        claimStatus: 'abandoned',
        claimedAt: '2026-09-08T10:00:00.000Z',
        claimedBy: 'ops:someone',
      })
      const app = await buildApp()
      const res = await post(app, ADMIN).send(BODY)
      expect(res.status).toBe(409)
      expect(res.body.error.code).toBe('claim_abandoned')
      expect(refundPayoutFailure).not.toHaveBeenCalled()
      expect(recordOpsAction).not.toHaveBeenCalled()
    })

    it('(3) refund: the service gets the FULL actor string and the system reason — never the note', async () => {
      const app = await buildApp()
      await post(app, ADMIN).send(BODY)
      expect(refundPayoutFailure).toHaveBeenCalledWith({ transferId: TRANSFER, actor: `ops:${ADMIN}`, reason: REASON })
      expect(JSON.stringify(refundPayoutFailure.mock.calls)).not.toContain(NOTE)
    })

    it.each([
      [{ done: false, reason: 'not_payout_failed', state: 'COMPLETED' }, 409, 'conflict', 'state is COMPLETED'],
      [
        { done: false, reason: 'claim_taken', claimedAt: '2026-09-08T10:00:00.000Z', claimedBy: 'worker:refund' },
        409,
        'conflict',
        'refund in progress since 2026-09-08T10:00:00.000Z by worker:refund',
      ],
    ])('(3) refund refusal %o → %i %s', async (outcome, status, code, issue) => {
      refundPayoutFailure.mockResolvedValue(outcome)
      const app = await buildApp()
      const res = await post(app, ADMIN).send(BODY)
      expect(res.status).toBe(status)
      expect(res.body.error.code).toBe(code)
      expect(res.body.error.details).toEqual([{ path: 'transferId', issue }])
      expect(refundLedgerBatches).not.toHaveBeenCalled()
      expect(recordOpsAction).not.toHaveBeenCalled()
    })

    it('(3) refund refusal claim_abandoned (raced in) → its own code, no provenance', async () => {
      refundPayoutFailure.mockResolvedValue({ done: false, reason: 'claim_abandoned', claimedAt: null, claimedBy: null })
      const app = await buildApp()
      const res = await post(app, ADMIN).send(BODY)
      expect(res.status).toBe(409)
      expect(res.body.error.code).toBe('claim_abandoned')
      expect(recordOpsAction).not.toHaveBeenCalled()
    })

    it('(3) refund refusal transfer_not_found → 404', async () => {
      refundPayoutFailure.mockResolvedValue({ done: false, reason: 'transfer_not_found' })
      const app = await buildApp()
      const res = await post(app, ADMIN).send(BODY)
      expect(res.status).toBe(404)
    })
  })

  describe('success', () => {
    it('200s with both ledger keys and records provenance with the outcome as the reason', async () => {
      const app = await buildApp()
      const res = await post(app, ADMIN).send({ ...BODY, note: `  ${NOTE}  ` })
      expect(res.status).toBe(200)
      expect(res.body).toEqual({
        transferId: TRANSFER,
        outcome: 'refunded',
        ledgerComplete: true,
        ledgerKeys: [`${TRANSFER}:bridge_return`, `${TRANSFER}:REFUNDED`],
      })
      expect(refundLedgerBatches).toHaveBeenCalledWith(TRANSFER)
      expect(recordOpsAction).toHaveBeenCalledTimes(1)
      expect(recordOpsAction).toHaveBeenCalledWith(
        {
          actor: `ops:${ADMIN}`,
          action: 'refund',
          transferId: TRANSFER,
          reason: 'refunded',
          note: NOTE,
          before: { state: 'PAYOUT_FAILED', claimStatus: 'unclaimed', preSubmit: false },
          after: { state: 'REFUNDED', outcome: 'refunded', ledgerComplete: true },
          requestId: expect.any(String),
        },
        expect.anything(),
      )
      expect(captureMessage).not.toHaveBeenCalled()
    })

    it.each(['already_disbursed', 'already_settled'] as const)(
      '200s the crash-recovery outcome %s distinctly and still records the operator acted',
      async (outcome) => {
        refundPayoutFailure.mockResolvedValue({ done: true, outcome })
        const app = await buildApp()
        const res = await post(app, ADMIN).send(BODY)
        expect(res.status).toBe(200)
        expect(res.body.outcome).toBe(outcome)
        expect(recordOpsAction).toHaveBeenCalledWith(expect.objectContaining({ reason: outcome }), expect.anything())
      },
    )

    it('a missing expected batch → ledgerComplete:false, paged, but STILL 200 (money moved; a 500 invites a retry)', async () => {
      refundLedgerBatches.mockResolvedValue([{ transition: 'REFUNDED', idempotency_key: `${TRANSFER}:REFUNDED` }])
      const app = await buildApp()
      const res = await post(app, ADMIN).send(BODY)
      expect(res.status).toBe(200)
      expect(res.body.ledgerComplete).toBe(false)
      expect(res.body.ledgerKeys).toEqual([`${TRANSFER}:REFUNDED`])
      expect(setFingerprint).toHaveBeenCalledWith(['ops-refund-ledger-incomplete', TRANSFER])
      expect(captureMessage).toHaveBeenCalledWith('ops refund: expected ledger batch missing', 'error')
      expect(recordOpsAction).toHaveBeenCalledWith(
        expect.objectContaining({ after: expect.objectContaining({ ledgerComplete: false }) }),
        expect.anything(),
      )
    })

    it('a failed provenance write does not change the 200', async () => {
      recordOpsAction.mockResolvedValue(false)
      const app = await buildApp()
      const res = await post(app, ADMIN).send(BODY)
      expect(res.status).toBe(200)
    })

    it('500s (fail closed, message off the wire) when the refund service throws', async () => {
      refundPayoutFailure.mockRejectedValue(new Error('processor refund failed: pii-free message'))
      const app = await buildApp()
      const res = await post(app, ADMIN).send(BODY)
      expect(res.status).toBe(500)
      expect(res.body.error).toEqual({ code: 'internal_error', message: 'Something went wrong', requestId: expect.any(String) })
      expect(recordOpsAction).not.toHaveBeenCalled()
    })

    it('strips unknown fields through the response schema (the output allowlist)', async () => {
      refundPayoutFailure.mockResolvedValue({ done: true, outcome: 'refunded', row: { user_id: 'u-1' }, userId: 'u-1' })
      const app = await buildApp()
      const res = await post(app, ADMIN).send(BODY)
      expect(res.status).toBe(200)
      expect(Object.keys(res.body).sort()).toEqual(['ledgerComplete', 'ledgerKeys', 'outcome', 'transferId'])
    })
  })
})
