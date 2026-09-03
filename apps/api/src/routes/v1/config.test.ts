import { describe, it, expect, vi } from 'vitest'
import supertest from 'supertest'
import Fastify from 'fastify'
import fp from 'fastify-plugin'

const envMock = vi.hoisted(() => ({ STRIPE_PUBLISHABLE_KEY: undefined as string | undefined }))
vi.mock('../../config/env.js', () => ({ env: envMock }))

const { configRoute } = await import('./config.js')

const mockAuth = fp(async (server) => {
  server.addHook('onRequest', async (request, reply) => {
    if (!request.headers.authorization?.startsWith('Bearer ')) {
      return reply.code(401).send({ error: 'Unauthorized' })
    }
    request.user = { id: 'user-123' }
  })
})

async function buildApp() {
  const app = Fastify({ logger: false })
  await app.register(mockAuth)
  await app.register(configRoute, { prefix: '/v1' })
  await app.ready()
  return app
}

describe('GET /v1/config/web', () => {
  it('serves the publishable key to a signed-in user, and nothing else', async () => {
    envMock.STRIPE_PUBLISHABLE_KEY = 'pk_test_123'
    const app = await buildApp()
    const res = await supertest(app.server).get('/v1/config/web').set('Authorization', 'Bearer t')
    expect(res.status).toBe(200)
    expect(res.body).toEqual({ stripePublishableKey: 'pk_test_123' })
    await app.close()
  })

  it('is null, not an error, when Stripe is not configured', async () => {
    envMock.STRIPE_PUBLISHABLE_KEY = undefined
    const app = await buildApp()
    const res = await supertest(app.server).get('/v1/config/web').set('Authorization', 'Bearer t')
    expect(res.status).toBe(200)
    expect(res.body).toEqual({ stripePublishableKey: null })
    await app.close()
  })

  it('returns 401 without a token', async () => {
    const app = await buildApp()
    const res = await supertest(app.server).get('/v1/config/web')
    expect(res.status).toBe(401)
    await app.close()
  })
})
