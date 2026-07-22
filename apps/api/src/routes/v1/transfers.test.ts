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

vi.mock('../../services/funding/index.js', () => ({
  getFundingProcessor: () => ({ provider: 'mock', initiateFunding, voidFunding }),
}))

const { transfersRoute } = await import('./transfers.js')
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
  for (const m of ['select', 'insert', 'update', 'delete', 'eq', 'is', 'or', 'order', 'limit'] as const) {
    b[m] = vi.fn(() => b)
  }
  b['single'] = vi.fn(async () => resolved)
  b.then = (resolve) => resolve(resolved)
  return b
}

const QUOTE_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1'
const TRANSFER_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2'
const DISCLOSURE_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa3'
const FUTURE = '2036-01-01T00:00:00.000Z'

const approvedUser = {
  kyc_status: 'approved',
  bridge_customer_id: 'cust_1',
  preferred_language: 'es',
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
  initiateFunding.mockReset()
  voidFunding.mockReset()
  initiateFunding.mockResolvedValue({
    provider: 'mock',
    method: 'ach',
    paymentRef: 'mockpay_new',
    clientFields: {},
  })
  voidFunding.mockResolvedValue({ provider: 'mock', ref: 'mockvoid_test', status: 'succeeded' })
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
    await app.close()
  })

  it('schema-rejects accepted:false', async () => {
    routeTables()
    const app = await buildApp()
    const res = await confirm(app, { disclosureId: DISCLOSURE_ID, accepted: false })
    expect(res.status).toBe(400)
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
    '%s → 202 compliant support routing (en+es), never a flat denial',
    async (state) => {
      routeTables({ transfers: () => chain({ data: { ...fundedRow, state } }) })
      const app = await buildApp()
      const res = await cancel(app)
      expect(res.status).toBe(202)
      expect(res.body).toMatchObject({ id: TRANSFER_ID, state, code: 'cancellation_requires_support' })
      expect(res.body.messages.en).toMatch(/support/i)
      expect(res.body.messages.es).toMatch(/soporte/i)
      expect(cancelTransfer).not.toHaveBeenCalled()
      expect(voidFunding).not.toHaveBeenCalled()
      await app.close()
    },
  )

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
