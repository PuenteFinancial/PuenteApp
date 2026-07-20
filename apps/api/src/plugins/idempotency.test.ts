import { describe, it, expect, beforeEach, vi } from 'vitest'
import supertest from 'supertest'
import Fastify from 'fastify'
import fp from 'fastify-plugin'

const from = vi.fn()

vi.mock('../services/supabase.js', () => ({
  supabaseAdmin: {
    from: (...args: unknown[]) => from(...args),
  },
}))

const { idempotencyPlugin, canonicalBodyHash } = await import('./idempotency.js')

const mockAuth = fp(async (server) => {
  server.addHook('onRequest', async (request) => {
    request.user = { id: 'user-123' }
  })
})

function chain(result: { data?: unknown; error?: unknown }) {
  const resolved = { data: result.data ?? null, error: result.error ?? null }
  const b: Record<string, ReturnType<typeof vi.fn>> & {
    then?: (resolve: (v: unknown) => void) => void
  } = {} as never
  for (const m of ['select', 'insert', 'update', 'delete', 'eq'] as const) {
    b[m] = vi.fn(() => b)
  }
  b['single'] = vi.fn(async () => resolved)
  b.then = (resolve) => resolve(resolved)
  return b
}

const CLAIM = { id: 'claim-1' }
const FUTURE = '2036-01-01T00:00:00.000Z'
const PAST = '2026-01-01T00:00:00.000Z'
const VALID_BODY = { quoteId: 'q-1' }
const VALID_HASH = canonicalBodyHash(VALID_BODY)

const handler = vi.fn(async () => ({ ok: true }))

async function buildApp() {
  const app = Fastify({ logger: false })
  await app.register(mockAuth)
  await app.register(idempotencyPlugin)
  app.post('/guarded', { config: { idempotency: true } }, handler)
  app.post('/open', {}, handler)
  await app.ready()
  return app
}

const post = (app: Awaited<ReturnType<typeof buildApp>>, url: string, key?: string) => {
  const req = supertest(app.server).post(url).send(VALID_BODY)
  return key ? req.set('Idempotency-Key', key) : req
}

beforeEach(() => {
  from.mockReset()
  handler.mockClear()
})

describe('idempotencyPlugin', () => {
  it('ignores unflagged routes entirely', async () => {
    const app = await buildApp()
    const res = await post(app, '/open')
    expect(res.status).toBe(200)
    expect(from).not.toHaveBeenCalled()
    await app.close()
  })

  it('400s a missing or malformed Idempotency-Key', async () => {
    const app = await buildApp()
    expect((await post(app, '/guarded')).status).toBe(400)
    expect((await post(app, '/guarded', 'bad key with spaces')).status).toBe(400)
    expect((await post(app, '/guarded', 'x'.repeat(256))).status).toBe(400)
    expect(handler).not.toHaveBeenCalled()
    await app.close()
  })

  it('runs the handler on a won claim and stores the 2xx response', async () => {
    const insert = chain({ data: CLAIM })
    const store = chain({ data: null })
    from.mockReturnValueOnce(insert).mockReturnValueOnce(store)
    const app = await buildApp()

    const res = await post(app, '/guarded', 'key-1')
    expect(res.status).toBe(200)
    expect(handler).toHaveBeenCalledTimes(1)
    expect(insert['insert']).toHaveBeenCalledWith({
      key: 'key-1',
      user_id: 'user-123',
      endpoint: 'POST /guarded',
      request_hash: VALID_HASH,
    })
    expect(store['update']).toHaveBeenCalledWith({
      response_status: 200,
      response_body: { ok: true },
    })
    await app.close()
  })

  it('replays the stored response without running the handler', async () => {
    from
      .mockReturnValueOnce(chain({ error: { code: '23505' } }))
      .mockReturnValueOnce(
        chain({
          data: {
            ...CLAIM,
            request_hash: VALID_HASH,
            response_status: 201,
            response_body: { replayed: true },
            expires_at: FUTURE,
          },
        }),
      )
    const app = await buildApp()

    const res = await post(app, '/guarded', 'key-1')
    expect(res.status).toBe(201)
    expect(res.body).toEqual({ replayed: true })
    expect(handler).not.toHaveBeenCalled()
    await app.close()
  })

  it('409s idempotency_conflict when the same key carries a different body', async () => {
    from
      .mockReturnValueOnce(chain({ error: { code: '23505' } }))
      .mockReturnValueOnce(
        chain({
          data: {
            ...CLAIM,
            request_hash: 'someone-elses-hash',
            response_status: 201,
            response_body: {},
            expires_at: FUTURE,
          },
        }),
      )
    const app = await buildApp()

    const res = await post(app, '/guarded', 'key-1')
    expect(res.status).toBe(409)
    expect(res.body.error.code).toBe('idempotency_conflict')
    expect(handler).not.toHaveBeenCalled()
    await app.close()
  })

  it('409s while the winning twin is still in flight', async () => {
    from
      .mockReturnValueOnce(chain({ error: { code: '23505' } }))
      .mockReturnValueOnce(
        chain({
          data: {
            ...CLAIM,
            request_hash: VALID_HASH,
            response_status: null,
            response_body: null,
            expires_at: FUTURE,
          },
        }),
      )
    const app = await buildApp()

    const res = await post(app, '/guarded', 'key-1')
    expect(res.status).toBe(409)
    expect(res.body.error.message).toContain('still in progress')
    await app.close()
  })

  it('reaps an expired row and reclaims', async () => {
    const stale = chain({
      data: { ...CLAIM, request_hash: 'old', response_status: 200, response_body: {}, expires_at: PAST },
    })
    const reap = chain({ data: null })
    const reclaim = chain({ data: { id: 'claim-2' } })
    const store = chain({ data: null })
    from
      .mockReturnValueOnce(chain({ error: { code: '23505' } }))
      .mockReturnValueOnce(stale)
      .mockReturnValueOnce(reap)
      .mockReturnValueOnce(reclaim)
      .mockReturnValueOnce(store)
    const app = await buildApp()

    const res = await post(app, '/guarded', 'key-1')
    expect(res.status).toBe(200)
    expect(handler).toHaveBeenCalledTimes(1)
    expect(reap['delete']).toHaveBeenCalled()
    await app.close()
  })

  it('releases the claim on non-2xx so the key can retry', async () => {
    handler.mockRejectedValueOnce(new Error('downstream exploded'))
    const insert = chain({ data: CLAIM })
    const release = chain({ data: null })
    from.mockReturnValueOnce(insert).mockReturnValueOnce(release)
    const app = await buildApp()

    const res = await post(app, '/guarded', 'key-1')
    expect(res.status).toBe(500)
    expect(release['delete']).toHaveBeenCalled()
    expect(release['update']).not.toHaveBeenCalled()
    await app.close()
  })

  it('hashes bodies canonically — key order does not matter', () => {
    expect(canonicalBodyHash({ a: 1, b: { d: 2, c: [1, 2] } })).toBe(
      canonicalBodyHash({ b: { c: [1, 2], d: 2 }, a: 1 }),
    )
    expect(canonicalBodyHash({ a: 1 })).not.toBe(canonicalBodyHash({ a: 2 }))
  })
})
