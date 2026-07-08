import crypto from 'node:crypto'
import { describe, it, expect, beforeEach, vi } from 'vitest'
import supertest from 'supertest'
import Fastify from 'fastify'

const SECRET = 'whsec_test'
process.env.BRIDGE_WEBHOOK_SECRET = SECRET

const from = vi.fn()

vi.mock('../../services/supabase.js', () => ({
  supabaseAdmin: { from: (...args: unknown[]) => from(...args) },
}))

const { webhooksRoute } = await import('./webhooks.js')

function sign(body: string, secret = SECRET) {
  return crypto.createHmac('sha256', secret).update(body).digest('hex')
}

function updateResult(result: { error: unknown }) {
  return { update: vi.fn(() => ({ eq: vi.fn(async () => result) })) }
}

async function buildApp() {
  const app = Fastify({ logger: false })
  await app.register(webhooksRoute, { prefix: '/v1' })
  await app.ready()
  return app
}

beforeEach(() => {
  from.mockReset()
})

describe('POST /v1/webhooks/bridge', () => {
  it('updates kyc_status on customer.kyc_status_updated with a valid signature', async () => {
    const eqSpy = vi.fn(async () => ({ error: null }))
    const updateSpy = vi.fn(() => ({ eq: eqSpy }))
    from.mockReturnValue({ update: updateSpy })
    const app = await buildApp()

    const body = JSON.stringify({
      event_type: 'customer.kyc_status_updated',
      event_object: { id: 'cust_abc', kyc_status: 'under_review' },
    })

    const res = await supertest(app.server)
      .post('/v1/webhooks/bridge')
      .set('Content-Type', 'application/json')
      .set('X-Webhook-Signature', sign(body))
      .send(body)

    expect(res.status).toBe(200)
    expect(res.body).toEqual({ received: true })
    expect(updateSpy).toHaveBeenCalledWith({ kyc_status: 'pending' })
    expect(eqSpy).toHaveBeenCalledWith('bridge_customer_id', 'cust_abc')
    await app.close()
  })

  it('also activates the user when kyc is approved', async () => {
    const updateSpy = vi.fn(() => ({ eq: vi.fn(async () => ({ error: null })) }))
    from.mockReturnValue({ update: updateSpy })
    const app = await buildApp()

    const body = JSON.stringify({
      event_type: 'customer.kyc_status_updated',
      event_object: { id: 'cust_abc', kyc_status: 'approved' },
    })

    const res = await supertest(app.server)
      .post('/v1/webhooks/bridge')
      .set('Content-Type', 'application/json')
      .set('X-Webhook-Signature', sign(body))
      .send(body)

    expect(res.status).toBe(200)
    expect(updateSpy).toHaveBeenCalledWith({ kyc_status: 'approved', status: 'active' })
    await app.close()
  })

  it('rejects an invalid signature with 400 and never touches the DB', async () => {
    const app = await buildApp()
    const body = JSON.stringify({
      event_type: 'customer.kyc_status_updated',
      event_object: { id: 'cust_abc', kyc_status: 'approved' },
    })

    const res = await supertest(app.server)
      .post('/v1/webhooks/bridge')
      .set('Content-Type', 'application/json')
      .set('X-Webhook-Signature', sign(body, 'wrong-secret'))
      .send(body)

    expect(res.status).toBe(400)
    expect(from).not.toHaveBeenCalled()
    await app.close()
  })

  it('rejects a missing signature header with 400', async () => {
    const app = await buildApp()

    const res = await supertest(app.server)
      .post('/v1/webhooks/bridge')
      .set('Content-Type', 'application/json')
      .send(JSON.stringify({ event_type: 'x' }))

    expect(res.status).toBe(400)
    expect(from).not.toHaveBeenCalled()
    await app.close()
  })

  it('acknowledges unhandled event types without DB writes', async () => {
    const app = await buildApp()
    const body = JSON.stringify({
      event_type: 'customer.created',
      event_object: { id: 'cust_abc' },
    })

    const res = await supertest(app.server)
      .post('/v1/webhooks/bridge')
      .set('Content-Type', 'application/json')
      .set('X-Webhook-Signature', sign(body))
      .send(body)

    expect(res.status).toBe(200)
    expect(from).not.toHaveBeenCalled()
    await app.close()
  })

  it('acknowledges unmapped kyc statuses without DB writes', async () => {
    const app = await buildApp()
    const body = JSON.stringify({
      event_type: 'customer.kyc_status_updated',
      event_object: { id: 'cust_abc', kyc_status: 'weird_new_status' },
    })

    const res = await supertest(app.server)
      .post('/v1/webhooks/bridge')
      .set('Content-Type', 'application/json')
      .set('X-Webhook-Signature', sign(body))
      .send(body)

    expect(res.status).toBe(200)
    expect(from).not.toHaveBeenCalled()
    await app.close()
  })

  it('returns 500 when the DB update fails so Bridge retries', async () => {
    from.mockReturnValue(updateResult({ error: { code: '500' } }))
    const app = await buildApp()

    const body = JSON.stringify({
      event_type: 'customer.kyc_status_updated',
      event_object: { id: 'cust_abc', kyc_status: 'approved' },
    })

    const res = await supertest(app.server)
      .post('/v1/webhooks/bridge')
      .set('Content-Type', 'application/json')
      .set('X-Webhook-Signature', sign(body))
      .send(body)

    expect(res.status).toBe(500)
    await app.close()
  })

  it('returns 503 when the webhook secret is not configured', async () => {
    vi.resetModules()
    delete process.env.BRIDGE_WEBHOOK_SECRET
    try {
      const { webhooksRoute: freshRoute } = await import('./webhooks.js')
      const app = Fastify({ logger: false })
      await app.register(freshRoute, { prefix: '/v1' })
      await app.ready()

      const res = await supertest(app.server)
        .post('/v1/webhooks/bridge')
        .set('Content-Type', 'application/json')
        .set('X-Webhook-Signature', 'anything')
        .send(JSON.stringify({ event_type: 'x' }))

      expect(res.status).toBe(503)
      await app.close()
    } finally {
      process.env.BRIDGE_WEBHOOK_SECRET = SECRET
    }
  })
})
