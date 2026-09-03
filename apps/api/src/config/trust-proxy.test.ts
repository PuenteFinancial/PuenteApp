import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import supertest from 'supertest'
import Fastify, { type FastifyRequest } from 'fastify'

// Pins the trustProxy semantics the server relies on (server.ts passes the
// TRUST_PROXY_SOURCES address set). Railway's edge appends the real client IP
// as the RIGHTMOST X-Forwarded-For entry and connects from private address
// space; trusting only local/private source ranges derives request.ip from
// that entry while a direct connection from a public address is never
// trusted. If someone "simplifies" the config to `trustProxy: true`, the
// leftmost (client-controlled) entry wins instead — letting callers rotate
// fake IPs past per-IP rate limits. These tests fail loudly if that
// trade-off is misunderstood.
describe('trustProxy connecting-address semantics', () => {
  describe("trustProxy: 'loopback, linklocal, uniquelocal' (production shape)", () => {
    let app: ReturnType<typeof Fastify>

    beforeAll(async () => {
      app = Fastify({ logger: false, trustProxy: 'loopback, linklocal, uniquelocal' })
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

    it('walks past trusted private intermediate hops to the first public entry', async () => {
      // 10.0.0.5 is uniquelocal, so the walk continues left to the public
      // entry — an internal hop between the edge and the app never becomes
      // request.ip. A real client cannot exploit this: its own rightmost
      // entry is a public address, where the walk stops.
      const res = await supertest(app.server)
        .get('/ip')
        .set('X-Forwarded-For', '6.6.6.6, 10.0.0.5')
      expect(res.body.ip).toBe('6.6.6.6')
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

  it('numeric hop-count trustProxy is dead — 5.12.1 ignores XFF under it, silently', async () => {
    // GHSA "X-Forwarded-* spoofing under trustProxy hop-count": a hop count
    // never inspects the connecting address, so fastify disabled the form at
    // runtime — no error, XFF is just never consulted. That failure mode is
    // exactly why server.ts must never go back to a number: reverting would
    // ship request.ip = the edge's address (one shared rate-limit bucket)
    // with nothing in the logs. This pin turns that silence into a red test.
    const app = Fastify({ logger: false, trustProxy: 1 as unknown as boolean })
    app.get('/ip', async (request: FastifyRequest) => ({ ip: request.ip }))
    await app.ready()

    const res = await supertest(app.server)
      .get('/ip')
      .set('X-Forwarded-For', '203.0.113.7')
    expect(res.body.ip).toMatch(/127\.0\.0\.1|::1/)

    await app.close()
  })
})
