import { describe, it, expect, beforeEach, vi } from 'vitest'
import { REQUIRED_CONSENTS } from '@puente/shared'
import supertest from 'supertest'
import Fastify from 'fastify'
import fp from 'fastify-plugin'

const from = vi.fn()

vi.mock('../../services/supabase.js', () => ({
  supabaseAdmin: {
    from: (...args: unknown[]) => from(...args),
  },
}))

const captureMessage = vi.hoisted(() => vi.fn())
const setFingerprint = vi.hoisted(() => vi.fn())
const captureException = vi.hoisted(() => vi.fn())
vi.mock('@sentry/node', () => ({
  withScope: (fn: (s: unknown) => void) => fn({ setFingerprint, setContext: vi.fn() }),
  captureMessage: (...a: unknown[]) => captureMessage(...a),
  captureException: (...a: unknown[]) => captureException(...a),
}))

// Slice 3: confirm hands onramp creation to the worker — mocked so the suite
// never touches pg-boss, and so the enqueue-failure posture can be pinned.
const enqueueFundingOnrampPrepare = vi.hoisted(() => vi.fn())
vi.mock('../../services/queue.js', () => ({
  enqueueFundingOnrampPrepare: (...a: unknown[]) => enqueueFundingOnrampPrepare(...a),
}))

const recordCancellationRequest = vi.fn()
vi.mock('../../services/cancellations.js', () => ({
  recordCancellationRequest: (...a: unknown[]) => recordCancellationRequest(...a),
}))

const createTransferFromQuote = vi.fn()
const cancelTransfer = vi.fn()
const transitionTransfer = vi.fn()

vi.mock('../../services/transfers.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../services/transfers.js')>()
  return {
    ...actual,
    createTransferFromQuote: (...args: unknown[]) => createTransferFromQuote(...args),
    cancelTransfer: (...args: unknown[]) => cancelTransfer(...args),
    transitionTransfer: (...args: unknown[]) => transitionTransfer(...args),
  }
})

// Funding processor is mocked so the cancel tests can assert void call-counts
// (the real mock mints a fresh ref each call). initiateFunding keeps the shape
// the confirm tests expect.
const initiateFunding = vi.fn()
const voidFunding = vi.fn()
const getClientSession = vi.fn()
const getDepositInstructions = vi.hoisted(() => vi.fn())
vi.mock('../../services/deposit-instructions.js', () => ({
  getDepositInstructions: (...args: unknown[]) => getDepositInstructions(...args),
}))
const isConfigured = vi.fn(() => true)
const deferredInitiation = vi.fn(() => false)
const getDeferredClientBootstrap = vi.fn()

// Only the PROCESSOR is mocked. The ref-namespace helpers (undoModeForRef,
// undoRequiresManualDisbursement) are pure and are what the cancel tail reads to
// decide whether a refund may settle to REFUNDED — stubbing them out would hide
// exactly the branch that matters.
vi.mock('../../services/funding/index.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../services/funding/index.js')>()
  return {
    ...actual,
    getFundingProcessor: () => ({
      provider: 'mock',
      signatureHeader: 'funding-signature',
      isConfigured: () => isConfigured(),
      // K4: flipped true by the deferred-initiation tests; read at call time.
      deferredInitiation: deferredInitiation(),
      initiateFunding,
      voidFunding,
      getClientSession,
      // Present only on the deferred rail, like the real registry (K5): the
      // funding-session route feature-detects this method.
      ...(deferredInitiation() ? { getDeferredClientBootstrap } : {}),
    }),
  }
})

// Per-user velocity gate (slice-7 PR5) + uncleared cap (slice-8 O3) are mocked
// ok by default so existing paths stay green; the trip cases flip them. The
// factory replaces the module, so it must also export the message constant the
// routes render (a sentinel — tests branch on `code`, never on copy).
const assessTransferRisk = vi.fn()
const assessUnclearedCap = vi.fn()
vi.mock('../../services/risk.js', () => ({
  assessTransferRisk: (...args: unknown[]) => assessTransferRisk(...args),
  assessUnclearedCap: (...args: unknown[]) => assessUnclearedCap(...args),
  UNCLEARED_CAP_MESSAGE: 'transfer in progress',
}))

const { transfersRoute } = await import('./transfers.js')
const { FundingInitiationError } = await import('../../services/funding/index.js')
const { idempotencyPlugin } = await import('../../plugins/idempotency.js')
const { TransferRpcError } = await import('../../services/transfers.js')

const mockAuth = fp(async (server) => {
  server.addHook('onRequest', async (request, reply) => {
    if (request.routeOptions?.config?.public) return
    if (!request.headers.authorization?.startsWith('Bearer ')) {
      return reply.code(401).send({ error: 'Unauthorized' })
    }
    request.user = { id: 'user-123' }
  })
})

function chain(result: { data?: unknown; error?: unknown }) {
  const resolved = { data: result.data ?? null, error: result.error ?? null }
  const b: Record<string, ReturnType<typeof vi.fn>> & {
    then?: (resolve: (v: unknown) => void) => void
  } = {} as never
  for (const m of ['select', 'insert', 'update', 'delete', 'eq', 'is', 'not', 'or', 'order', 'limit'] as const) {
    b[m] = vi.fn(() => b)
  }
  b['single'] = vi.fn(async () => resolved)
  b['maybeSingle'] = vi.fn(async () => resolved)
  b.then = (resolve) => resolve(resolved)
  return b
}

const QUOTE_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1'
const TRANSFER_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2'
const DISCLOSURE_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa3'
const USER_ID = 'user-123'
const FUTURE = '2036-01-01T00:00:00.000Z'

const approvedUser = {
  kyc_status: 'approved',
  bridge_customer_id: 'cust_1',
  preferred_language: 'es',
  first_name: 'Ana',
  last_name: 'García',
  email: 'ana@example.com',
}

const quoteRow = {
  id: QUOTE_ID,
  status: 'active',
  expires_at: FUTURE,
  send_amount_minor: 19801,
  fee_amount_minor: 199,
  receive_amount_minor: 396014,
  fx_rate: 19.9997,
  payout_destinations: { status: 'active', recipients: { status: 'active' } },
}

const transferRow = {
  id: TRANSFER_ID,
  user_id: 'user-123',
  payout_destination_id: 'dest-1',
  quote_id: QUOTE_ID,
  state: 'PENDING_PAYMENT',
  send_amount_minor: 19801,
  send_currency: 'USD',
  receive_amount_minor: 396014,
  receive_currency: 'MXN',
  margin_minor: 0,
  fee_amount_minor: 199,
  fee_currency: 'USD',
  fx_rate: 19.9997,
  funding_source_type: 'ach',
  funding_cleared: false,
  disclosure_accepted_at: null,
  payment_at: null,
  cancelable_until: null,
  idempotency_key: 'bridge-key-1',
  funding_payment_ref: null,
  provider_transfer_ref: null,
  refund_payment_ref: null,
  refunded_at: null,
  submit_attempted_at: null,
  completed_at: null,
  created_at: '2026-07-17T20:00:00.000Z',
}

const disclosureRow = {
  id: DISCLOSURE_ID,
  transfer_id: TRANSFER_ID,
  type: 'prepayment',
  locale: 'es',
  content: { version: 1 },
  presented_at: '2026-07-17T20:00:00.000Z',
}

// table-keyed mock: idempotency claims always win, users approved, per-test
// overrides via tables map
function routeTables(overrides: Record<string, unknown> = {}) {
  const tables: Record<string, unknown> = {
    idempotency_keys: () => chain({ data: { id: 'claim-1' } }),
    users: () => chain({ data: approvedUser }),
    quotes: () => chain({ data: quoteRow }),
    transfers: () => chain({ data: transferRow }),
    disclosures: () => chain({ data: { id: DISCLOSURE_ID } }),
    ...overrides,
  }
  from.mockImplementation((table: unknown) => (tables[table as string] as () => unknown)())
}

async function buildApp() {
  const app = Fastify({ logger: false })
  await app.register(mockAuth)
  await app.register(idempotencyPlugin)
  await app.register(transfersRoute, { prefix: '/v1' })
  await app.ready()
  return app
}

beforeEach(() => {
  from.mockReset()
  createTransferFromQuote.mockReset()
  cancelTransfer.mockReset()
  transitionTransfer.mockReset()
  deferredInitiation.mockReset()
  deferredInitiation.mockReturnValue(false)
  initiateFunding.mockReset()
  voidFunding.mockReset()
  initiateFunding.mockResolvedValue({
    provider: 'mock',
    method: 'ach',
    paymentRef: 'mockpay_new',
    clientFields: {},
  })
  voidFunding.mockResolvedValue({
    provider: 'mock',
    ref: 'mockvoid_test',
    status: 'succeeded',
    mode: 'voided',
  })
  getClientSession.mockReset()
  getClientSession.mockResolvedValue({ provider: 'mock', fields: {} })
  getDeferredClientBootstrap.mockReset()
  getDeferredClientBootstrap.mockReturnValue({
    provider: 'stripe_crypto',
    fields: { publishableKey: 'pk_test_x' },
  })
  getDepositInstructions.mockReset().mockResolvedValue(null)
  assessTransferRisk.mockReset()
  assessTransferRisk.mockResolvedValue({ ok: true })
  assessUnclearedCap.mockReset()
  assessUnclearedCap.mockResolvedValue({ ok: true })
  recordCancellationRequest.mockReset()
  recordCancellationRequest.mockResolvedValue({
    id: 'cr-1',
    transfer_id: TRANSFER_ID,
    user_id: USER_ID,
    requested_at: '2026-07-28T12:00:00.000Z',
    requested_state: 'SUBMITTED',
    within_window: true,
    status: 'pending',
  })
  captureMessage.mockReset()
  setFingerprint.mockReset()
  captureException.mockReset()
  enqueueFundingOnrampPrepare.mockReset().mockResolvedValue('job-1')
})

describe('POST /v1/transfers', () => {
  const create = (app: Awaited<ReturnType<typeof buildApp>>, key = 'idem-1') =>
    supertest(app.server)
      .post('/v1/transfers')
      .set('Authorization', 'Bearer test-token')
      .set('Idempotency-Key', key)
      .send({ quoteId: QUOTE_ID })

  it('creates the transfer with a bilingual disclosure built from the quote', async () => {
    routeTables()
    createTransferFromQuote.mockResolvedValue({ transfer: transferRow, disclosure: disclosureRow })
    const app = await buildApp()

    const res = await create(app)

    expect(res.status).toBe(201)
    expect(res.body).toMatchObject({
      id: TRANSFER_ID,
      quoteId: QUOTE_ID,
      state: 'PENDING_PAYMENT',
      totalAmount: { amountMinor: 20000, currency: 'USD' },
      fxRate: '19.9997',
      disclosure: { id: DISCLOSURE_ID, type: 'prepayment', locale: 'es' },
    })

    const call = createTransferFromQuote.mock.calls[0]![0] as {
      locale: string
      disclosureContent: Record<string, unknown>
    }
    expect(call.locale).toBe('es')
    expect(call.disclosureContent['amounts']).toMatchObject({
      totalMinor: 20000,
      fxRate: '19.9997',
    })
    expect(call.disclosureContent['en']).toBeTruthy()
    expect(call.disclosureContent['es']).toBeTruthy()
    await app.close()
  })

  it('401s without auth and 400s without an Idempotency-Key', async () => {
    const app = await buildApp()
    const noAuth = await supertest(app.server).post('/v1/transfers').send({ quoteId: QUOTE_ID })
    expect(noAuth.status).toBe(401)

    routeTables()
    const noKey = await supertest(app.server)
      .post('/v1/transfers')
      .set('Authorization', 'Bearer test-token')
      .send({ quoteId: QUOTE_ID })
    expect(noKey.status).toBe(400)
    expect(createTransferFromQuote).not.toHaveBeenCalled()
    await app.close()
  })

  it('403s unapproved users before touching quotes', async () => {
    routeTables({ users: () => chain({ data: { ...approvedUser, kyc_status: 'pending' } }) })
    const app = await buildApp()
    const res = await create(app)
    expect(res.status).toBe(403)
    expect(res.body.error.code).toBe('kyc_required')
    await app.close()
  })

  it('404s a missing/foreign quote and 409s an archived destination', async () => {
    routeTables({ quotes: () => chain({ data: null }) })
    const app = await buildApp()
    expect((await create(app)).status).toBe(404)

    routeTables({
      quotes: () =>
        chain({
          data: {
            ...quoteRow,
            payout_destinations: { status: 'archived', recipients: { status: 'active' } },
          },
        }),
    })
    const res = await create(app, 'idem-2')
    expect(res.status).toBe(409)
    expect(res.body.error.code).toBe('conflict')
    expect(createTransferFromQuote).not.toHaveBeenCalled()
    await app.close()
  })

  it('403s transfer_in_progress at the uncleared cap — before any quote work', async () => {
    routeTables()
    assessUnclearedCap.mockResolvedValue({ ok: false, blockerTransferId: 'tr-prior' })
    const app = await buildApp()
    const res = await create(app)
    expect(res.status).toBe(403)
    expect(res.body.error.code).toBe('transfer_in_progress')
    expect(createTransferFromQuote).not.toHaveBeenCalled()
    expect(assessUnclearedCap).toHaveBeenCalledWith({ userId: 'user-123' })
    await app.close()
  })

  it.each([
    ['quote_consumed', 409, 'conflict'],
    ['quote_expired', 409, 'quote_expired'],
    ['quote_not_found', 404, 'not_found'],
  ] as const)('maps RPC %s to %s %s', async (rpcCode, status, apiCode) => {
    routeTables()
    createTransferFromQuote.mockRejectedValue(new TransferRpcError(rpcCode))
    const app = await buildApp()

    const res = await create(app)
    expect(res.status).toBe(status)
    expect(res.body.error.code).toBe(apiCode)
    await app.close()
  })
})

describe('POST /v1/transfers/:id/confirm', () => {
  const confirm = (
    app: Awaited<ReturnType<typeof buildApp>>,
    body: Record<string, unknown> = { disclosureId: DISCLOSURE_ID, accepted: true },
    key = 'confirm-1',
  ) =>
    supertest(app.server)
      .post(`/v1/transfers/${TRANSFER_ID}/confirm`)
      .set('Authorization', 'Bearer test-token')
      .set('Idempotency-Key', key)
      .send(body)

  it('records acceptance and returns processor-neutral funding details', async () => {
    routeTables({
      transfers: () =>
        chain({ data: { ...transferRow, disclosure_accepted_at: '2026-07-17T20:01:00.000Z' } }),
    })
    const app = await buildApp()

    const res = await confirm(app)

    expect(res.status).toBe(200)
    expect(res.body).toMatchObject({
      id: TRANSFER_ID,
      state: 'PENDING_PAYMENT',
      funding: { provider: 'mock', method: 'ach', clientFields: {} },
    })
    expect(res.body.disclosureAcceptedAt).toBeTruthy()
    // a retry of an already-committed send skips the velocity check (keeps its slot)
    expect(assessTransferRisk).not.toHaveBeenCalled()
    // …and the uncleared cap for the same reason: its slot is already occupied
    expect(assessUnclearedCap).not.toHaveBeenCalled()
    // mock rail: no deposit coordinates to prepare
    expect(enqueueFundingOnrampPrepare).not.toHaveBeenCalled()
    await app.close()
  })

  it('schema-rejects accepted:false', async () => {
    routeTables()
    const app = await buildApp()
    const res = await confirm(app, { disclosureId: DISCLOSURE_ID, accepted: false })
    expect(res.status).toBe(400)
    await app.close()
  })

  // ── K4: deferred initiation (stripe_crypto — sessions are pay-step) ──
  // Under the deferred rail the gate is profile+consents, NOT kyc_status —
  // the fixture user is deliberately not_started to pin that.
  const newFlowUser = {
    ...approvedUser,
    kyc_status: 'not_started',
    address_line1: '500 East Cesar Chavez St',
    address_city: 'Austin',
    address_state: 'TX',
    address_postal_code: '78701',
  }
  const grantedConsents = REQUIRED_CONSENTS.map((r) => ({
    type: r.type,
    version: r.version,
    locale: 'en',
    consented_at: '2026-08-27T12:00:00Z',
  }))

  it('deferred rail: records acceptance, never initiates, persists no ref', async () => {
    deferredInitiation.mockReturnValue(true)
    routeTables({
      users: () => chain({ data: newFlowUser }),
      consents: () => chain({ data: grantedConsents }),
    })
    const app = await buildApp()

    const res = await confirm(app)

    expect(res.status).toBe(200)
    expect(res.body.funding).toEqual({ provider: 'mock', method: 'onramp', clientFields: {} })
    expect(initiateFunding).not.toHaveBeenCalled()
    await app.close()
  })

  it('deferred rail: acceptance ALONE is confirmed-ness — re-confirm 409s', async () => {
    deferredInitiation.mockReturnValue(true)
    routeTables({
      users: () => chain({ data: newFlowUser }),
      consents: () => chain({ data: grantedConsents }),
      transfers: () =>
        chain({ data: { ...transferRow, disclosure_accepted_at: '2026-07-17T20:01:00.000Z' } }),
    })
    const app = await buildApp()

    const res = await confirm(app)

    expect(res.status).toBe(409)
    expect(res.body.error.code).toBe('conflict')
    expect(initiateFunding).not.toHaveBeenCalled()
    await app.close()
  })

  it('deferred rail: an incomplete new-flow profile is refused before acceptance', async () => {
    deferredInitiation.mockReturnValue(true)
    routeTables() // default user: approved KYC but NO address — incomplete under the new gate
    const app = await buildApp()

    const res = await confirm(app)

    expect(res.status).toBe(403)
    expect(res.body.error.code).toBe('forbidden')
    await app.close()
  })

  // ── slice 3: confirm hands onramp creation to the worker (manual rail) ──
  it('manual rail: enqueues funding.onramp_prepare after the ref persists', async () => {
    routeTables()
    initiateFunding.mockResolvedValue({
      provider: 'manual',
      method: 'ach',
      paymentRef: 'manualpay_new',
      clientFields: {},
    })
    const app = await buildApp()

    const res = await confirm(app)

    expect(res.status).toBe(200)
    expect(enqueueFundingOnrampPrepare).toHaveBeenCalledWith(TRANSFER_ID, 'api')
    await app.close()
  })

  it('manual rail: a failed enqueue never fails the confirm (attach button recovers)', async () => {
    routeTables()
    initiateFunding.mockResolvedValue({
      provider: 'manual',
      method: 'ach',
      paymentRef: 'manualpay_new',
      clientFields: {},
    })
    enqueueFundingOnrampPrepare.mockRejectedValue(new Error('pg-boss down'))
    const app = await buildApp()

    const res = await confirm(app)

    expect(res.status).toBe(200)
    expect(res.body).toMatchObject({ id: TRANSFER_ID, state: 'PENDING_PAYMENT' })
    expect(captureException).toHaveBeenCalled()
    await app.close()
  })

  // ── #213: onramp initiation context + refusal mapping ──
  it('forwards the proxied client IP and the KYC prefill to initiateFunding', async () => {
    routeTables()
    const app = await buildApp()

    const res = await confirm(app).set('X-Client-Ip', '203.0.113.9')

    expect(res.status).toBe(200)
    const arg = initiateFunding.mock.calls[0]![0] as Record<string, unknown>
    expect(arg['clientIp']).toBe('203.0.113.9')
    expect(arg['customer']).toEqual({
      firstName: 'Ana',
      lastName: 'García',
      email: 'ana@example.com',
    })
    await app.close()
  })

  it('falls back to request.ip for direct callers (no proxy header)', async () => {
    routeTables()
    const app = await buildApp()

    const res = await confirm(app)

    expect(res.status).toBe(200)
    const arg = initiateFunding.mock.calls[0]![0] as Record<string, unknown>
    expect(typeof arg['clientIp']).toBe('string')
    expect(arg['clientIp']).not.toBe('')
    await app.close()
  })

  it('omits absent prefill fields rather than passing nulls to the processor', async () => {
    routeTables({
      users: () =>
        chain({ data: { ...approvedUser, first_name: null, last_name: null, email: null } }),
    })
    const app = await buildApp()

    const res = await confirm(app)

    expect(res.status).toBe(200)
    const arg = initiateFunding.mock.calls[0]![0] as Record<string, unknown>
    expect(arg['customer']).toEqual({})
    await app.close()
  })

  it('403s funding_unsupported when the processor refuses this sender', async () => {
    routeTables()
    initiateFunding.mockRejectedValue(new FundingInitiationError('unsupported'))
    const app = await buildApp()

    const res = await confirm(app)

    expect(res.status).toBe(403)
    expect(res.body.error.code).toBe('funding_unsupported')
    await app.close()
  })

  it('503s not_configured on the processor-wide kill switch', async () => {
    routeTables()
    initiateFunding.mockRejectedValue(new FundingInitiationError('disabled'))
    const app = await buildApp()

    const res = await confirm(app)

    expect(res.status).toBe(503)
    expect(res.body.error.code).toBe('not_configured')
    await app.close()
  })

  it('still 500s a non-initiation processor fault (nothing swallowed)', async () => {
    routeTables()
    initiateFunding.mockRejectedValue(new Error('stripe unreachable'))
    const app = await buildApp()

    const res = await confirm(app)

    expect(res.status).toBe(500)
    await app.close()
  })

  it("503s not_configured on the processor's configured-check — before any funding call", async () => {
    routeTables()
    isConfigured.mockReturnValueOnce(false)
    const app = await buildApp()

    const res = await confirm(app)

    expect(res.status).toBe(503)
    expect(res.body.error.code).toBe('not_configured')
    expect(initiateFunding).not.toHaveBeenCalled()
    await app.close()
  })

  it('409s when the transfer is past PENDING_PAYMENT', async () => {
    routeTables({ transfers: () => chain({ data: { ...transferRow, state: 'FUNDED' } }) })
    const app = await buildApp()
    const res = await confirm(app)
    expect(res.status).toBe(409)
    expect(res.body.error.code).toBe('conflict')
    await app.close()
  })

  it('400s a mismatched disclosure id', async () => {
    routeTables({ disclosures: () => chain({ data: { id: 'someone-elses-disclosure' } }) })
    const app = await buildApp()
    const res = await confirm(app)
    expect(res.status).toBe(400)
    await app.close()
  })

  it('409s quote_expired when the firm window has lapsed', async () => {
    routeTables({
      quotes: () => chain({ data: { expires_at: '2026-01-01T00:00:00.000Z' } }),
    })
    const app = await buildApp()
    const res = await confirm(app)
    expect(res.status).toBe(409)
    expect(res.body.error.code).toBe('quote_expired')
    await app.close()
  })

  it('409s an already-confirmed transfer (accepted + funding ref)', async () => {
    routeTables({
      transfers: () =>
        chain({
          data: {
            ...transferRow,
            disclosure_accepted_at: '2026-07-17T20:01:00.000Z',
            funding_payment_ref: 'mockpay_existing',
          },
        }),
    })
    const app = await buildApp()
    const res = await confirm(app)
    expect(res.status).toBe(409)
    await app.close()
  })

  it('403 transfer_in_progress at the uncleared cap — before the velocity gate and any funding', async () => {
    routeTables() // fresh transfer, disclosure_accepted_at: null → the gate runs
    assessUnclearedCap.mockResolvedValue({ ok: false, blockerTransferId: 'tr-prior' })
    const app = await buildApp()
    const res = await confirm(app)
    expect(res.status).toBe(403)
    expect(res.body.error.code).toBe('transfer_in_progress')
    // refused before a dollar moves, and before the velocity gate even runs
    expect(initiateFunding).not.toHaveBeenCalled()
    expect(assessTransferRisk).not.toHaveBeenCalled()
    expect(assessUnclearedCap).toHaveBeenCalledWith({
      userId: 'user-123',
      excludeTransferId: TRANSFER_ID,
    })
    await app.close()
  })

  it('fails closed — an uncleared-cap query error 500s and never initiates funding', async () => {
    routeTables()
    assessUnclearedCap.mockRejectedValue(new Error('db down'))
    const app = await buildApp()
    const res = await confirm(app)
    expect(res.status).toBe(500)
    expect(initiateFunding).not.toHaveBeenCalled()
    await app.close()
  })

  it('403 limit_exceeded when over the velocity limit — before any funding', async () => {
    routeTables() // fresh transfer, disclosure_accepted_at: null → the gate runs
    assessTransferRisk.mockResolvedValue({ ok: false, reason: 'velocity_count' })
    const app = await buildApp()
    const res = await confirm(app)
    expect(res.status).toBe(403)
    expect(res.body.error.code).toBe('limit_exceeded')
    // the whole point: an over-limit send is refused before a dollar moves
    expect(initiateFunding).not.toHaveBeenCalled()
    // and the caller metered the send principal only (fee excluded) and excluded the transfer itself
    expect(assessTransferRisk).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: 'user-123',
        sendAmountMinor: 19801,
        excludeTransferId: TRANSFER_ID,
      }),
    )
    await app.close()
  })

  it('fails closed — a risk-query error 500s and never initiates funding', async () => {
    routeTables()
    assessTransferRisk.mockRejectedValue(new Error('db down'))
    const app = await buildApp()
    const res = await confirm(app)
    expect(res.status).toBe(500)
    expect(initiateFunding).not.toHaveBeenCalled()
    await app.close()
  })
})

describe('POST /v1/transfers/:id/cancel', () => {
  const cancel = (
    app: Awaited<ReturnType<typeof buildApp>>,
    key = 'cancel-1',
    body: Record<string, unknown> = { transferId: TRANSFER_ID },
  ) =>
    supertest(app.server)
      .post(`/v1/transfers/${TRANSFER_ID}/cancel`)
      .set('Authorization', 'Bearer test-token')
      .set('Idempotency-Key', key)
      .send(body)

  const fundedRow = {
    ...transferRow,
    state: 'FUNDED',
    funding_payment_ref: 'mockpay_1',
    cancelable_until: FUTURE,
  }

  // transfers mock returning a different row per successive from('transfers')
  // read (initial load, then the post-RPC re-read); idempotency_keys has its own
  // table mock, so this advances only on transfers reads.
  const seqTransfers = (...rows: unknown[]) => {
    let i = 0
    return () => chain({ data: rows[Math.min(i++, rows.length - 1)] })
  }

  it('FUNDED → cancels (reverses the FUNDED batch), voids once, settles REFUNDED', async () => {
    routeTables({ transfers: () => chain({ data: fundedRow }) })
    cancelTransfer.mockResolvedValue({ ...fundedRow, state: 'CANCELED' })
    transitionTransfer.mockResolvedValue({
      ...fundedRow,
      state: 'REFUNDED',
      refund_payment_ref: 'mockvoid_test',
      refunded_at: '2026-07-17T20:10:00.000Z',
    })
    const app = await buildApp()

    const res = await cancel(app)

    expect(res.status).toBe(200)
    expect(res.body).toMatchObject({ id: TRANSFER_ID, state: 'REFUNDED' })

    // the CANCELED ledger batch is the exact reversal of the FUNDED batch
    const cancelArg = cancelTransfer.mock.calls[0]![0] as { ledgerEntries: unknown[] }
    expect(cancelArg.ledgerEntries).toEqual([
      { account_code: 'transfer_payable', direction: 'debit', amount_minor: 19801, currency: 'USD' },
      { account_code: 'fee_revenue', direction: 'debit', amount_minor: 199, currency: 'USD' },
      { account_code: 'funding_receivable', direction: 'credit', amount_minor: 20000, currency: 'USD' },
    ])

    // voided exactly once, keyed off the transfer's stable bridge key
    expect(voidFunding).toHaveBeenCalledTimes(1)
    expect(voidFunding.mock.calls[0]![0]).toMatchObject({
      paymentRef: 'mockpay_1',
      idempotencyKey: 'bridge-key-1:void',
    })

    // CANCELED → REFUNDED carries NO ledger
    const transitionArg = transitionTransfer.mock.calls[0]![0] as Record<string, unknown>
    expect(transitionArg).toMatchObject({ fromState: 'CANCELED', toState: 'REFUNDED' })
    expect(transitionArg['ledgerEntries']).toBeUndefined()
    await app.close()
  })

  it('an out-of-band refund holds at CANCELED — never claims REFUNDED before a human sends the money back', async () => {
    // REFUNDED means "the sender has been made whole" and the copy says so.
    // Under manual funding the money was collected on a rail we do not operate,
    // so voidFunding issues NOTHING — an operator must return it by hand.
    // Settling REFUNDED here would tell the sender their money came back when
    // nobody has sent it. (Compliance review finding, 2026-08-17.)
    routeTables({ transfers: () => chain({ data: fundedRow }) })
    cancelTransfer.mockResolvedValue({ ...fundedRow, state: 'CANCELED' })
    voidFunding.mockResolvedValue({
      provider: 'manual',
      ref: 'manualrefund_5f2c1d7e-0000-4000-8000-000000000000',
      status: 'pending',
      mode: 'refunded',
    })
    const app = await buildApp()

    const res = await cancel(app)

    expect(res.status).toBe(200)
    expect(res.body).toMatchObject({ state: 'CANCELED' })
    expect(res.body.state).not.toBe('REFUNDED')
    // The cancellation itself is real and the ledger reversal still posted —
    // only the "made whole" claim is withheld.
    expect(cancelTransfer).toHaveBeenCalledTimes(1)
    expect(transitionTransfer).not.toHaveBeenCalled()
    await app.close()
  })

  it('void→refund fallback (PI settled first): the cancel flow completes unchanged — persist, settle, 200', async () => {
    routeTables({ transfers: () => chain({ data: fundedRow }) })
    cancelTransfer.mockResolvedValue({ ...fundedRow, state: 'CANCELED' })
    // PR-S2: the pull settled before the cancel reached Stripe, so the adapter
    // fell back to a real (async) Refund. The route's flow must not change —
    // same persist, same ledger-free CANCELED → REFUNDED settle — the mode is
    // an audit-trail fact, not a branch in the money path here.
    voidFunding.mockResolvedValueOnce({
      provider: 'stripe',
      ref: 're_fallback1',
      status: 'pending',
      mode: 'refunded',
    })
    transitionTransfer.mockResolvedValue({
      ...fundedRow,
      state: 'REFUNDED',
      refund_payment_ref: 're_fallback1',
      refunded_at: '2026-07-17T20:10:00.000Z',
    })
    const app = await buildApp()

    const res = await cancel(app)

    expect(res.status).toBe(200)
    expect(res.body).toMatchObject({ id: TRANSFER_ID, state: 'REFUNDED' })
    expect(voidFunding).toHaveBeenCalledTimes(1)
    const transitionArg = transitionTransfer.mock.calls[0]![0] as Record<string, unknown>
    expect(transitionArg).toMatchObject({ fromState: 'CANCELED', toState: 'REFUNDED' })
    // still ledger-free: the CANCELED reversal already closed the books, and
    // the fallback's settlement+refund cash flows offset (recon timing window)
    expect(transitionArg['ledgerEntries']).toBeUndefined()
    await app.close()
  })

  it('401s without auth and 400s without an Idempotency-Key', async () => {
    const app = await buildApp()
    const noAuth = await supertest(app.server)
      .post(`/v1/transfers/${TRANSFER_ID}/cancel`)
      .send({ transferId: TRANSFER_ID })
    expect(noAuth.status).toBe(401)

    routeTables({ transfers: () => chain({ data: fundedRow }) })
    const noKey = await supertest(app.server)
      .post(`/v1/transfers/${TRANSFER_ID}/cancel`)
      .set('Authorization', 'Bearer test-token')
      .send({ transferId: TRANSFER_ID })
    expect(noKey.status).toBe(400)
    expect(cancelTransfer).not.toHaveBeenCalled()
    await app.close()
  })

  it('400s a missing or mismatched transferId body (per-transfer idempotency guard)', async () => {
    routeTables({ transfers: () => chain({ data: fundedRow }) })
    const app = await buildApp()
    // missing → schema rejects (the body is what makes the idempotency key per-transfer)
    const missing = await cancel(app, 'c-missing', {})
    expect(missing.status).toBe(400)
    // body id ≠ path id → 400, before any state work
    const mismatch = await cancel(app, 'c-mismatch', {
      transferId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaa99',
    })
    expect(mismatch.status).toBe(400)
    expect(mismatch.body.error.code).toBe('validation_error')
    expect(cancelTransfer).not.toHaveBeenCalled()
    await app.close()
  })

  it("404s a missing or another user's transfer", async () => {
    routeTables({ transfers: () => chain({ data: null }) })
    const app = await buildApp()
    const res = await cancel(app)
    expect(res.status).toBe(404)
    expect(cancelTransfer).not.toHaveBeenCalled()
    await app.close()
  })

  it('REFUNDED replay is an idempotent 200 — no cancel, no void', async () => {
    routeTables({ transfers: () => chain({ data: { ...fundedRow, state: 'REFUNDED' } }) })
    const app = await buildApp()
    const res = await cancel(app)
    expect(res.status).toBe(200)
    expect(res.body.state).toBe('REFUNDED')
    expect(cancelTransfer).not.toHaveBeenCalled()
    expect(voidFunding).not.toHaveBeenCalled()
    await app.close()
  })

  it.each(['SUBMITTED', 'IN_FLIGHT'] as const)(
    '%s → 202 that RECORDS the request (en+es), never a flat denial',
    async (state) => {
      routeTables({ transfers: () => chain({ data: { ...fundedRow, state } }) })
      const app = await buildApp()
      const res = await cancel(app)
      expect(res.status).toBe(202)
      expect(res.body).toMatchObject({ id: TRANSFER_ID, state, code: 'cancellation_requires_support' })

      // Exactly one request, stamped with the state that produced it — the
      // whole point of the 202 is now that it leaves evidence.
      expect(recordCancellationRequest).toHaveBeenCalledTimes(1)
      expect(recordCancellationRequest).toHaveBeenCalledWith({
        transferId: TRANSFER_ID,
        userId: USER_ID,
        state,
      })
      expect(res.body.requestedAt).toBe('2026-07-28T12:00:00.000Z')

      // The copy must NOT send them to support any more: the tap they just made
      // IS the request, and the old wording misdirected them to an inbox that
      // does not exist yet. It must also not condition the refund on the payout
      // failing — a timely request is refunded either way.
      expect(res.body.messages.en).not.toMatch(/support/i)
      expect(res.body.messages.es).not.toMatch(/soporte/i)
      expect(res.body.messages.en).toMatch(/recorded your cancellation request/i)
      expect(res.body.messages.es).toMatch(/registramos tu solicitud/i)

      expect(cancelTransfer).not.toHaveBeenCalled()
      expect(voidFunding).not.toHaveBeenCalled()
      await app.close()
    },
  )

  // The sender exercised a statutory right. If OUR bookkeeping fails, that is
  // our problem to page ourselves about — it must never surface as a 500 that
  // makes them think the request did not land.
  it('still answers 202 when recording the request fails, and pages ops', async () => {
    recordCancellationRequest.mockRejectedValueOnce(new Error('db down'))
    routeTables({ transfers: () => chain({ data: { ...fundedRow, state: 'SUBMITTED' } }) })
    const app = await buildApp()
    const res = await cancel(app)

    expect(res.status).toBe(202)
    expect(res.body.code).toBe('cancellation_requires_support')
    // …but without a requestedAt, because we do not know one.
    expect(res.body.requestedAt).toBeUndefined()
    expect(setFingerprint).toHaveBeenCalledWith(['cancellation-record-failed', TRANSFER_ID])
    expect(captureMessage.mock.calls.at(-1)?.[1]).toBe('error')
    await app.close()
  })

  it('claimed-but-still-FUNDED (submit_attempted_at set) → 202, never the cancel path', async () => {
    // the submit job set submit_attempted_at while state is still FUNDED — a
    // Bridge payout is being created, so this is post-claim, not a fresh cancel
    routeTables({
      transfers: () => chain({ data: { ...fundedRow, submit_attempted_at: '2026-07-17T20:05:00.000Z' } }),
    })
    const app = await buildApp()
    const res = await cancel(app)
    expect(res.status).toBe(202)
    expect(res.body.code).toBe('cancellation_requires_support')
    // The record must carry the state that produced this 202: FUNDED here
    // means FUNDED-post-claim, and requested_state is statutory evidence.
    expect(recordCancellationRequest).toHaveBeenCalledWith({
      transferId: TRANSFER_ID,
      userId: USER_ID,
      state: 'FUNDED',
    })
    expect(cancelTransfer).not.toHaveBeenCalled()
    await app.close()
  })

  it.each(['PENDING_PAYMENT', 'COMPLETED', 'PAYOUT_FAILED'] as const)(
    '%s → 409 transfer_not_cancelable',
    async (state) => {
      routeTables({ transfers: () => chain({ data: { ...fundedRow, state } }) })
      const app = await buildApp()
      const res = await cancel(app)
      expect(res.status).toBe(409)
      expect(res.body.error.code).toBe('transfer_not_cancelable')
      expect(cancelTransfer).not.toHaveBeenCalled()
      await app.close()
    },
  )

  it('lost the race after our read (re-read shows the submit job won) → compliant 202, not a flat 409', async () => {
    // initial load reads FUNDED+unclaimed; RPC raises transfer_not_cancelable;
    // the re-read shows the row advanced → Reg E-compliant support routing
    routeTables({ transfers: seqTransfers(fundedRow, { ...fundedRow, state: 'SUBMITTED' }) })
    cancelTransfer.mockRejectedValue(new TransferRpcError('transfer_not_cancelable'))
    const app = await buildApp()
    const res = await cancel(app)
    expect(res.status).toBe(202)
    expect(res.body.code).toBe('cancellation_requires_support')
    // The record must reflect the FRESH re-read (SUBMITTED), not the stale
    // pre-RPC row (FUNDED): requested_state is statutory evidence, and passing
    // the stale row would record false evidence on every lost race.
    expect(recordCancellationRequest).toHaveBeenCalledWith({
      transferId: TRANSFER_ID,
      userId: USER_ID,
      state: 'SUBMITTED',
    })
    expect(voidFunding).not.toHaveBeenCalled()
    await app.close()
  })

  it('lost the race to a concurrent cancel (re-read shows REFUNDED) → idempotent 200, not a 409', async () => {
    // two cancels with DIFFERENT keys both load FUNDED; the other finished first
    routeTables({
      transfers: seqTransfers(fundedRow, {
        ...fundedRow,
        state: 'REFUNDED',
        refund_payment_ref: 'mockvoid_prev',
      }),
    })
    cancelTransfer.mockRejectedValue(new TransferRpcError('transfer_not_cancelable'))
    const app = await buildApp()
    const res = await cancel(app)
    expect(res.status).toBe(200)
    expect(res.body.state).toBe('REFUNDED')
    expect(voidFunding).not.toHaveBeenCalled()
    await app.close()
  })

  it('window expired (re-read still FUNDED + unclaimed) → lawful 409', async () => {
    routeTables({ transfers: () => chain({ data: fundedRow }) }) // FUNDED+null on load and re-read
    cancelTransfer.mockRejectedValue(new TransferRpcError('transfer_not_cancelable'))
    const app = await buildApp()
    const res = await cancel(app)
    expect(res.status).toBe(409)
    expect(res.body.error.code).toBe('transfer_not_cancelable')
    expect(voidFunding).not.toHaveBeenCalled()
    await app.close()
  })

  it('CANCELED replay (no ref yet) resumes at the void step — no second cancel', async () => {
    routeTables({ transfers: () => chain({ data: { ...fundedRow, state: 'CANCELED' } }) })
    transitionTransfer.mockResolvedValue({ ...fundedRow, state: 'REFUNDED' })
    const app = await buildApp()

    const res = await cancel(app)

    expect(res.status).toBe(200)
    expect(res.body.state).toBe('REFUNDED')
    expect(cancelTransfer).not.toHaveBeenCalled() // already CANCELED — don't re-cancel
    expect(voidFunding).toHaveBeenCalledTimes(1)
    await app.close()
  })

  it('CANCELED replay (ref already persisted) skips the void entirely', async () => {
    routeTables({
      transfers: () => chain({ data: { ...fundedRow, state: 'CANCELED', refund_payment_ref: 'mockvoid_prev' } }),
    })
    transitionTransfer.mockResolvedValue({ ...fundedRow, state: 'REFUNDED', refund_payment_ref: 'mockvoid_prev' })
    const app = await buildApp()

    const res = await cancel(app)

    expect(res.status).toBe(200)
    expect(res.body.state).toBe('REFUNDED')
    expect(cancelTransfer).not.toHaveBeenCalled()
    expect(voidFunding).not.toHaveBeenCalled() // ref already set — no second processor call
    await app.close()
  })
})

describe('GET /v1/transfers', () => {
  it('lists owner-scoped with keyset lookahead', async () => {
    const rows = [
      { ...transferRow, id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaa10', created_at: '2026-07-17T20:02:00.000Z' },
      { ...transferRow, id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaa11', created_at: '2026-07-17T20:01:00.000Z' },
      { ...transferRow, id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaa12', created_at: '2026-07-17T20:00:00.000Z' },
    ]
    const list = chain({ data: rows })
    from.mockReturnValueOnce(list)
    const app = await buildApp()

    const res = await supertest(app.server)
      .get('/v1/transfers?limit=2')
      .set('Authorization', 'Bearer test-token')

    expect(res.status).toBe(200)
    expect(res.body.data).toHaveLength(2)
    expect(res.body.nextCursor).toBeTruthy()
    expect(list['eq']).toHaveBeenCalledWith('user_id', 'user-123')
    await app.close()
  })

  it('400s an invalid cursor', async () => {
    const app = await buildApp()
    const res = await supertest(app.server)
      .get('/v1/transfers?cursor=%20nonsense%20')
      .set('Authorization', 'Bearer test-token')
    expect(res.status).toBe(400)
    await app.close()
  })

  it('scope=history hides abandoned sends but keeps confirmed pending ones (manual rail)', async () => {
    const list = chain({ data: [transferRow] })
    from.mockReturnValueOnce(list)
    const app = await buildApp()

    const res = await supertest(app.server)
      .get('/v1/transfers?scope=history')
      .set('Authorization', 'Bearer test-token')

    expect(res.status).toBe(200)
    // A confirmed PENDING_PAYMENT (funding_payment_ref set — sender is
    // mid-deposit under out-of-band funding) is a real transaction and must
    // stay visible; unconfirmed quote-commits and PAYMENT_FAILED stay hidden.
    expect(list['or']).toHaveBeenCalledWith(
      'state.not.in.(PENDING_PAYMENT,PAYMENT_FAILED),and(state.eq.PENDING_PAYMENT,funding_payment_ref.not.is.null)',
    )
    expect(list['not']).not.toHaveBeenCalled()
    await app.close()
  })

  it('scope=all (default) returns everything — no state filter', async () => {
    const list = chain({ data: [transferRow] })
    from.mockReturnValueOnce(list)
    const app = await buildApp()

    const res = await supertest(app.server)
      .get('/v1/transfers')
      .set('Authorization', 'Bearer test-token')

    expect(res.status).toBe(200)
    expect(list['not']).not.toHaveBeenCalled()
    await app.close()
  })

  it('400s an invalid scope', async () => {
    const app = await buildApp()
    const res = await supertest(app.server)
      .get('/v1/transfers?scope=bogus')
      .set('Authorization', 'Bearer test-token')
    expect(res.status).toBe(400)
    await app.close()
  })
})

describe('GET /v1/transfers/:id', () => {
  it('returns the transfer with its disclosure summaries', async () => {
    from
      .mockReturnValueOnce(chain({ data: transferRow }))
      .mockReturnValueOnce(chain({ data: [disclosureRow] }))
    const app = await buildApp()

    const res = await supertest(app.server)
      .get(`/v1/transfers/${TRANSFER_ID}`)
      .set('Authorization', 'Bearer test-token')

    expect(res.status).toBe(200)
    expect(res.body.disclosures).toEqual([
      { id: DISCLOSURE_ID, type: 'prepayment', locale: 'es', presentedAt: disclosureRow.presented_at },
    ])
    await app.close()
  })

  it("404s another user's transfer", async () => {
    from.mockReturnValueOnce(chain({ data: null }))
    const app = await buildApp()
    const res = await supertest(app.server)
      .get(`/v1/transfers/${TRANSFER_ID}`)
      .set('Authorization', 'Bearer test-token')
    expect(res.status).toBe(404)
    await app.close()
  })
})

describe('GET /v1/transfers/:id/funding-session', () => {
  const get = (app: Awaited<ReturnType<typeof buildApp>>) =>
    supertest(app.server)
      .get(`/v1/transfers/${TRANSFER_ID}/funding-session`)
      .set('Authorization', 'Bearer test-token')

  const pendingWithRef = { ...transferRow, funding_payment_ref: 'pi_123' }

  it('returns the flattened stripe session for an owned PENDING_PAYMENT transfer', async () => {
    from.mockReturnValueOnce(chain({ data: pendingWithRef }))
    getClientSession.mockResolvedValue({
      provider: 'stripe',
      fields: {
        clientSecret: 'pi_123_secret_x',
        publishableKey: 'pk_test_x',
        status: 'requires_payment_method',
      },
    })
    const app = await buildApp()

    const res = await get(app)

    expect(res.status).toBe(200)
    expect(res.body).toEqual({
      provider: 'stripe',
      clientSecret: 'pi_123_secret_x',
      publishableKey: 'pk_test_x',
      status: 'requires_payment_method',
    })
    expect(getClientSession).toHaveBeenCalledWith({ paymentRef: 'pi_123' })
    await app.close()
  })

  it('returns provider-only under the mock processor — no clientSecret key at all', async () => {
    from.mockReturnValueOnce(chain({ data: pendingWithRef }))
    const app = await buildApp()

    const res = await get(app)

    expect(res.status).toBe(200)
    expect(res.body).toEqual({ provider: 'mock' })
    await app.close()
  })

  it('manual + attached instructions: returns them on the session (#199)', async () => {
    from.mockReturnValueOnce(chain({ data: pendingWithRef }))
    getClientSession.mockResolvedValue({ provider: 'manual', fields: {} })
    getDepositInstructions.mockResolvedValue({
      transfer_id: TRANSFER_ID,
      bridge_transfer_ref: 'dddddddd-1111-4222-8333-444444444444',
      currency: 'USD',
      amount_minor: 10000,
      payment_rail: 'ach',
      bank_name: 'Lead Bank',
      bank_routing_number: '101019644',
      bank_account_number: '215268129123',
      bank_beneficiary_name: 'Bridge Ventures Inc',
      deposit_message: 'BRGABCD1234',
    })
    const app = await buildApp()

    const res = await get(app)

    expect(res.status).toBe(200)
    expect(res.body).toEqual({
      provider: 'manual',
      depositInstructions: {
        amountMinor: 10000,
        currency: 'USD',
        paymentRail: 'ach',
        bankName: 'Lead Bank',
        bankRoutingNumber: '101019644',
        bankAccountNumber: '215268129123',
        bankBeneficiaryName: 'Bridge Ventures Inc',
        depositMessage: 'BRGABCD1234',
      },
    })
    expect(getDepositInstructions).toHaveBeenCalledWith(TRANSFER_ID)
    await app.close()
  })

  it('manual + nothing attached: provider-only, and the key is absent', async () => {
    from.mockReturnValueOnce(chain({ data: pendingWithRef }))
    getClientSession.mockResolvedValue({ provider: 'manual', fields: {} })
    const app = await buildApp()

    const res = await get(app)

    expect(res.status).toBe(200)
    expect(res.body).toEqual({ provider: 'manual' })
    await app.close()
  })

  it('never reads instructions for a non-manual provider', async () => {
    from.mockReturnValueOnce(chain({ data: pendingWithRef }))
    getClientSession.mockResolvedValue({
      provider: 'stripe',
      fields: { clientSecret: 'x', publishableKey: 'y' },
    })
    const app = await buildApp()

    await get(app)

    expect(getDepositInstructions).not.toHaveBeenCalled()
    await app.close()
  })

  it('strips fields outside the response schema — a widened processor cannot widen the wire', async () => {
    from.mockReturnValueOnce(chain({ data: pendingWithRef }))
    getClientSession.mockResolvedValue({
      provider: 'stripe',
      fields: {
        clientSecret: 'pi_123_secret_x',
        publishableKey: 'pk_test_x',
        secretKey: 'sk_leak',
      },
    })
    const app = await buildApp()

    const res = await get(app)

    expect(res.status).toBe(200)
    expect(res.body).not.toHaveProperty('secretKey')
    await app.close()
  })

  it("404s another user's transfer without leaking existence", async () => {
    from.mockReturnValueOnce(chain({ data: null }))
    const app = await buildApp()
    const res = await get(app)
    expect(res.status).toBe(404)
    expect(res.body.error.code).toBe('not_found')
    expect(getClientSession).not.toHaveBeenCalled()
    await app.close()
  })

  it('409s once the transfer has left PENDING_PAYMENT', async () => {
    from.mockReturnValueOnce(
      chain({ data: { ...pendingWithRef, state: 'FUNDED' } }),
    )
    const app = await buildApp()
    const res = await get(app)
    expect(res.status).toBe(409)
    expect(res.body.error.code).toBe('conflict')
    expect(getClientSession).not.toHaveBeenCalled()
    await app.close()
  })

  it('409s the confirm-crashed window (no funding_payment_ref) — confirm retry owns that recovery', async () => {
    from.mockReturnValueOnce(chain({ data: transferRow })) // ref is null in the fixture
    const app = await buildApp()
    const res = await get(app)
    expect(res.status).toBe(409)
    expect(getClientSession).not.toHaveBeenCalled()
    await app.close()
  })

  // ── Deferred rail (K5): a null ref is the NORMAL pre-session state, not a
  // crash window — the route serves the SDK bootstrap instead of a 409.
  it('deferred rail + null ref: serves the SDK bootstrap, never a session read', async () => {
    deferredInitiation.mockReturnValue(true)
    from.mockReturnValueOnce(chain({ data: transferRow })) // ref is null in the fixture
    const app = await buildApp()

    const res = await get(app)

    expect(res.status).toBe(200)
    expect(res.body).toEqual({ provider: 'stripe_crypto', publishableKey: 'pk_test_x' })
    expect(getClientSession).not.toHaveBeenCalled()
    await app.close()
  })

  it('deferred rail + live cos_ ref: passes the retrieved session through', async () => {
    deferredInitiation.mockReturnValue(true)
    from.mockReturnValueOnce(chain({ data: { ...transferRow, funding_payment_ref: 'cos_1' } }))
    getClientSession.mockResolvedValue({
      provider: 'stripe_crypto',
      fields: { clientSecret: 'cs_x', publishableKey: 'pk_test_x', status: 'requires_payment' },
    })
    const app = await buildApp()

    const res = await get(app)

    expect(res.status).toBe(200)
    expect(res.body).toEqual({
      provider: 'stripe_crypto',
      clientSecret: 'cs_x',
      publishableKey: 'pk_test_x',
      status: 'requires_payment',
    })
    expect(getClientSession).toHaveBeenCalledWith({ paymentRef: 'cos_1' })
    await app.close()
  })

  it('deferred rail + failing session read: degrades to the bootstrap, not a 500', async () => {
    // Embedded sessions are created under the user's OAuth token; whether the
    // platform-key read resolves them is a preview-API unknown. Sessions are
    // never resumed, so the bootstrap is a safe answer either way.
    deferredInitiation.mockReturnValue(true)
    from.mockReturnValueOnce(chain({ data: { ...transferRow, funding_payment_ref: 'cos_1' } }))
    getClientSession.mockRejectedValue(new Error('platform key cannot read user-scoped session'))
    const app = await buildApp()

    const res = await get(app)

    expect(res.status).toBe(200)
    expect(res.body).toEqual({ provider: 'stripe_crypto', publishableKey: 'pk_test_x' })
    await app.close()
  })

  it('503s when the active processor is unconfigured (prod mock lock posture)', async () => {
    isConfigured.mockReturnValueOnce(false)
    const app = await buildApp()
    const res = await get(app)
    expect(res.status).toBe(503)
    expect(res.body.error.code).toBe('not_configured')
    await app.close()
  })
})

describe('GET /v1/transfers/:id/receipt', () => {
  const get = (app: Awaited<ReturnType<typeof buildApp>>) =>
    supertest(app.server)
      .get(`/v1/transfers/${TRANSFER_ID}/receipt`)
      .set('Authorization', 'Bearer test-token')

  it('returns the receipt for a delivered, owned transfer', async () => {
    from
      .mockReturnValueOnce(chain({ data: { id: TRANSFER_ID } })) // owner check
      .mockReturnValueOnce(
        chain({
          data: {
            id: 'disc-receipt-1',
            transfer_id: TRANSFER_ID,
            type: 'receipt',
            locale: 'es',
            content: { version: 1, amounts: { totalMinor: 20000, receiveMinor: 396014 } },
            presented_at: '2026-07-22T00:00:00.000Z',
          },
        }),
      )
    const app = await buildApp()

    const res = await get(app)

    expect(res.status).toBe(200)
    expect(res.body).toMatchObject({
      id: 'disc-receipt-1',
      transferId: TRANSFER_ID,
      type: 'receipt',
      locale: 'es',
    })
    expect(res.body.content.amounts.totalMinor).toBe(20000)
    expect(res.body.presentedAt).toBe('2026-07-22T00:00:00.000Z')
    await app.close()
  })

  it('404s before COMPLETED — owned but no receipt yet', async () => {
    from
      .mockReturnValueOnce(chain({ data: { id: TRANSFER_ID } })) // owned
      .mockReturnValueOnce(chain({ data: null })) // no receipt row
    const app = await buildApp()
    const res = await get(app)
    expect(res.status).toBe(404)
    expect(res.body.error.code).toBe('not_found')
    await app.close()
  })

  it("404s a non-owner's transfer without loading the receipt", async () => {
    from.mockReturnValueOnce(chain({ data: null })) // owner check fails → stop
    const app = await buildApp()
    const res = await get(app)
    expect(res.status).toBe(404)
    // the disclosures query is never reached (owner check short-circuits)
    expect(from).toHaveBeenCalledTimes(1)
    await app.close()
  })

  it('401s without auth', async () => {
    const app = await buildApp()
    const res = await supertest(app.server).get(`/v1/transfers/${TRANSFER_ID}/receipt`)
    expect(res.status).toBe(401)
    await app.close()
  })
})

describe('GET /v1/transfers/:id/disclosure', () => {
  const get = (app: Awaited<ReturnType<typeof buildApp>>) =>
    supertest(app.server)
      .get(`/v1/transfers/${TRANSFER_ID}/disclosure`)
      .set('Authorization', 'Bearer test-token')

  it('returns the prepayment disclosure for an owned transfer', async () => {
    from
      .mockReturnValueOnce(chain({ data: { id: TRANSFER_ID } })) // owner check
      .mockReturnValueOnce(
        chain({
          data: {
            id: 'disc-prepay-1',
            transfer_id: TRANSFER_ID,
            type: 'prepayment',
            locale: 'es',
            content: {
              version: 1,
              amounts: { totalMinor: 20000, receiveMinor: 396014 },
              en: { title: 'Prepayment disclosure' },
              es: { title: 'Divulgación previa al pago' },
            },
            presented_at: '2026-07-23T00:00:00.000Z',
          },
        }),
      )
    const app = await buildApp()

    const res = await get(app)

    expect(res.status).toBe(200)
    expect(res.body).toMatchObject({
      id: 'disc-prepay-1',
      transferId: TRANSFER_ID,
      type: 'prepayment',
      locale: 'es',
    })
    expect(res.body.content.es.title).toBe('Divulgación previa al pago')
    expect(res.body.presentedAt).toBe('2026-07-23T00:00:00.000Z')
    await app.close()
  })

  it('404s when the transfer is owned but has no prepayment disclosure', async () => {
    from
      .mockReturnValueOnce(chain({ data: { id: TRANSFER_ID } })) // owned
      .mockReturnValueOnce(chain({ data: null })) // no disclosure row
    const app = await buildApp()
    const res = await get(app)
    expect(res.status).toBe(404)
    expect(res.body.error.code).toBe('not_found')
    await app.close()
  })

  it("404s a non-owner's transfer without loading the disclosure", async () => {
    from.mockReturnValueOnce(chain({ data: null })) // owner check fails → stop
    const app = await buildApp()
    const res = await get(app)
    expect(res.status).toBe(404)
    // the disclosures query is never reached (owner check short-circuits)
    expect(from).toHaveBeenCalledTimes(1)
    await app.close()
  })

  it('401s without auth', async () => {
    const app = await buildApp()
    const res = await supertest(app.server).get(`/v1/transfers/${TRANSFER_ID}/disclosure`)
    expect(res.status).toBe(401)
    await app.close()
  })
})

describe('POST /v1/transfers/:id/payment-claim', () => {
  const CLAIMED_AT = '2026-08-21T15:00:00.000Z'

  const claimRow = (over: Record<string, unknown> = {}) => ({
    id: TRANSFER_ID,
    state: 'PENDING_PAYMENT',
    funding_payment_ref: 'manualpay_1',
    payment_claimed_at: null,
    ...over,
  })

  // The route may hit `transfers` up to three times (read, conditional update,
  // race re-read) — queue one chain per call, in order.
  const queueTransfers = (...chains: ReturnType<typeof chain>[]) => {
    const remaining = [...chains]
    from.mockImplementation((table: unknown) => {
      if (table !== 'transfers') throw new Error(`unexpected from('${String(table)}')`)
      const next = remaining.shift()
      if (!next) throw new Error('transfers queried more times than the test queued')
      return next
    })
    return remaining
  }

  const post = (app: Awaited<ReturnType<typeof buildApp>>) =>
    supertest(app.server)
      .post(`/v1/transfers/${TRANSFER_ID}/payment-claim`)
      .set('Authorization', 'Bearer token')
      .send({})

  it('401s without auth', async () => {
    const app = await buildApp()
    const res = await supertest(app.server)
      .post(`/v1/transfers/${TRANSFER_ID}/payment-claim`)
      .send({})
    expect(res.status).toBe(401)
    await app.close()
  })

  it("404s a missing or non-owner transfer", async () => {
    queueTransfers(chain({ data: null }))
    const app = await buildApp()
    const res = await post(app)
    expect(res.status).toBe(404)
    await app.close()
  })

  it('scopes the read to the authenticated owner', async () => {
    const read = chain({ data: claimRow() })
    const update = chain({ data: { payment_claimed_at: CLAIMED_AT } })
    queueTransfers(read, update)
    const app = await buildApp()
    await post(app)
    expect(read.eq).toHaveBeenCalledWith('user_id', USER_ID)
    await app.close()
  })

  it('stamps the claim once and pages Sentry with a per-transfer fingerprint', async () => {
    const read = chain({ data: claimRow() })
    const update = chain({ data: { payment_claimed_at: CLAIMED_AT } })
    queueTransfers(read, update)
    const app = await buildApp()

    const res = await post(app)

    expect(res.status).toBe(200)
    expect(res.body).toEqual({ transferId: TRANSFER_ID, paymentClaimedAt: CLAIMED_AT })
    // Never a state change: the write touches payment_claimed_at and nothing
    // else, and no transition runs.
    expect(update.update).toHaveBeenCalledWith({ payment_claimed_at: expect.any(String) })
    expect(update.is).toHaveBeenCalledWith('payment_claimed_at', null)
    expect(update.eq).toHaveBeenCalledWith('state', 'PENDING_PAYMENT')
    expect(transitionTransfer).not.toHaveBeenCalled()
    expect(setFingerprint).toHaveBeenCalledWith(['payment-claim', TRANSFER_ID])
    expect(captureMessage).toHaveBeenCalledTimes(1)
    expect(captureMessage).toHaveBeenCalledWith(expect.any(String), 'info')
    await app.close()
  })

  it('replays the original timestamp on a second tap without writing or re-paging', async () => {
    queueTransfers(chain({ data: claimRow({ payment_claimed_at: CLAIMED_AT }) }))
    const app = await buildApp()

    const res = await post(app)

    expect(res.status).toBe(200)
    expect(res.body).toEqual({ transferId: TRANSFER_ID, paymentClaimedAt: CLAIMED_AT })
    expect(captureMessage).not.toHaveBeenCalled()
    await app.close()
  })

  it('still replays a recorded claim after the transfer advances past PENDING_PAYMENT', async () => {
    queueTransfers(
      chain({ data: claimRow({ state: 'COMPLETED', payment_claimed_at: CLAIMED_AT }) }),
    )
    const app = await buildApp()

    const res = await post(app)

    expect(res.status).toBe(200)
    expect(res.body).toEqual({ transferId: TRANSFER_ID, paymentClaimedAt: CLAIMED_AT })
    await app.close()
  })

  it('409s an unclaimed transfer that is no longer awaiting payment', async () => {
    const remaining = queueTransfers(chain({ data: claimRow({ state: 'FUNDED' }) }))
    const app = await buildApp()

    const res = await post(app)

    expect(res.status).toBe(409)
    expect(remaining).toHaveLength(0) // no update, no re-read
    expect(captureMessage).not.toHaveBeenCalled()
    await app.close()
  })

  it('409s an unconfirmed transfer (no funding ref — nothing to have paid against)', async () => {
    queueTransfers(chain({ data: claimRow({ funding_payment_ref: null }) }))
    const app = await buildApp()

    const res = await post(app)

    expect(res.status).toBe(409)
    await app.close()
  })

  it("returns the winner's stamp when it loses the double-tap race", async () => {
    queueTransfers(
      chain({ data: claimRow() }),
      chain({ data: null }), // conditional update matched 0 rows
      chain({ data: { payment_claimed_at: CLAIMED_AT } }), // winner's stamp on re-read
    )
    const app = await buildApp()

    const res = await post(app)

    expect(res.status).toBe(200)
    expect(res.body).toEqual({ transferId: TRANSFER_ID, paymentClaimedAt: CLAIMED_AT })
    // The loser must not page — only the write that actually stamped does.
    expect(captureMessage).not.toHaveBeenCalled()
    await app.close()
  })

  it('409s when the update lost because the state advanced, not because of a claim', async () => {
    queueTransfers(
      chain({ data: claimRow() }),
      chain({ data: null }), // update matched 0 rows
      chain({ data: { payment_claimed_at: null } }), // no claim landed either
    )
    const app = await buildApp()

    const res = await post(app)

    expect(res.status).toBe(409)
    expect(captureMessage).not.toHaveBeenCalled()
    await app.close()
  })
})
