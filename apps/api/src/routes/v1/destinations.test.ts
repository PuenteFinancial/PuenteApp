import { describe, it, expect, beforeEach, vi } from 'vitest'
import supertest from 'supertest'
import Fastify from 'fastify'
import fp from 'fastify-plugin'

import { decryptString } from '../../utils/encryption.js'

const from = vi.fn()

vi.mock('../../services/supabase.js', () => ({
  supabaseAdmin: {
    from: (...args: unknown[]) => from(...args),
  },
}))

const createExternalAccount = vi.fn()

vi.mock('../../services/bridge.js', async () => {
  const actual = await vi.importActual<typeof import('../../services/bridge.js')>(
    '../../services/bridge.js',
  )
  return {
    BridgeApiError: actual.BridgeApiError,
    createExternalAccount: (...args: unknown[]) => createExternalAccount(...args),
  }
})

const { destinationsRoute } = await import('./destinations.js')
const { BridgeApiError } = await import('../../services/bridge.js')

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
  for (const m of ['select', 'insert', 'update', 'eq', 'or', 'order', 'limit'] as const) {
    b[m] = vi.fn(() => b)
  }
  b['single'] = vi.fn(async () => resolved)
  b.then = (resolve) => resolve(resolved)
  return b
}

const RECIPIENT_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const DESTINATION_ID = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd'
const CLABE = '646180003000000006'

const approvedUser = { kyc_status: 'approved', bridge_customer_id: 'cust_1' }
const recipientRow = {
  id: RECIPIENT_ID,
  first_name: 'María del Carmen',
  last_name: 'García López',
  country: 'MX',
  status: 'active',
}

const destinationRow = {
  id: DESTINATION_ID,
  recipient_id: RECIPIENT_ID,
  method: 'bank_account',
  currency: 'MXN',
  details: { clabe_ciphertext: 'v1.zzz.zzz.zzz', clabe_last4: '0006' },
  label: 'BBVA',
  status: 'active',
  verification_status: 'unverified',
  created_at: '2026-07-16T12:00:00.000Z',
  updated_at: '2026-07-16T12:00:00.000Z',
}

const validBody = {
  method: 'bank_account',
  currency: 'MXN',
  details: { clabe: CLABE },
  label: 'BBVA',
}

async function buildApp() {
  const app = Fastify({ logger: false })
  await app.register(mockAuth)
  await app.register(destinationsRoute, { prefix: '/v1' })
  await app.ready()
  return app
}

beforeEach(() => {
  from.mockReset()
  createExternalAccount.mockReset()
})

describe('POST /v1/recipients/:id/destinations', () => {
  it('registers with Bridge then persists an encrypted row (happy path)', async () => {
    const users = chain({ data: approvedUser })
    const recipients = chain({ data: recipientRow })
    const insert = chain({ data: destinationRow })
    from.mockReturnValueOnce(users).mockReturnValueOnce(recipients).mockReturnValueOnce(insert)
    createExternalAccount.mockResolvedValue({ id: 'ea_123' })
    const app = await buildApp()

    const res = await supertest(app.server)
      .post(`/v1/recipients/${RECIPIENT_ID}/destinations`)
      .set('Authorization', 'Bearer test-token')
      .send(validBody)

    expect(res.status).toBe(201)
    expect(createExternalAccount).toHaveBeenCalledWith('cust_1', {
      firstName: 'María del Carmen',
      lastName: 'García López',
      clabe: CLABE,
    })

    // the inserted payload is really encrypted (round-trips with AAD =
    // recipient id) and never sets verification_status
    const inserted = (insert['insert'] as ReturnType<typeof vi.fn>).mock.calls[0]![0] as {
      recipient_id: string
      details: { clabe_ciphertext: string; clabe_last4: string }
      provider_account_ref: string
      verification_status?: string
    }
    expect(inserted.recipient_id).toBe(RECIPIENT_ID)
    expect(inserted.provider_account_ref).toBe('ea_123')
    expect(inserted.details.clabe_last4).toBe('0006')
    expect(inserted.details.clabe_ciphertext).not.toContain(CLABE)
    expect(decryptString(inserted.details.clabe_ciphertext, RECIPIENT_ID)).toBe(CLABE)
    expect(inserted.verification_status).toBeUndefined()

    // the response carries the masked form only
    expect(res.body.details).toEqual({ clabeLast4: '0006' })
    const serialized = JSON.stringify(res.body)
    expect(serialized).not.toContain(CLABE)
    expect(serialized).not.toContain('ciphertext')
    await app.close()
  })

  it('403s before Bridge when KYC is not approved', async () => {
    from.mockReturnValueOnce(chain({ data: { kyc_status: 'pending', bridge_customer_id: null } }))
    const app = await buildApp()

    const res = await supertest(app.server)
      .post(`/v1/recipients/${RECIPIENT_ID}/destinations`)
      .set('Authorization', 'Bearer test-token')
      .send(validBody)

    expect(res.status).toBe(403)
    expect(createExternalAccount).not.toHaveBeenCalled()
    await app.close()
  })

  it('403s before Bridge when the user has no bridge_customer_id', async () => {
    from.mockReturnValueOnce(chain({ data: { kyc_status: 'approved', bridge_customer_id: null } }))
    const app = await buildApp()

    const res = await supertest(app.server)
      .post(`/v1/recipients/${RECIPIENT_ID}/destinations`)
      .set('Authorization', 'Bearer test-token')
      .send(validBody)

    expect(res.status).toBe(403)
    expect(createExternalAccount).not.toHaveBeenCalled()
    await app.close()
  })

  it("404s before Bridge on another user's recipient", async () => {
    from
      .mockReturnValueOnce(chain({ data: approvedUser }))
      .mockReturnValueOnce(chain({ data: null, error: { code: 'PGRST116' } }))
    const app = await buildApp()

    const res = await supertest(app.server)
      .post(`/v1/recipients/${RECIPIENT_ID}/destinations`)
      .set('Authorization', 'Bearer test-token')
      .send(validBody)

    expect(res.status).toBe(404)
    expect(createExternalAccount).not.toHaveBeenCalled()
    await app.close()
  })

  it('409s on an archived recipient', async () => {
    from
      .mockReturnValueOnce(chain({ data: approvedUser }))
      .mockReturnValueOnce(chain({ data: { ...recipientRow, status: 'archived' } }))
    const app = await buildApp()

    const res = await supertest(app.server)
      .post(`/v1/recipients/${RECIPIENT_ID}/destinations`)
      .set('Authorization', 'Bearer test-token')
      .send(validBody)

    expect(res.status).toBe(409)
    expect(createExternalAccount).not.toHaveBeenCalled()
    await app.close()
  })

  it.each([
    ['non-MX recipient', recipientRow, { ...validBody }, 'US'],
    ['wallet method', recipientRow, { ...validBody, method: 'wallet' }, 'MX'],
    ['non-MXN currency', recipientRow, { ...validBody, currency: 'USD' }, 'MX'],
  ])('400s before Bridge on unsupported combo: %s', async (_name, recipient, body, country) => {
    from
      .mockReturnValueOnce(chain({ data: approvedUser }))
      .mockReturnValueOnce(chain({ data: { ...recipient, country } }))
    const app = await buildApp()

    const res = await supertest(app.server)
      .post(`/v1/recipients/${RECIPIENT_ID}/destinations`)
      .set('Authorization', 'Bearer test-token')
      .send(body)

    expect(res.status).toBe(400)
    expect(res.body.error).toContain('not yet supported')
    expect(createExternalAccount).not.toHaveBeenCalled()
    await app.close()
  })

  it.each([
    ['bad check digit', '646180003000000007'],
    ['17 digits', '64618000300000000'],
    ['missing clabe', undefined],
  ])('400s before Bridge on invalid CLABE (%s) without echoing it', async (_name, clabe) => {
    from
      .mockReturnValueOnce(chain({ data: approvedUser }))
      .mockReturnValueOnce(chain({ data: recipientRow }))
    const app = await buildApp()

    const res = await supertest(app.server)
      .post(`/v1/recipients/${RECIPIENT_ID}/destinations`)
      .set('Authorization', 'Bearer test-token')
      .send({ ...validBody, details: clabe ? { clabe } : {} })

    expect(res.status).toBe(400)
    if (clabe) expect(JSON.stringify(res.body)).not.toContain(clabe)
    expect(createExternalAccount).not.toHaveBeenCalled()
    await app.close()
  })

  it('maps Bridge 4xx to 422 and never inserts', async () => {
    from
      .mockReturnValueOnce(chain({ data: approvedUser }))
      .mockReturnValueOnce(chain({ data: recipientRow }))
    createExternalAccount.mockRejectedValue(new BridgeApiError(400, { code: 'invalid_clabe' }))
    const app = await buildApp()

    const res = await supertest(app.server)
      .post(`/v1/recipients/${RECIPIENT_ID}/destinations`)
      .set('Authorization', 'Bearer test-token')
      .send(validBody)

    expect(res.status).toBe(422)
    expect(from).toHaveBeenCalledTimes(2) // users + recipients, never payout_destinations
    await app.close()
  })

  it('maps Bridge 5xx to 502 and never inserts', async () => {
    from
      .mockReturnValueOnce(chain({ data: approvedUser }))
      .mockReturnValueOnce(chain({ data: recipientRow }))
    createExternalAccount.mockRejectedValue(new BridgeApiError(503, null))
    const app = await buildApp()

    const res = await supertest(app.server)
      .post(`/v1/recipients/${RECIPIENT_ID}/destinations`)
      .set('Authorization', 'Bearer test-token')
      .send(validBody)

    expect(res.status).toBe(502)
    expect(from).toHaveBeenCalledTimes(2)
    await app.close()
  })

  it('maps a network failure (fetch TypeError) to 502, not a raw 500', async () => {
    from
      .mockReturnValueOnce(chain({ data: approvedUser }))
      .mockReturnValueOnce(chain({ data: recipientRow }))
    createExternalAccount.mockRejectedValue(new TypeError('fetch failed'))
    const app = await buildApp()

    const res = await supertest(app.server)
      .post(`/v1/recipients/${RECIPIENT_ID}/destinations`)
      .set('Authorization', 'Bearer test-token')
      .send(validBody)

    expect(res.status).toBe(502)
    await app.close()
  })

  it('409s when the Bridge account is already saved (unique violation)', async () => {
    from
      .mockReturnValueOnce(chain({ data: approvedUser }))
      .mockReturnValueOnce(chain({ data: recipientRow }))
      .mockReturnValueOnce(chain({ data: null, error: { code: '23505' } }))
    createExternalAccount.mockResolvedValue({ id: 'ea_123' })
    const app = await buildApp()

    const res = await supertest(app.server)
      .post(`/v1/recipients/${RECIPIENT_ID}/destinations`)
      .set('Authorization', 'Bearer test-token')
      .send(validBody)

    expect(res.status).toBe(409)
    expect(res.body.error).toContain('already saved')
    await app.close()
  })

  it('500s on other insert failures (orphaned Bridge account, by policy)', async () => {
    from
      .mockReturnValueOnce(chain({ data: approvedUser }))
      .mockReturnValueOnce(chain({ data: recipientRow }))
      .mockReturnValueOnce(chain({ data: null, error: { code: 'XX000' } }))
    createExternalAccount.mockResolvedValue({ id: 'ea_123' })
    const app = await buildApp()

    const res = await supertest(app.server)
      .post(`/v1/recipients/${RECIPIENT_ID}/destinations`)
      .set('Authorization', 'Bearer test-token')
      .send(validBody)

    expect(res.status).toBe(500)
    await app.close()
  })
})

describe('GET /v1/recipients/:id/destinations', () => {
  it('lists active destinations in masked form only', async () => {
    from
      .mockReturnValueOnce(chain({ data: { id: RECIPIENT_ID } }))
      .mockReturnValueOnce(chain({ data: [destinationRow] }))
    const app = await buildApp()

    const res = await supertest(app.server)
      .get(`/v1/recipients/${RECIPIENT_ID}/destinations`)
      .set('Authorization', 'Bearer test-token')

    expect(res.status).toBe(200)
    expect(res.body.data).toHaveLength(1)
    expect(res.body.data[0].details).toEqual({ clabeLast4: '0006' })
    expect(JSON.stringify(res.body)).not.toContain('ciphertext')
    await app.close()
  })

  it("404s on another user's recipient", async () => {
    from.mockReturnValueOnce(chain({ data: null, error: { code: 'PGRST116' } }))
    const app = await buildApp()

    const res = await supertest(app.server)
      .get(`/v1/recipients/${RECIPIENT_ID}/destinations`)
      .set('Authorization', 'Bearer test-token')

    expect(res.status).toBe(404)
    await app.close()
  })
})

describe('PATCH /v1/destinations/:id', () => {
  it('archives via the flat path with ownership traversal', async () => {
    const users = chain({ data: approvedUser })
    const owned = chain({ data: { id: DESTINATION_ID, recipients: { user_id: 'user-123' } } })
    const update = chain({ data: { ...destinationRow, status: 'archived' } })
    from.mockReturnValueOnce(users).mockReturnValueOnce(owned).mockReturnValueOnce(update)
    const app = await buildApp()

    const res = await supertest(app.server)
      .patch(`/v1/destinations/${DESTINATION_ID}`)
      .set('Authorization', 'Bearer test-token')
      .send({ status: 'archived' })

    expect(res.status).toBe(200)
    expect(res.body.status).toBe('archived')
    expect(owned['eq']).toHaveBeenCalledWith('recipients.user_id', 'user-123')
    await app.close()
  })

  it("404s on another user's destination", async () => {
    from
      .mockReturnValueOnce(chain({ data: approvedUser }))
      .mockReturnValueOnce(chain({ data: null, error: { code: 'PGRST116' } }))
    const app = await buildApp()

    const res = await supertest(app.server)
      .patch(`/v1/destinations/${DESTINATION_ID}`)
      .set('Authorization', 'Bearer test-token')
      .send({ status: 'archived' })

    expect(res.status).toBe(404)
    await app.close()
  })

  it.each([
    ['details change', { details: { clabe: CLABE } }],
    ['empty body', {}],
    ['method change', { method: 'wallet' }],
  ])('400s on %s (schema rejects)', async (_name, body) => {
    const app = await buildApp()
    const res = await supertest(app.server)
      .patch(`/v1/destinations/${DESTINATION_ID}`)
      .set('Authorization', 'Bearer test-token')
      .send(body)
    expect(res.status).toBe(400)
    expect(from).not.toHaveBeenCalled()
    await app.close()
  })
})
