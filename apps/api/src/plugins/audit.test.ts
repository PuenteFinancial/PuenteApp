import { describe, it, expect, beforeEach } from 'vitest'
import Fastify from 'fastify'
import supertest from 'supertest'
import { auditPlugin } from './audit.js'

// The audit log is a compliance artifact AND a place PII must never land.
// These pin both halves: every authenticated route produces exactly one
// attributed entry, and the entry carries no query string.

const logged: Array<Record<string, unknown>> = []

async function buildApp() {
  const app = Fastify({ logger: false })
  // Capture what the plugin logs without asserting on pino's formatting.
  app.log.info = ((obj: Record<string, unknown>) => {
    logged.push(obj)
  }) as unknown as typeof app.log.info
  app.addHook('onRequest', async (request) => {
    request.user = { id: 'user-123' }
  })
  await app.register(auditPlugin)
  app.get('/v1/health', { config: { public: true } }, async () => ({ ok: true }))
  app.get('/v1/transfers', async () => ({ items: [] }))
  app.get('/v1/transfers/:id', async () => ({ id: 'x' }))
  app.post('/v1/public-thing', { config: { public: true } }, async () => ({ ok: true }))
  await app.ready()
  return app
}

beforeEach(() => {
  logged.length = 0
})

// Fastify's own request/response lines go through the same logger, so select
// ours the way a real consumer would: by the `audit` marker.
const audits = () => logged.filter((e) => e?.audit === true)

describe('auditPlugin', () => {
  it('writes one attributed entry for an authenticated route', async () => {
    const app = await buildApp()
    await supertest(app.server).get('/v1/transfers').expect(200)

    expect(audits()).toHaveLength(1)
    expect(audits()[0]).toMatchObject({
      audit: true,
      userId: 'user-123',
      method: 'GET',
      url: '/v1/transfers',
      statusCode: 200,
    })
    await app.close()
  })

  // PII must never sit in a URL param (CLAUDE.md, non-negotiable), so nothing
  // should today — but this log is exactly where a future route's mistake
  // would become a durable PII store, silently. Strip rather than trust.
  it('never records the query string', async () => {
    const app = await buildApp()
    await supertest(app.server).get('/v1/transfers?state=FUNDED&ssn=000-00-0000').expect(200)

    expect(audits()).toHaveLength(1)
    expect(audits()[0]!.url).toBe('/v1/transfers')
    expect(JSON.stringify(audits()[0])).not.toContain('000-00-0000')
    expect(JSON.stringify(audits()[0])).not.toContain('state=FUNDED')
    await app.close()
  })

  it('keeps path parameters — an id is attribution, not PII', async () => {
    const app = await buildApp()
    await supertest(app.server).get('/v1/transfers/abc-123?x=1').expect(200)

    expect(audits()[0]!.url).toBe('/v1/transfers/abc-123')
    await app.close()
  })

  it('skips public routes and the health check', async () => {
    const app = await buildApp()
    await supertest(app.server).get('/v1/health').expect(200)
    await supertest(app.server).post('/v1/public-thing').expect(200)

    expect(audits()).toHaveLength(0)
    await app.close()
  })
})
