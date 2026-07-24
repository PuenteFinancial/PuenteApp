import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import supertest from 'supertest'
import Fastify from 'fastify'
import fp from 'fastify-plugin'

const from = vi.fn()

vi.mock('../../services/supabase.js', () => ({
  supabaseAdmin: { from: (...args: unknown[]) => from(...args) },
}))

const transitionTransfer = vi.fn()

vi.mock('../../services/transfers.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../services/transfers.js')>()
  return {
    ...actual,
    transitionTransfer: (...args: unknown[]) => transitionTransfer(...args),
  }
})

const enqueuePayoutSubmit = vi.hoisted(() => vi.fn())
vi.mock('../../services/queue.js', () => ({
  enqueuePayoutSubmit: (...args: unknown[]) => enqueuePayoutSubmit(...args),
  enqueuePaymentEventProcess: vi.fn(),
}))

vi.mock('../../services/payment-events.js', () => ({ recordEvent: vi.fn() }))

// NOTE: services/funding is deliberately NOT mocked. The whole point of this
// endpoint is that it signs an event the REAL MockFundingProcessor verifies, so
// the round-trip through the real webhook route is the assertion.
const { devRoute } = await import('./dev.js')
const { webhooksRoute } = await import('./webhooks.js')
const { env } = await import('../../config/env.js')

const mockAuth = fp(async (server) => {
  server.addHook('onRequest', async (request, reply) => {
    if (request.routeOptions?.config?.public) return
    if (!request.headers.authorization?.startsWith('Bearer ')) {
      return reply.code(401).send({ error: 'Unauthorized' })
    }
    request.user = { id: 'user-123' }
  })
})

// Returns the chain builder itself so tests can assert WHICH filters ran — a
// test that only stubs `{data: null}` and expects 404 passes even if the
// owner-scoping .eq() is deleted.
function chain(result: { data?: unknown; error?: unknown }) {
  const resolved = { data: result.data ?? null, error: result.error ?? null }
  const b: Record<string, ReturnType<typeof vi.fn>> = {} as never
  for (const m of ['select', 'insert', 'update', 'eq', 'is', 'order', 'limit'] as const) {
    b[m] = vi.fn(() => b)
  }
  b['single'] = vi.fn(async () => resolved)
  return b
}

const TRANSFER_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2'
const PAYMENT_REF = 'mockpay_minted_at_confirm'

// A confirmed, unfunded transfer — the only state funding may be simulated for.
const confirmedTransfer = {
  id: TRANSFER_ID,
  state: 'PENDING_PAYMENT',
  funding_payment_ref: PAYMENT_REF,
}

// What the webhook route re-reads for the FUNDED transition + ledger batch.
const transferForWebhook = {
  id: TRANSFER_ID,
  state: 'PENDING_PAYMENT',
  send_amount_minor: 10_000,
  fee_amount_minor: 250,
}

async function buildApp() {
  const app = Fastify({ logger: false })
  await app.register(mockAuth)
  await app.register(devRoute, { prefix: '/v1' })
  await app.register(webhooksRoute, { prefix: '/v1' })
  await app.ready()
  return app
}

function post(app: Awaited<ReturnType<typeof buildApp>>, id = TRANSFER_ID) {
  return supertest(app.server)
    .post(`/v1/dev/transfers/${id}/simulate-funding`)
    .set('Authorization', 'Bearer test-token')
}

const originalEnabled = env.ENABLE_DEV_ENDPOINTS
const originalSecret = env.MOCK_FUNDING_WEBHOOK_SECRET

beforeEach(() => {
  from.mockReset()
  transitionTransfer.mockReset()
  transitionTransfer.mockResolvedValue({ id: TRANSFER_ID, state: 'FUNDED' })
  enqueuePayoutSubmit.mockReset()
  enqueuePayoutSubmit.mockResolvedValue(undefined)
  // Tests run with the gate OPEN so the happy paths are reachable; the two
  // lock tests close each control independently.
  env.ENABLE_DEV_ENDPOINTS = true
})

afterEach(() => {
  env.ENABLE_DEV_ENDPOINTS = originalEnabled
  env.MOCK_FUNDING_WEBHOOK_SECRET = originalSecret
})

describe('POST /v1/dev/transfers/:id/simulate-funding', () => {
  it('drives the transfer to FUNDED through the real funding webhook', async () => {
    from.mockReturnValueOnce(chain({ data: confirmedTransfer }))
    from.mockReturnValueOnce(chain({ data: transferForWebhook }))
    const app = await buildApp()

    const res = await post(app)

    expect(res.status).toBe(200)
    expect(res.body).toEqual({ simulated: true })
    // The transition ran inside the webhook route, reached via the app's own
    // router — proving the generated signature passed real verification.
    expect(transitionTransfer).toHaveBeenCalledWith(
      expect.objectContaining({
        transferId: TRANSFER_ID,
        fromState: 'PENDING_PAYMENT',
        toState: 'FUNDED',
        actor: 'webhook:funding',
      }),
    )
    expect(enqueuePayoutSubmit).toHaveBeenCalledWith(TRANSFER_ID)
  })

  it('echoes the confirm-time payment ref instead of minting a new one', async () => {
    // A freshly-minted ref would be written back over the real one by the
    // webhook's fundingPaymentRef update, silently corrupting the transfer.
    from.mockReturnValueOnce(chain({ data: confirmedTransfer }))
    from.mockReturnValueOnce(chain({ data: transferForWebhook }))
    const app = await buildApp()

    await post(app)

    expect(transitionTransfer).toHaveBeenCalledWith(
      expect.objectContaining({ fundingPaymentRef: PAYMENT_REF }),
    )
  })

  it('404s unless dev endpoints are explicitly enabled', async () => {
    // Fail-closed: the default is off, so an environment that never sets the
    // var (production) can't serve this route.
    env.ENABLE_DEV_ENDPOINTS = false
    const app = await buildApp()

    const res = await post(app)

    expect(res.status).toBe(404)
    expect(res.body.error.code).toBe('not_found')
    expect(from).not.toHaveBeenCalled()
  })

  it('404s when the mock funding secret is not provisioned', async () => {
    // The second, independent control — enabling dev endpoints is not enough.
    env.MOCK_FUNDING_WEBHOOK_SECRET = undefined
    const app = await buildApp()

    const res = await post(app)

    expect(res.status).toBe(404)
    expect(from).not.toHaveBeenCalled()
  })

  it('scopes the transfer lookup to the calling user', async () => {
    // Asserts the FILTER, not just that an empty result 404s: a test that only
    // stubs {data: null} still passes with the owner-scoping .eq() removed,
    // which would let anyone fund another user's transfer on shared staging.
    const q = chain({ data: confirmedTransfer })
    from.mockReturnValueOnce(q)
    from.mockReturnValueOnce(chain({ data: transferForWebhook }))
    const app = await buildApp()

    await post(app)

    expect(q.eq).toHaveBeenCalledWith('id', TRANSFER_ID)
    expect(q.eq).toHaveBeenCalledWith('user_id', 'user-123')
  })

  it('404s for a transfer belonging to another user', async () => {
    // The owner-scoped query simply returns nothing for a non-owner.
    from.mockReturnValueOnce(chain({ data: null }))
    const app = await buildApp()

    const res = await post(app)

    expect(res.status).toBe(404)
    expect(transitionTransfer).not.toHaveBeenCalled()
  })

  it('500s rather than 404s when the lookup itself fails', async () => {
    // A DB fault reported as "Transfer not found" sends an engineer hunting a
    // transfer that is sitting right there.
    from.mockReturnValueOnce(chain({ data: null, error: { code: '57014' } }))
    const app = await buildApp()

    const res = await post(app)

    expect(res.status).toBe(500)
    expect(transitionTransfer).not.toHaveBeenCalled()
  })

  it('409s when the transfer has already been funded', async () => {
    from.mockReturnValueOnce(chain({ data: { ...confirmedTransfer, state: 'FUNDED' } }))
    const app = await buildApp()

    const res = await post(app)

    expect(res.status).toBe(409)
    expect(res.body.error.code).toBe('conflict')
    expect(transitionTransfer).not.toHaveBeenCalled()
  })

  it('409s when the transfer has not been confirmed', async () => {
    // No funding_payment_ref means the sender never accepted the disclosure.
    from.mockReturnValueOnce(chain({ data: { ...confirmedTransfer, funding_payment_ref: null } }))
    const app = await buildApp()

    const res = await post(app)

    expect(res.status).toBe(409)
    expect(transitionTransfer).not.toHaveBeenCalled()
  })

  it('401s without a session', async () => {
    const app = await buildApp()

    const res = await supertest(app.server).post(
      `/v1/dev/transfers/${TRANSFER_ID}/simulate-funding`,
    )

    expect(res.status).toBe(401)
    expect(from).not.toHaveBeenCalled()
  })
})
