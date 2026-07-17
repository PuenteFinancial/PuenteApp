import { describe, it, expect, beforeEach, vi } from 'vitest'
import supertest from 'supertest'
import Fastify from 'fastify'

// commit is captured at module load, so each test re-imports the route
// with the env it wants
async function buildApp() {
  const { healthRoute } = await import('./health.js')
  const app = Fastify({ logger: false })
  await app.register(healthRoute, { prefix: '/v1' })
  await app.ready()
  return app
}

beforeEach(() => {
  vi.resetModules()
  vi.unstubAllEnvs()
})

describe('GET /v1/health', () => {
  it('reports the serving build via the short commit SHA when Railway provides it', async () => {
    vi.stubEnv('RAILWAY_GIT_COMMIT_SHA', '56e8cba9f1d2e3a4b5c6d7e8f901234567890abc')
    const app = await buildApp()

    const res = await supertest(app.server).get('/v1/health')

    expect(res.status).toBe(200)
    expect(res.body.status).toBe('ok')
    expect(res.body.commit).toBe('56e8cba')
    expect(res.body.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T/)
    await app.close()
  })

  it('returns commit null outside Railway (local/dev)', async () => {
    vi.stubEnv('RAILWAY_GIT_COMMIT_SHA', '')
    const app = await buildApp()

    const res = await supertest(app.server).get('/v1/health')

    expect(res.status).toBe(200)
    expect(res.body.commit).toBeNull()
    await app.close()
  })
})
