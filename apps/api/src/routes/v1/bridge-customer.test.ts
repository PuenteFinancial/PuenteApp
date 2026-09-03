import { describe, it, expect, beforeEach, vi } from 'vitest'
import supertest from 'supertest'
import Fastify from 'fastify'
import fp from 'fastify-plugin'

const from = vi.fn()
vi.mock('../../services/supabase.js', () => ({
  supabaseAdmin: { from: (...args: unknown[]) => from(...args) },
}))

const createBridgeCustomerWithIdentity = vi.fn()
vi.mock('../../services/bridge.js', async () => {
  const actual = await vi.importActual<typeof import('../../services/bridge.js')>(
    '../../services/bridge.js',
  )
  return {
    ...actual,
    createBridgeCustomerWithIdentity: (...args: unknown[]) =>
      createBridgeCustomerWithIdentity(...args),
  }
})

const captureMessage = vi.fn()
const captureException = vi.fn()
vi.mock('@sentry/node', () => ({
  captureMessage: (...args: unknown[]) => captureMessage(...args),
  captureException: (...args: unknown[]) => captureException(...args),
}))

const { bridgeCustomerRoute, normalizeResidentialAddress, RELAY_RATE_LIMIT } = await import(
  './bridge-customer.js'
)
const { BridgeApiError } = await import('../../services/bridge.js')
const { SENSITIVE_KEY } = await import('../../config/sentry-scrub.js')
const { errorHandlerPlugin } = await import('../../plugins/error-handler.js')
const { auditPlugin } = await import('../../plugins/audit.js')

// Stand-in for the real JWT plugin. `Bearer other` is a second user so the
// per-user rate limit can be shown to isolate senders.
const mockAuth = fp(async (server) => {
  server.addHook('onRequest', async (request, reply) => {
    const auth = request.headers.authorization
    if (!auth?.startsWith('Bearer ')) {
      return reply.code(401).send({ error: 'Unauthorized' })
    }
    request.user = { id: auth === 'Bearer other' ? 'user-456' : 'user-123' }
  })
})

// The values invariant (c) hunts for. If either ever shows up in a log line,
// a Sentry call, or a response, the custody rule is broken.
const DOB = '1987-03-21'
const SSN = '078-05-1120'
const SSN_DIGITS = '078051120'
const validBody = { dob: DOB, taxId: { type: 'ssn', number: SSN } }

const baseUser = {
  id: 'user-123',
  first_name: 'Ana',
  last_name: 'García López',
  email: 'ana@example.com',
  phone: '+12125551234',
  kyc_status: 'not_started',
  bridge_customer_id: null as string | null,
  address_line1: ' 123  Main St ',
  address_line2: '',
  address_city: 'Denver',
  address_state: 'co',
  address_postal_code: '80202',
  stripe_kyc_tier: 'L1' as string | null,
  bridge_signed_agreement_id: 'agr-12345678' as string | null,
}

interface UsersTableOptions {
  row?: unknown
  selectError?: unknown
  /** Rows the guarded persist returns; [] = a concurrent writer won. */
  persisted?: unknown[] | null
  persistError?: unknown
  /** What the re-read after a lost race returns. */
  reread?: unknown
}

// users: select().eq().single() → update().eq().is().select() (guarded
// persist) or update().eq() awaited directly (pointer clear).
function usersTable(opts: UsersTableOptions = {}) {
  const single = vi
    .fn()
    .mockResolvedValueOnce({ data: opts.row ?? baseUser, error: opts.selectError ?? null })
    .mockResolvedValue({ data: opts.reread ?? null, error: null })
  const select = vi.fn((..._args: unknown[]) => ({ eq: vi.fn(() => ({ single })) }))
  const guardedSelect = vi.fn(async (..._args: unknown[]) => ({
    data: opts.persisted === undefined ? [{ bridge_customer_id: 'cust_new' }] : opts.persisted,
    error: opts.persistError ?? null,
  }))
  const is = vi.fn((..._args: unknown[]) => ({ select: guardedSelect }))
  const eqAfterUpdate = vi.fn((..._args: unknown[]) =>
    Object.assign(Promise.resolve({ error: null }), { is }),
  )
  const update = vi.fn((..._args: unknown[]) => ({ eq: eqAfterUpdate }))
  return { table: { select, update }, update, is, guardedSelect }
}

const insert = vi.fn(async (..._args: unknown[]) => ({ error: null }))

function fromByTable(users: ReturnType<typeof usersTable>) {
  from.mockImplementation((table: string) => {
    if (table === 'users') return users.table
    if (table === 'kyc_verifications') return { insert }
    return undefined
  })
}

async function buildApp(options: { rateLimit?: boolean; lines?: string[] } = {}) {
  const app = Fastify(
    options.lines
      ? {
          logger: {
            level: 'trace',
            stream: {
              write: (line: string) => {
                options.lines!.push(line)
              },
            },
          },
        }
      : { logger: false },
  )
  if (options.rateLimit) {
    const rateLimit = (await import('@fastify/rate-limit')).default
    await app.register(rateLimit, { max: 100, timeWindow: '1 minute' })
  }
  await app.register(errorHandlerPlugin)
  await app.register(auditPlugin)
  await app.register(mockAuth)
  await app.register(bridgeCustomerRoute, { prefix: '/v1' })
  await app.ready()
  return app
}

const relay = (app: Awaited<ReturnType<typeof buildApp>>, body: unknown = validBody, token = 'test-token') =>
  supertest(app.server)
    .post('/v1/users/me/bridge-customer')
    .set('Authorization', `Bearer ${token}`)
    .send(body as object)

beforeEach(() => {
  from.mockReset()
  createBridgeCustomerWithIdentity.mockReset()
  createBridgeCustomerWithIdentity.mockResolvedValue({ id: 'cust_new', status: 'incomplete' })
  captureMessage.mockReset()
  captureException.mockReset()
  insert.mockClear()
})

describe('normalizeResidentialAddress', () => {
  it('trims, collapses whitespace, uppercases the state, and nulls an empty line 2', () => {
    expect(normalizeResidentialAddress(baseUser)).toEqual({
      streetLine1: '123 Main St',
      streetLine2: null,
      city: 'Denver',
      subdivision: 'CO',
      postalCode: '80202',
    })
    expect(normalizeResidentialAddress({ ...baseUser, address_line2: '  Apt   4 ' }).streetLine2).toBe('Apt 4')
  })
})

describe('POST /v1/users/me/bridge-customer — preconditions', () => {
  it('returns 401 without a token', async () => {
    const app = await buildApp()
    const res = await supertest(app.server).post('/v1/users/me/bridge-customer').send(validBody)
    expect(res.status).toBe(401)
    await app.close()
  })

  it('400s malformed identity without touching Bridge or echoing the value', async () => {
    fromByTable(usersTable())
    const app = await buildApp()
    for (const body of [
      { dob: '03/21/1987', taxId: { type: 'ssn', number: SSN } },
      { dob: DOB, taxId: { type: 'ssn', number: '12345' } },
      { dob: DOB, taxId: { type: 'passport', number: SSN } },
      { dob: DOB },
      { taxId: { type: 'ssn', number: SSN } },
    ]) {
      const res = await relay(app, body)
      expect(res.status, JSON.stringify(body)).toBe(400)
      expect(res.body.error.code).toBe('validation_error')
      expect(JSON.stringify(res.body)).not.toContain(SSN)
      expect(JSON.stringify(res.body)).not.toContain(DOB)
    }
    expect(createBridgeCustomerWithIdentity).not.toHaveBeenCalled()
    await app.close()
  })

  it('404s when the user row is missing', async () => {
    fromByTable(usersTable({ row: null, selectError: { code: 'PGRST116' } }))
    const app = await buildApp()
    const res = await relay(app)
    expect(res.status).toBe(404)
    await app.close()
  })

  it('403 forbidden until the profile (incl. address) is complete', async () => {
    fromByTable(usersTable({ row: { ...baseUser, address_line1: null } }))
    const app = await buildApp()
    const res = await relay(app)
    expect(res.status).toBe(403)
    expect(res.body.error.code).toBe('forbidden')
    expect(createBridgeCustomerWithIdentity).not.toHaveBeenCalled()
    await app.close()
  })

  it('200 no-op when a Bridge customer already exists — Bridge is never called twice', async () => {
    fromByTable(
      usersTable({ row: { ...baseUser, bridge_customer_id: 'cust_old', kyc_status: 'approved', stripe_kyc_tier: null } }),
    )
    const app = await buildApp()
    const res = await relay(app)
    expect(res.status).toBe(200)
    expect(res.body).toEqual({ bridgeCustomerId: 'cust_old', status: 'approved' })
    expect(createBridgeCustomerWithIdentity).not.toHaveBeenCalled()
    expect(insert).not.toHaveBeenCalled()
    await app.close()
  })

  it('403 kyc_required until Stripe L1 is verified (tier column, not status)', async () => {
    for (const tier of [null, 'L0', 'pending']) {
      fromByTable(usersTable({ row: { ...baseUser, stripe_kyc_tier: tier } }))
      const app = await buildApp()
      const res = await relay(app)
      expect(res.status, String(tier)).toBe(403)
      expect(res.body.error.code).toBe('kyc_required')
      await app.close()
    }
    expect(createBridgeCustomerWithIdentity).not.toHaveBeenCalled()
  })

  it('409 conflict (bridge_tos) until the ToS pointer exists', async () => {
    fromByTable(usersTable({ row: { ...baseUser, bridge_signed_agreement_id: null } }))
    const app = await buildApp()
    const res = await relay(app)
    expect(res.status).toBe(409)
    expect(res.body.error.code).toBe('conflict')
    expect(res.body.error.details).toEqual([{ path: 'bridge_tos', issue: 'required' }])
    expect(createBridgeCustomerWithIdentity).not.toHaveBeenCalled()
    await app.close()
  })
})

describe('POST /v1/users/me/bridge-customer — the relay', () => {
  it('creates the customer from the relayed values + stored profile, persists guarded, logs the verdict', async () => {
    const users = usersTable()
    fromByTable(users)
    const app = await buildApp()

    const res = await relay(app)

    expect(res.status).toBe(200)
    expect(res.body).toEqual({ bridgeCustomerId: 'cust_new', status: 'pending' })
    expect(Object.keys(res.body)).toEqual(['bridgeCustomerId', 'status'])

    expect(createBridgeCustomerWithIdentity).toHaveBeenCalledWith({
      userId: 'user-123',
      firstName: 'Ana',
      lastName: 'García López',
      email: 'ana@example.com',
      signedAgreementId: 'agr-12345678',
      birthDate: DOB,
      address: { streetLine1: '123 Main St', streetLine2: null, city: 'Denver', subdivision: 'CO', postalCode: '80202' },
      taxId: { type: 'ssn', number: SSN },
    })
    expect(users.update).toHaveBeenCalledWith({
      bridge_customer_id: 'cust_new',
      kyc_status: 'pending',
      bridge_signed_agreement_id: null,
    })
    expect(users.is).toHaveBeenCalledWith('bridge_customer_id', null)
    expect(insert).toHaveBeenCalledWith(
      expect.objectContaining({
        user_id: 'user-123',
        provider: 'bridge',
        provider_ref: 'cust_new',
        status: 'pending',
        provider_status: 'incomplete',
        source: 'relay',
      }),
    )
    await app.close()
  })

  it('maps an already-active create response onto approved/verified', async () => {
    createBridgeCustomerWithIdentity.mockResolvedValue({ id: 'cust_new', status: 'active' })
    const users = usersTable()
    fromByTable(users)
    const app = await buildApp()
    const res = await relay(app)
    expect(res.body.status).toBe('approved')
    expect(users.update).toHaveBeenCalledWith(expect.objectContaining({ kyc_status: 'approved' }))
    expect(insert).toHaveBeenCalledWith(expect.objectContaining({ status: 'verified', provider_status: 'active' }))
    await app.close()
  })

  it('relays an ITIN as its own type', async () => {
    fromByTable(usersTable())
    const app = await buildApp()
    const res = await relay(app, { dob: DOB, taxId: { type: 'itin', number: '912-34-5678' } })
    expect(res.status).toBe(200)
    expect(createBridgeCustomerWithIdentity).toHaveBeenCalledWith(
      expect.objectContaining({ taxId: { type: 'itin', number: '912-34-5678' } }),
    )
    await app.close()
  })

  it('409 duplicate_identity on a Bridge duplicate — nothing persisted (decision 9)', async () => {
    createBridgeCustomerWithIdentity.mockRejectedValue(
      new BridgeApiError(400, { code: 'invalid_parameters', source: { key: { email: 'has already been taken' } } }),
    )
    const users = usersTable()
    fromByTable(users)
    const app = await buildApp()
    const res = await relay(app)
    expect(res.status).toBe(409)
    expect(res.body.error.code).toBe('duplicate_identity')
    expect(users.update).not.toHaveBeenCalled()
    expect(insert).not.toHaveBeenCalled()
    await app.close()
  })

  it('409 conflict (signed_agreement_id) on a consumed agreement — clears the pointer so ToS re-runs', async () => {
    createBridgeCustomerWithIdentity.mockRejectedValue(
      new BridgeApiError(400, { code: 'invalid_parameters', message: 'signed_agreement_id has already been used' }),
    )
    const users = usersTable()
    fromByTable(users)
    const app = await buildApp()
    const res = await relay(app)
    expect(res.status).toBe(409)
    expect(res.body.error.code).toBe('conflict')
    expect(res.body.error.details).toEqual([{ path: 'signed_agreement_id', issue: 'consumed' }])
    expect(users.update).toHaveBeenCalledWith({ bridge_signed_agreement_id: null })
    await app.close()
  })

  it('422 provider_rejected on any other Bridge 4xx (the one correction attempt)', async () => {
    createBridgeCustomerWithIdentity.mockRejectedValue(
      new BridgeApiError(400, { code: 'invalid_parameters', message: 'birth_date is invalid' }),
    )
    fromByTable(usersTable())
    const app = await buildApp()
    const res = await relay(app)
    expect(res.status).toBe(422)
    expect(res.body.error.code).toBe('provider_rejected')
    await app.close()
  })

  it('502 provider_unavailable on Bridge 5xx, timeouts, and unexpected throws', async () => {
    for (const failure of [
      new BridgeApiError(503, null),
      new DOMException('The operation was aborted due to timeout', 'TimeoutError'),
      new TypeError('fetch failed'),
    ]) {
      createBridgeCustomerWithIdentity.mockRejectedValue(failure)
      fromByTable(usersTable())
      const app = await buildApp()
      const res = await relay(app)
      expect(res.status, String(failure)).toBe(502)
      expect(res.body.error.code).toBe('provider_unavailable')
      await app.close()
    }
  })

  it('500 when the guarded persist errors — the customer exists, a retry replays the key', async () => {
    fromByTable(usersTable({ persistError: { code: 'XX000' } }))
    const app = await buildApp()
    const res = await relay(app)
    expect(res.status).toBe(500)
    expect(insert).not.toHaveBeenCalled()
    await app.close()
  })

  it('reports the stored id and pages an orphan when a concurrent relay won the persist', async () => {
    fromByTable(usersTable({ persisted: [], reread: { bridge_customer_id: 'cust_first' } }))
    const app = await buildApp()
    const res = await relay(app)
    expect(res.status).toBe(200)
    expect(res.body.bridgeCustomerId).toBe('cust_first')
    expect(captureMessage).toHaveBeenCalledTimes(1)
    expect(captureMessage.mock.calls[0]![1]).toMatchObject({
      fingerprint: ['bridge-customer-orphan'],
      extra: { userId: 'user-123', storedCustomerId: 'cust_first', orphanCustomerId: 'cust_new' },
    })
    // The scrubber works by key name: every extra key this route ever sets
    // must be one the scrubber would leave alone, i.e. never a value slot
    // for the request body.
    const extra = (captureMessage.mock.calls[0]![1] as { extra: Record<string, unknown> }).extra
    for (const key of Object.keys(extra)) expect(SENSITIVE_KEY.test(key), key).toBe(false)
    for (const value of Object.values(extra)) expect(typeof value).toBe('string')
    await app.close()
  })

  it('does not page when the concurrent writer stored the same id (idempotent replay)', async () => {
    fromByTable(usersTable({ persisted: [], reread: { bridge_customer_id: 'cust_new' } }))
    const app = await buildApp()
    const res = await relay(app)
    expect(res.status).toBe(200)
    expect(res.body.bridgeCustomerId).toBe('cust_new')
    expect(captureMessage).not.toHaveBeenCalled()
    await app.close()
  })

  it('is rate-limited per user, and one sender cannot exhaust another', async () => {
    fromByTable(usersTable({ row: { ...baseUser, bridge_customer_id: 'cust_old' } }))
    // The no-op path re-reads the row each call; single() is mocked once per
    // table build, so rebuild per request.
    const app = await buildApp({ rateLimit: true })
    for (let i = 0; i < RELAY_RATE_LIMIT.max; i++) {
      fromByTable(usersTable({ row: { ...baseUser, bridge_customer_id: 'cust_old' } }))
      const res = await relay(app)
      expect(res.status, `call ${i + 1}`).toBe(200)
    }
    fromByTable(usersTable({ row: { ...baseUser, bridge_customer_id: 'cust_old' } }))
    const throttled = await relay(app)
    expect(throttled.status).toBe(429)

    fromByTable(usersTable({ row: { ...baseUser, id: 'user-456', bridge_customer_id: 'cust_other' } }))
    const other = await relay(app, validBody, 'other')
    expect(other.status).toBe(200)
    await app.close()
  })
})

// Invariant (c): the relay's values never reach a log line or Sentry — on
// the validation path, the provider-failure path, or the happy path.
describe('POST /v1/users/me/bridge-customer — nothing logs the identity', () => {
  it('trace-level logger + audit + error handler capture no DOB / tax ID', async () => {
    const lines: string[] = []
    const app = await buildApp({ lines })

    fromByTable(usersTable())
    await relay(app, { dob: DOB, taxId: { type: 'ssn', number: '12' } })

    createBridgeCustomerWithIdentity.mockRejectedValueOnce(
      new BridgeApiError(400, { code: 'invalid_parameters', message: `number ${SSN} is invalid for ${DOB}` }),
    )
    fromByTable(usersTable())
    await relay(app)

    createBridgeCustomerWithIdentity.mockRejectedValueOnce(new Error(`socket closed while sending ${SSN_DIGITS}`))
    fromByTable(usersTable())
    await relay(app)

    createBridgeCustomerWithIdentity.mockResolvedValueOnce({ id: 'cust_new', status: 'incomplete' })
    fromByTable(usersTable())
    const ok = await relay(app)
    expect(ok.status).toBe(200)

    expect(lines.length).toBeGreaterThan(0)
    const all = lines.join('\n') + JSON.stringify(captureMessage.mock.calls) + JSON.stringify(captureException.mock.calls)
    expect(all).not.toContain(DOB)
    expect(all).not.toContain(SSN)
    expect(all).not.toContain(SSN_DIGITS)
    expect(all).not.toContain('1987')
    await app.close()
  })
})
