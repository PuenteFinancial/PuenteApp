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

vi.mock('../../services/transfers.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../services/transfers.js')>()
  return {
    ...actual,
    createTransferFromQuote: (...args: unknown[]) => createTransferFromQuote(...args),
  }
})

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
  funding_payment_ref: null,
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
