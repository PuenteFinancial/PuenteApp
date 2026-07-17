import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import supertest from 'supertest'
import Fastify from 'fastify'
import { errorHandlerPlugin } from './error-handler.js'

describe('errorHandlerPlugin', () => {
  let app: ReturnType<typeof Fastify>

  beforeAll(async () => {
    app = Fastify({ logger: false })
    await app.register(errorHandlerPlugin)
    app.post(
      '/echo',
      {
        schema: {
          body: {
            type: 'object',
            required: ['amountMinor'],
            properties: { amountMinor: { type: 'integer', minimum: 1 } },
            additionalProperties: false,
          },
        },
      },
      async () => ({ ok: true }),
    )
    app.get('/boom', async () => {
      throw new Error('kaboom: secret internals')
    })
    await app.ready()
  })

  afterAll(() => app.close())

  it('wraps schema-validation failures in the envelope with details', async () => {
    const res = await supertest(app.server).post('/echo').send({ amountMinor: 0 })
    expect(res.status).toBe(400)
    expect(res.body.error.code).toBe('validation_error')
    expect(res.body.error.message).toBe('Invalid request.')
    expect(typeof res.body.error.requestId).toBe('string')
    expect(res.body.error.details).toEqual([
      { path: 'body/amountMinor', issue: expect.stringContaining('>= 1') },
    ])
  })

  it('404s unknown routes in the envelope', async () => {
    const res = await supertest(app.server).get('/nope')
    expect(res.status).toBe(404)
    expect(res.body.error).toMatchObject({ code: 'not_found', message: 'Route not found' })
  })

  it('500s unexpected errors without leaking internals', async () => {
    const res = await supertest(app.server).get('/boom')
    expect(res.status).toBe(500)
    expect(res.body.error.code).toBe('internal_error')
    expect(res.body.error.message).toBe('Something went wrong')
    expect(JSON.stringify(res.body)).not.toContain('kaboom')
  })
})
