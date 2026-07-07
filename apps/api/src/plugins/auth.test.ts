import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import supertest from 'supertest'
import Fastify, { type FastifyRequest } from 'fastify'

vi.mock('jose', () => ({
  createRemoteJWKSet: vi.fn(() => ({})),
  jwtVerify: vi.fn(async (token: string) => {
    if (token === 'valid-token') return { payload: { sub: 'user-123' } }
    if (token === 'no-sub-token') return { payload: {} }
    throw new Error('invalid token')
  }),
}))

const { authPlugin } = await import('./auth.js')

describe('authPlugin', () => {
  let app: ReturnType<typeof Fastify>

  beforeAll(async () => {
    app = Fastify({ logger: false })
    await app.register(authPlugin)
    app.get('/protected', async (request: FastifyRequest) => ({ userId: request.user?.id }))
    app.get('/open', { config: { public: true } }, async () => ({ ok: true }))
    await app.ready()
  })

  afterAll(() => app.close())

  it('rejects requests without an Authorization header', async () => {
    const res = await supertest(app.server).get('/protected')
    expect(res.status).toBe(401)
  })

  it('rejects non-Bearer Authorization headers', async () => {
    const res = await supertest(app.server)
      .get('/protected')
      .set('Authorization', 'Basic abc123')
    expect(res.status).toBe(401)
  })

  it('rejects tokens that fail verification', async () => {
    const res = await supertest(app.server)
      .get('/protected')
      .set('Authorization', 'Bearer garbage')
    expect(res.status).toBe(401)
  })

  it('rejects tokens without a sub claim', async () => {
    const res = await supertest(app.server)
      .get('/protected')
      .set('Authorization', 'Bearer no-sub-token')
    expect(res.status).toBe(401)
  })

  it('sets request.user for a valid token', async () => {
    const res = await supertest(app.server)
      .get('/protected')
      .set('Authorization', 'Bearer valid-token')
    expect(res.status).toBe(200)
    expect(res.body).toEqual({ userId: 'user-123' })
  })

  it('skips auth for routes marked public', async () => {
    const res = await supertest(app.server).get('/open')
    expect(res.status).toBe(200)
    expect(res.body).toEqual({ ok: true })
  })
})
