import crypto from 'node:crypto'
import { describe, it, expect, beforeEach, vi } from 'vitest'
import supertest from 'supertest'
import Fastify from 'fastify'

// Real RSA keypair so tests exercise the exact scheme Bridge uses:
// RSA-PKCS1v15 over sha256(sha256("{t}.{body}"))
const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 })
const publicKeyPem = publicKey.export({ type: 'spki', format: 'pem' }).toString()

process.env.BRIDGE_WEBHOOK_PUBLIC_KEY = publicKeyPem

const from = vi.fn()

vi.mock('../../services/supabase.js', () => ({
  supabaseAdmin: { from: (...args: unknown[]) => from(...args) },
}))

const { webhooksRoute } = await import('./webhooks.js')

function signHeader(body: string, timestamp: number = Date.now(), key: crypto.KeyObject = privateKey) {
  const digest = crypto.createHash('sha256').update(`${timestamp}.${body}`).digest()
  const signer = crypto.createSign('RSA-SHA256')
  signer.update(digest)
  return `t=${timestamp},v0=${signer.sign(key, 'base64')}`
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
      .set('X-Webhook-Signature', signHeader(body))
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
      .set('X-Webhook-Signature', signHeader(body))
      .send(body)

    expect(res.status).toBe(200)
    expect(updateSpy).toHaveBeenCalledWith({ kyc_status: 'approved', status: 'active' })
    await app.close()
  })

  it('rejects a signature from the wrong key with 400 and never touches the DB', async () => {
    const { privateKey: wrongKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 })
    const app = await buildApp()
    const body = JSON.stringify({
      event_type: 'customer.kyc_status_updated',
      event_object: { id: 'cust_abc', kyc_status: 'approved' },
    })

    const res = await supertest(app.server)
      .post('/v1/webhooks/bridge')
      .set('Content-Type', 'application/json')
      .set('X-Webhook-Signature', signHeader(body, Date.now(), wrongKey))
      .send(body)

    expect(res.status).toBe(400)
    expect(from).not.toHaveBeenCalled()
    await app.close()
  })

  it('rejects a signature over different body content', async () => {
    const app = await buildApp()
    const body = JSON.stringify({
      event_type: 'customer.kyc_status_updated',
      event_object: { id: 'cust_abc', kyc_status: 'approved' },
    })
    const tampered = body.replace('approved', 'rejected')

    const res = await supertest(app.server)
      .post('/v1/webhooks/bridge')
      .set('Content-Type', 'application/json')
      .set('X-Webhook-Signature', signHeader(body))
      .send(tampered)

    expect(res.status).toBe(400)
    expect(from).not.toHaveBeenCalled()
    await app.close()
  })

  it('rejects a stale timestamp (replay protection)', async () => {
    const app = await buildApp()
    const body = JSON.stringify({ event_type: 'x' })
    const elevenMinutesAgo = Date.now() - 11 * 60 * 1000

    const res = await supertest(app.server)
      .post('/v1/webhooks/bridge')
      .set('Content-Type', 'application/json')
      .set('X-Webhook-Signature', signHeader(body, elevenMinutesAgo))
      .send(body)

    expect(res.status).toBe(400)
    await app.close()
  })

  it('rejects missing or malformed signature headers with 400', async () => {
    const app = await buildApp()
    const body = JSON.stringify({ event_type: 'x' })

    const noHeader = await supertest(app.server)
      .post('/v1/webhooks/bridge')
      .set('Content-Type', 'application/json')
      .send(body)
    expect(noHeader.status).toBe(400)

    for (const bad of ['garbage', 't=123', 'v0=abc', 't=notanumber,v0=abc']) {
      const res = await supertest(app.server)
        .post('/v1/webhooks/bridge')
        .set('Content-Type', 'application/json')
        .set('X-Webhook-Signature', bad)
        .send(body)
      expect(res.status).toBe(400)
    }
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
      .set('X-Webhook-Signature', signHeader(body))
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
      .set('X-Webhook-Signature', signHeader(body))
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
      .set('X-Webhook-Signature', signHeader(body))
      .send(body)

    expect(res.status).toBe(500)
    await app.close()
  })

  it('returns 503 when the webhook public key is not configured', async () => {
    vi.resetModules()
    delete process.env.BRIDGE_WEBHOOK_PUBLIC_KEY
    try {
      const { webhooksRoute: freshRoute } = await import('./webhooks.js')
      const app = Fastify({ logger: false })
      await app.register(freshRoute, { prefix: '/v1' })
      await app.ready()

      const body = JSON.stringify({ event_type: 'x' })
      const res = await supertest(app.server)
        .post('/v1/webhooks/bridge')
        .set('Content-Type', 'application/json')
        .set('X-Webhook-Signature', signHeader(body))
        .send(body)

      expect(res.status).toBe(503)
      await app.close()
    } finally {
      process.env.BRIDGE_WEBHOOK_PUBLIC_KEY = publicKeyPem
    }
  })
})
