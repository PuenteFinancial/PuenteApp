import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import supertest from 'supertest'
import Fastify, { type FastifyRequest } from 'fastify'

// Pins the trustProxy semantics the server relies on (server.ts uses a hop
// count from TRUST_PROXY_HOPS). Railway's edge appends the real client IP
// as the RIGHTMOST X-Forwarded-For entry; `trustProxy: <hops>` derives
// request.ip from that entry. If someone "simplifies" the config to
// `trustProxy: true`, the leftmost (client-controlled) entry wins instead —
// letting callers rotate fake IPs past per-IP rate limits. These tests fail
// loudly if that trade-off is misunderstood.
describe('trustProxy hop-count semantics', () => {
  describe('trustProxy: 1 (production shape — one Railway hop)', () => {
    let app: ReturnType<typeof Fastify>

    beforeAll(async () => {
      app = Fastify({ logger: false, trustProxy: 1 })
      app.get('/ip', async (request: FastifyRequest) => ({ ip: request.ip }))
      await app.ready()
    })

    afterAll(() => app.close())

    it('takes the rightmost X-Forwarded-For entry (the proxy-appended one)', async () => {
      const res = await supertest(app.server)
        .get('/ip')
        .set('X-Forwarded-For', '203.0.113.7')
      expect(res.body.ip).toBe('203.0.113.7')
    })

    it('ignores leftmost spoofed entries in a chain', async () => {
      const res = await supertest(app.server)
        .get('/ip')
        .set('X-Forwarded-For', '6.6.6.6, 203.0.113.7')
      expect(res.body.ip).toBe('203.0.113.7')
    })

    it('falls back to the socket address without X-Forwarded-For', async () => {
      const res = await supertest(app.server).get('/ip')
      expect(res.body.ip).toMatch(/127\.0\.0\.1|::1/)
    })
  })

  it('trustProxy: true would honor the spoofable leftmost entry — never use it', async () => {
    const app = Fastify({ logger: false, trustProxy: true })
    app.get('/ip', async (request: FastifyRequest) => ({ ip: request.ip }))
    await app.ready()

    const res = await supertest(app.server)
      .get('/ip')
      .set('X-Forwarded-For', '6.6.6.6, 203.0.113.7')
    // documents the bypass: the attacker-chosen leftmost value wins
    expect(res.body.ip).toBe('6.6.6.6')

    await app.close()
  })
})
