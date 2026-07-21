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

const transitionTransfer = vi.fn()

vi.mock('../../services/transfers.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../services/transfers.js')>()
  return {
    ...actual,
    transitionTransfer: (...args: unknown[]) => transitionTransfer(...args),
  }
})

const enqueuePayoutSubmit = vi.hoisted(() => vi.fn())

vi.mock('../../services/queue.js', () => ({
  enqueuePayoutSubmit: (...args: unknown[]) => enqueuePayoutSubmit(...args),
}))

const { webhooksRoute } = await import('./webhooks.js')
const { TransferRpcError } = await import('../../services/transfers.js')
const { env } = await import('../../config/env.js')

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
  it('updates kyc_status on customer.updated.status_transitioned with a valid signature', async () => {
    const eqSpy = vi.fn(async () => ({ error: null }))
    const updateSpy = vi.fn(() => ({ eq: eqSpy }))
    from.mockReturnValue({ update: updateSpy })
    const app = await buildApp()

    // Real Bridge payload shape: status lives on event_object.status with a
    // top-level event_object_status duplicate
    const body = JSON.stringify({
      event_type: 'customer.updated.status_transitioned',
      event_object_id: 'cust_abc',
      event_object_status: 'under_review',
      event_object: { id: 'cust_abc', status: 'under_review' },
      event_object_changes: { status: ['not_started', 'under_review'] },
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
      event_type: 'customer.updated.status_transitioned',
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

  it('clears the customer link and resets kyc_status on customer.deleted', async () => {
    const eqSpy = vi.fn(async () => ({ error: null }))
    const updateSpy = vi.fn(() => ({ eq: eqSpy }))
    from.mockReturnValue({ update: updateSpy })
    const app = await buildApp()

    const body = JSON.stringify({
      event_type: 'customer.deleted',
      event_object_id: 'cust_abc',
      event_object: { id: 'cust_abc' },
    })

    const res = await supertest(app.server)
      .post('/v1/webhooks/bridge')
      .set('Content-Type', 'application/json')
      .set('X-Webhook-Signature', signHeader(body))
      .send(body)

    expect(res.status).toBe(200)
    expect(updateSpy).toHaveBeenCalledWith({ bridge_customer_id: null, kyc_status: 'not_started' })
    expect(eqSpy).toHaveBeenCalledWith('bridge_customer_id', 'cust_abc')
    await app.close()
  })

  it('returns 500 when the customer.deleted unlink fails so Bridge retries', async () => {
    from.mockReturnValue(updateResult({ error: { code: '500' } }))
    const app = await buildApp()

    const body = JSON.stringify({
      event_type: 'customer.deleted',
      event_object: { id: 'cust_abc' },
    })

    const res = await supertest(app.server)
      .post('/v1/webhooks/bridge')
      .set('Content-Type', 'application/json')
      .set('X-Webhook-Signature', signHeader(body))
      .send(body)

    expect(res.status).toBe(500)
    await app.close()
  })

  it('rejects a signature from the wrong key with 400 and never touches the DB', async () => {
    const { privateKey: wrongKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 })
    const app = await buildApp()
    const body = JSON.stringify({
      event_type: 'customer.updated.status_transitioned',
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
      event_type: 'customer.updated.status_transitioned',
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
      event_type: 'kyc_link.updated.status_transitioned',
      event_object: { id: 'kyc_link_abc' },
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
      event_type: 'customer.updated.status_transitioned',
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
      event_type: 'customer.updated.status_transitioned',
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

// ── funding webhook ─────────────────────────────────────────────────────────

const FUNDING_SECRET = process.env.MOCK_FUNDING_WEBHOOK_SECRET!
const TRANSFER_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'

const fundingBody = (type = 'funding_succeeded', overrides: Record<string, unknown> = {}) =>
  JSON.stringify({
    id: 'evt_f1',
    type,
    data: { transfer_id: TRANSFER_ID, payment_ref: 'mockpay_1', ...overrides },
  })

const fundingSign = (body: string, t: number = Date.now(), secret: string = FUNDING_SECRET) =>
  `t=${t},v1=${crypto.createHmac('sha256', secret).update(`${t}.${body}`).digest('hex')}`

const transferRow = {
  id: TRANSFER_ID,
  state: 'PENDING_PAYMENT',
  send_amount_minor: 19801,
  fee_amount_minor: 199,
}

function selectChain(result: { data?: unknown; error?: unknown }) {
  const resolved = { data: result.data ?? null, error: result.error ?? null }
  const b: Record<string, ReturnType<typeof vi.fn>> = {} as never
  for (const m of ['select', 'update', 'eq', 'is'] as const) b[m] = vi.fn(() => b)
  b['single'] = vi.fn(async () => resolved)
  ;(b as { then?: (r: (v: unknown) => void) => void }).then = (r) => r(resolved)
  return b
}

const postFunding = (
  app: Awaited<ReturnType<typeof buildApp>>,
  body: string,
  header: string | undefined = undefined,
) => {
  const req = supertest(app.server)
    .post('/v1/webhooks/funding')
    .set('Content-Type', 'application/json')
  return (header === undefined ? req : req.set('Funding-Signature', header)).send(body)
}

describe('POST /v1/webhooks/funding', () => {
  beforeEach(() => {
    transitionTransfer.mockReset()
    enqueuePayoutSubmit.mockReset()
  })

  it('drives PENDING_PAYMENT → FUNDED with the ledger batch, timestamps, and payment ref', async () => {
    from.mockReturnValueOnce(selectChain({ data: transferRow }))
    transitionTransfer.mockResolvedValue({ ...transferRow, state: 'FUNDED' })
    const app = await buildApp()

    const body = fundingBody()
    const res = await postFunding(app, body, fundingSign(body))

    expect(res.status).toBe(200)
    expect(transitionTransfer).toHaveBeenCalledTimes(1)
    const call = transitionTransfer.mock.calls[0]![0] as Record<string, unknown>
    expect(call['fromState']).toBe('PENDING_PAYMENT')
    expect(call['toState']).toBe('FUNDED')
    expect(call['actor']).toBe('webhook:funding')
    expect(call['fundingPaymentRef']).toBe('mockpay_1')
    expect(call['ledgerEntries']).toEqual([
      { account_code: 'funding_receivable', direction: 'debit', amount_minor: 20000, currency: 'USD' },
      { account_code: 'transfer_payable', direction: 'credit', amount_minor: 19801, currency: 'USD' },
      { account_code: 'fee_revenue', direction: 'credit', amount_minor: 199, currency: 'USD' },
    ])
    const paymentAt = call['paymentAt'] as Date
    const cancelableUntil = call['cancelableUntil'] as Date
    expect(cancelableUntil.getTime() - paymentAt.getTime()).toBe(30 * 60 * 1000)
    // Immediate payout (slice 5): the FUNDED transition enqueues the submit job
    expect(enqueuePayoutSubmit).toHaveBeenCalledWith(TRANSFER_ID)
    await app.close()
  })

  it('still acks 200 when the payout enqueue fails — the sweep heals it', async () => {
    from.mockReturnValueOnce(selectChain({ data: transferRow }))
    transitionTransfer.mockResolvedValue({ ...transferRow, state: 'FUNDED' })
    enqueuePayoutSubmit.mockRejectedValue(new Error('DATABASE_URL is not set'))
    const app = await buildApp()

    const body = fundingBody()
    const res = await postFunding(app, body, fundingSign(body))

    expect(res.status).toBe(200)
    expect(transitionTransfer).toHaveBeenCalledTimes(1)
    await app.close()
  })

  it('drives funding_failed to PAYMENT_FAILED with NO ledger batch', async () => {
    from.mockReturnValueOnce(selectChain({ data: transferRow }))
    transitionTransfer.mockResolvedValue({ ...transferRow, state: 'PAYMENT_FAILED' })
    const app = await buildApp()

    const body = fundingBody('funding_failed', { reason: 'R01' })
    const res = await postFunding(app, body, fundingSign(body))

    expect(res.status).toBe(200)
    const call = transitionTransfer.mock.calls[0]![0] as Record<string, unknown>
    expect(call['toState']).toBe('PAYMENT_FAILED')
    expect(call['reason']).toBe('R01')
    expect(call['ledgerEntries']).toBeUndefined()
    await app.close()
  })

  it('funding_cleared flips the flag only — no transition', async () => {
    const update = selectChain({ data: null })
    from.mockReturnValueOnce(update)
    const app = await buildApp()

    const body = fundingBody('funding_cleared')
    const res = await postFunding(app, body, fundingSign(body))

    expect(res.status).toBe(200)
    expect(update['update']).toHaveBeenCalledWith({ funding_cleared: true })
    expect(transitionTransfer).not.toHaveBeenCalled()
    await app.close()
  })

  it('acks replays (already FUNDED) without a second transition', async () => {
    from.mockReturnValueOnce(selectChain({ data: { ...transferRow, state: 'FUNDED' } }))
    const app = await buildApp()

    const body = fundingBody()
    const res = await postFunding(app, body, fundingSign(body))

    expect(res.status).toBe(200)
    expect(transitionTransfer).not.toHaveBeenCalled()
    await app.close()
  })

  it('acks stale deliveries when the transfer moved past the event', async () => {
    from.mockReturnValueOnce(selectChain({ data: { ...transferRow, state: 'SUBMITTED' } }))
    transitionTransfer.mockRejectedValue(new TransferRpcError('transition_conflict'))
    const app = await buildApp()

    const body = fundingBody()
    const res = await postFunding(app, body, fundingSign(body))

    expect(res.status).toBe(200)
    await app.close()
  })

  it('acks unknown transfers (nothing a retry can fix) without transitioning', async () => {
    from.mockReturnValueOnce(selectChain({ data: null }))
    const app = await buildApp()

    const body = fundingBody()
    const res = await postFunding(app, body, fundingSign(body))

    expect(res.status).toBe(200)
    expect(transitionTransfer).not.toHaveBeenCalled()
    await app.close()
  })

  it('400s bad signatures, tampered bodies, and unparseable payloads — DB untouched', async () => {
    const app = await buildApp()

    const body = fundingBody()
    expect((await postFunding(app, body)).status).toBe(400)
    expect((await postFunding(app, body, fundingSign(body, Date.now(), 'wrong-secret-wrong'))).status).toBe(400)
    expect((await postFunding(app, body, fundingSign(body, Date.now() - 6 * 60 * 1000))).status).toBe(400)

    const garbage = 'not json'
    expect((await postFunding(app, garbage, fundingSign(garbage))).status).toBe(400)

    const unknownType = fundingBody('payment.exploded')
    expect((await postFunding(app, unknownType, fundingSign(unknownType))).status).toBe(400)

    expect(from).not.toHaveBeenCalled()
    expect(transitionTransfer).not.toHaveBeenCalled()
    await app.close()
  })

  it('500s on transition failure so the provider retries', async () => {
    from.mockReturnValueOnce(selectChain({ data: transferRow }))
    transitionTransfer.mockRejectedValue(new Error('db down'))
    const app = await buildApp()

    const body = fundingBody()
    const res = await postFunding(app, body, fundingSign(body))

    expect(res.status).toBe(500)
    await app.close()
  })

  it('503s when the mock secret is not configured (the production lock)', async () => {
    const saved = env.MOCK_FUNDING_WEBHOOK_SECRET
    env.MOCK_FUNDING_WEBHOOK_SECRET = undefined
    try {
      const app = await buildApp()
      const body = fundingBody()
      const res = await postFunding(app, body, fundingSign(body))
      expect(res.status).toBe(503)
      expect(res.body.error.code).toBe('not_configured')
      await app.close()
    } finally {
      env.MOCK_FUNDING_WEBHOOK_SECRET = saved
    }
  })
})
