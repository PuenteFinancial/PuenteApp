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
const postLedgerTransaction = vi.fn()
vi.mock('../../services/ledger.js', () => ({
  postLedgerTransaction: (...args: unknown[]) => postLedgerTransaction(...args),
}))

vi.mock('../../services/transfers.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../services/transfers.js')>()
  return {
    ...actual,
    transitionTransfer: (...args: unknown[]) => transitionTransfer(...args),
  }
})

const enqueuePayoutSubmit = vi.hoisted(() => vi.fn())
const enqueuePaymentEventProcess = vi.hoisted(() => vi.fn())

vi.mock('../../services/queue.js', () => ({
  enqueuePayoutSubmit: (...args: unknown[]) => enqueuePayoutSubmit(...args),
  enqueuePaymentEventProcess: (...args: unknown[]) => enqueuePaymentEventProcess(...args),
}))

const recordEvent = vi.hoisted(() => vi.fn())
const markProcessed = vi.hoisted(() => vi.fn())
vi.mock('../../services/payment-events.js', () => ({
  recordEvent: (...args: unknown[]) => recordEvent(...args),
  markProcessed: (...args: unknown[]) => markProcessed(...args),
}))

const actOnRefundTailEvent = vi.hoisted(() => vi.fn())
vi.mock('../../services/refunds.js', () => ({
  actOnRefundTailEvent: (...args: unknown[]) => actOnRefundTailEvent(...args),
}))

// Overridable funding processor: null → the real mock processor; tests set
// `current` to a stripe-shaped fake to exercise processor-declared headers,
// configured-checks, and the null-transferRef resolution path.
const processorOverride = vi.hoisted(() => ({ current: null as unknown }))
vi.mock('../../services/funding/index.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../services/funding/index.js')>()
  return {
    ...actual,
    getFundingProcessor: () =>
      (processorOverride.current ?? actual.getFundingProcessor()) as ReturnType<
        typeof actual.getFundingProcessor
      >,
  }
})

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
  postLedgerTransaction.mockReset().mockResolvedValue(undefined)
  processorOverride.current = null
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
  margin_minor: 0,
}

function selectChain(result: { data?: unknown; error?: unknown }) {
  const resolved = { data: result.data ?? null, error: result.error ?? null }
  const b: Record<string, ReturnType<typeof vi.fn>> = {} as never
  for (const m of ['select', 'update', 'eq', 'is'] as const) b[m] = vi.fn(() => b)
  b['single'] = vi.fn(async () => resolved)
  b['maybeSingle'] = vi.fn(async () => resolved)
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
    expect(enqueuePayoutSubmit).toHaveBeenCalledWith(TRANSFER_ID, 'api')
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

  it('funding_cleared flips the flag and posts the ACH CLEARS cash leg — no transition', async () => {
    // Regression guard (2026-08-03): the cash leg was specified in
    // ledger-rules.md but never implemented, so funding_receivable tracked
    // LIFETIME VOLUME instead of outstanding float. The float ceiling reads
    // that balance, making it a one-way ratchet that permanently halts payouts.
    const load = selectChain({ data: { ...transferRow, state: 'FUNDED' } })
    const update = selectChain({ data: null })
    from.mockReturnValueOnce(load).mockReturnValueOnce(update)
    const app = await buildApp()

    const body = fundingBody('funding_cleared')
    const res = await postFunding(app, body, fundingSign(body))

    expect(res.status).toBe(200)
    expect(update['update']).toHaveBeenCalledWith({ funding_cleared: true })
    expect(transitionTransfer).not.toHaveBeenCalled()

    expect(postLedgerTransaction).toHaveBeenCalledTimes(1)
    const post = postLedgerTransaction.mock.calls[0]![0] as {
      transition: string
      entries: { accountCode: string; direction: string; money: { amountMinor: number } }[]
    }
    // keyed on its own transition → the unique idempotency key makes a
    // redelivered webhook a no-op rather than a double relief
    expect(post.transition).toBe('funding_cleared')
    const total = transferRow.send_amount_minor + transferRow.fee_amount_minor
    expect(post.entries).toEqual([
      { accountCode: 'cash_clearing', direction: 'debit', money: { amountMinor: total, currency: 'USD' } },
      { accountCode: 'funding_receivable', direction: 'credit', money: { amountMinor: total, currency: 'USD' } },
    ])
    await app.close()
  })

  it.each([
    ['CANCELED', null],
    ['PAYMENT_FAILED', null],
    ['PENDING_PAYMENT', null],
    ['REFUNDED', 'mockvoid_abc'],
  ] as const)(
    'skips the cash leg when the receivable is already closed (%s) — never drives it negative',
    async (state, refundRef) => {
      const load = selectChain({ data: { ...transferRow, state, refund_payment_ref: refundRef } })
      from.mockReturnValueOnce(load).mockReturnValueOnce(selectChain({ data: null }))
      const app = await buildApp()

      const body = fundingBody('funding_cleared')
      const res = await postFunding(app, body, fundingSign(body))

      expect(res.status).toBe(200)
      expect(postLedgerTransaction).not.toHaveBeenCalled()
      await app.close()
    },
  )

  it('DOES post for a settled (refunded-mode) refund — that path credits cash, not the receivable', async () => {
    const load = selectChain({
      data: { ...transferRow, state: 'REFUNDED', refund_payment_ref: 're_stripe_1' },
    })
    from.mockReturnValueOnce(load).mockReturnValueOnce(selectChain({ data: null }))
    const app = await buildApp()

    const body = fundingBody('funding_cleared')
    const res = await postFunding(app, body, fundingSign(body))

    expect(res.status).toBe(200)
    expect(postLedgerTransaction).toHaveBeenCalledTimes(1)
    await app.close()
  })

  it('500s when the cash leg fails to post so the processor redelivers', async () => {
    // The flag is already set; a swallowed failure would strand the receivable
    // open forever with nothing to retry it.
    const load = selectChain({ data: { ...transferRow, state: 'FUNDED' } })
    from.mockReturnValueOnce(load).mockReturnValueOnce(selectChain({ data: null }))
    postLedgerTransaction.mockRejectedValueOnce(new Error('ledger rpc down'))
    const app = await buildApp()

    const body = fundingBody('funding_cleared')
    const res = await postFunding(app, body, fundingSign(body))

    expect(res.status).toBe(500)
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

    expect(from).not.toHaveBeenCalled()
    expect(transitionTransfer).not.toHaveBeenCalled()
    await app.close()
  })

  it('acks signed-but-unmapped event types instead of 400ing them into a redelivery loop', async () => {
    const app = await buildApp()

    const unknownType = fundingBody('payment.exploded')
    const res = await postFunding(app, unknownType, fundingSign(unknownType))

    expect(res.status).toBe(200)
    expect(res.body).toEqual({ received: true })
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

// ── funding webhook, stripe-shaped processor (PR-S1) ────────────────────────
// The route must take the header name, configured-check, parse result, and
// (for disputes) the funding_payment_ref join from the processor — these
// tests drive it with a stripe-shaped fake through the same public seam.

const disputeEvent = {
  eventId: 'evt_d1',
  type: 'funding_reversed' as const,
  transferRef: null,
  paymentRef: 'pi_123',
  reason: 'insufficient_funds',
}

function fakeStripeProcessor(overrides: Record<string, unknown> = {}) {
  return {
    provider: 'stripe',
    signatureHeader: 'stripe-signature',
    isConfigured: () => true,
    verifySignature: vi.fn(() => true),
    parseEvent: vi.fn(() => ({ outcome: 'event', event: disputeEvent })),
    initiateFunding: vi.fn(),
    voidFunding: vi.fn(),
    refund: vi.fn(),
    ...overrides,
  }
}

describe('POST /v1/webhooks/funding — processor-declared behavior', () => {
  beforeEach(() => {
    transitionTransfer.mockReset()
  })

  it('reads the signature from the header the processor declares', async () => {
    const processor = fakeStripeProcessor({
      parseEvent: vi.fn(() => ({ outcome: 'unhandled', eventId: 'evt_x', eventType: 'charge.updated' })),
    })
    processorOverride.current = processor
    const app = await buildApp()

    // funding-signature (the mock's header) no longer satisfies the route…
    const missing = await supertest(app.server)
      .post('/v1/webhooks/funding')
      .set('Content-Type', 'application/json')
      .set('Funding-Signature', 'sig_v1')
      .send('{}')
    expect(missing.status).toBe(400)
    expect(processor.verifySignature).not.toHaveBeenCalled()

    // …stripe-signature does, and the raw value reaches the processor
    const ok = await supertest(app.server)
      .post('/v1/webhooks/funding')
      .set('Content-Type', 'application/json')
      .set('Stripe-Signature', 'sig_v1')
      .send('{}')
    expect(ok.status).toBe(200)
    expect(processor.verifySignature).toHaveBeenCalledWith(expect.any(Buffer), 'sig_v1')
    await app.close()
  })

  it("503s not_configured on the processor's own configured-check", async () => {
    processorOverride.current = fakeStripeProcessor({ isConfigured: () => false })
    const app = await buildApp()

    const res = await supertest(app.server)
      .post('/v1/webhooks/funding')
      .set('Content-Type', 'application/json')
      .set('Stripe-Signature', 'sig_v1')
      .send('{}')

    expect(res.status).toBe(503)
    expect(res.body.error.code).toBe('not_configured')
    await app.close()
  })

  it('resolves a null-transferRef dispute through transfers.funding_payment_ref and acks', async () => {
    const lookup = selectChain({ data: { id: TRANSFER_ID } })
    from.mockReturnValueOnce(lookup)
    processorOverride.current = fakeStripeProcessor()
    const app = await buildApp()

    const res = await supertest(app.server)
      .post('/v1/webhooks/funding')
      .set('Content-Type', 'application/json')
      .set('Stripe-Signature', 'sig_v1')
      .send('{}')

    expect(res.status).toBe(200)
    expect(from).toHaveBeenCalledWith('transfers')
    expect(lookup['select']).toHaveBeenCalledWith('id')
    expect(lookup['eq']).toHaveBeenCalledWith('funding_payment_ref', 'pi_123')
    expect(lookup['maybeSingle']).toHaveBeenCalled()
    // funding_reversed handling stays deferred — resolution is for the log/join
    expect(transitionTransfer).not.toHaveBeenCalled()
    await app.close()
  })

  it('acks a dispute that matches no transfer (retry cannot fix it) without touching state', async () => {
    from.mockReturnValueOnce(selectChain({ data: null }))
    processorOverride.current = fakeStripeProcessor()
    const app = await buildApp()

    const res = await supertest(app.server)
      .post('/v1/webhooks/funding')
      .set('Content-Type', 'application/json')
      .set('Stripe-Signature', 'sig_v1')
      .send('{}')

    expect(res.status).toBe(200)
    expect(res.body).toEqual({ received: true })
    expect(transitionTransfer).not.toHaveBeenCalled()
    await app.close()
  })
})

// ── funding webhook, onramp-shaped processor (#213) ─────────────────────────
// The onramp lifecycle drives THREE distinct route behaviors: processing →
// the ordinary FUNDED transition, complete → applyOnrampSettlement (cash leg
// + float top-up + out-of-order catch-up), rejected → PAYMENT_FAILED. The
// provider gate on the cleared branch is what routes complete differently
// from every other processor — these tests pin it through the public seam.

function fakeOnrampProcessor(
  eventType: 'funding_succeeded' | 'funding_cleared' | 'funding_failed' | 'unhandled',
) {
  return fakeStripeProcessor({
    provider: 'stripe_onramp',
    parseEvent: vi.fn(() =>
      eventType === 'unhandled'
        ? { outcome: 'unhandled', eventId: 'evt_o1', eventType: 'crypto.onramp_session.updated' }
        : {
            outcome: 'event',
            event: {
              eventId: 'evt_o1',
              type: eventType,
              transferRef: TRANSFER_ID,
              paymentRef: 'cos_1',
            },
          },
    ),
  })
}

const postOnramp = (app: Awaited<ReturnType<typeof buildApp>>) =>
  supertest(app.server)
    .post('/v1/webhooks/funding')
    .set('Content-Type', 'application/json')
    .set('Stripe-Signature', 'sig_v1')
    .send('{}')

describe('POST /v1/webhooks/funding — onramp settlement (#213)', () => {
  beforeEach(() => {
    transitionTransfer.mockReset()
    enqueuePayoutSubmit.mockReset().mockResolvedValue(undefined)
  })

  it('fulfillment_complete posts the cash leg AND the float top-up', async () => {
    processorOverride.current = fakeOnrampProcessor('funding_cleared')
    const funded = { ...transferRow, state: 'FUNDED', refund_payment_ref: null }
    // applyOnrampSettlement reads: catch-up load, cleared load, flag update
    from
      .mockReturnValueOnce(selectChain({ data: funded }))
      .mockReturnValueOnce(selectChain({ data: funded }))
      .mockReturnValueOnce(selectChain({ data: null }))
    const app = await buildApp()

    const res = await postOnramp(app)

    expect(res.status).toBe(200)
    expect(transitionTransfer).not.toHaveBeenCalled()
    expect(postLedgerTransaction).toHaveBeenCalledTimes(2)
    const cashLeg = postLedgerTransaction.mock.calls[0]![0] as Record<string, unknown>
    expect(cashLeg['transition']).toBe('funding_cleared')
    const topUp = postLedgerTransaction.mock.calls[1]![0] as Record<string, unknown>
    // Keyed on the session id → dashboard redelivery re-derives the same key
    expect(topUp['idempotencyKey']).toBe('float_topup:cos_1')
    await app.close()
  })

  it('fulfillment_complete before processing catches up to FUNDED first', async () => {
    processorOverride.current = fakeOnrampProcessor('funding_cleared')
    const pending = { ...transferRow, refund_payment_ref: null }
    const funded = { ...pending, state: 'FUNDED' }
    transitionTransfer.mockResolvedValue({ id: TRANSFER_ID })
    from
      .mockReturnValueOnce(selectChain({ data: pending })) // settlement load
      .mockReturnValueOnce(selectChain({ data: pending })) // catch-up load
      .mockReturnValueOnce(selectChain({ data: funded })) // cleared load (post-transition)
      .mockReturnValueOnce(selectChain({ data: null })) // flag update
    const app = await buildApp()

    const res = await postOnramp(app)

    expect(res.status).toBe(200)
    const transition = transitionTransfer.mock.calls[0]![0] as Record<string, unknown>
    expect(transition['fromState']).toBe('PENDING_PAYMENT')
    expect(transition['toState']).toBe('FUNDED')
    expect(enqueuePayoutSubmit).toHaveBeenCalledWith(TRANSFER_ID, 'api')
    expect(postLedgerTransaction).toHaveBeenCalledTimes(2)
    await app.close()
  })

  it('suppresses the top-up when the receivable is closed (CANCELED)', async () => {
    processorOverride.current = fakeOnrampProcessor('funding_cleared')
    const canceled = { ...transferRow, state: 'CANCELED', refund_payment_ref: null }
    from
      .mockReturnValueOnce(selectChain({ data: canceled }))
      .mockReturnValueOnce(selectChain({ data: canceled }))
      .mockReturnValueOnce(selectChain({ data: null }))
    const app = await buildApp()

    const res = await postOnramp(app)

    expect(res.status).toBe(200)
    expect(postLedgerTransaction).not.toHaveBeenCalled()
    await app.close()
  })

  it('500s when the top-up fails to post so Stripe redelivers', async () => {
    processorOverride.current = fakeOnrampProcessor('funding_cleared')
    const funded = { ...transferRow, state: 'FUNDED', refund_payment_ref: null }
    from
      .mockReturnValueOnce(selectChain({ data: funded }))
      .mockReturnValueOnce(selectChain({ data: funded }))
      .mockReturnValueOnce(selectChain({ data: null }))
    postLedgerTransaction
      .mockResolvedValueOnce(undefined) // cash leg
      .mockRejectedValueOnce(new Error('ledger rpc down')) // top-up
    const app = await buildApp()

    const res = await postOnramp(app)

    expect(res.status).toBe(500)
    await app.close()
  })

  it('fulfillment_processing drives the ordinary FUNDED transition + payout', async () => {
    processorOverride.current = fakeOnrampProcessor('funding_succeeded')
    from.mockReturnValueOnce(selectChain({ data: transferRow }))
    transitionTransfer.mockResolvedValue({ ...transferRow, state: 'FUNDED' })
    const app = await buildApp()

    const res = await postOnramp(app)

    expect(res.status).toBe(200)
    const call = transitionTransfer.mock.calls[0]![0] as Record<string, unknown>
    expect(call['toState']).toBe('FUNDED')
    expect(call['fundingPaymentRef']).toBe('cos_1')
    expect(enqueuePayoutSubmit).toHaveBeenCalledWith(TRANSFER_ID, 'api')
    await app.close()
  })

  it('rejected drives PAYMENT_FAILED with no ledger batch', async () => {
    processorOverride.current = fakeOnrampProcessor('funding_failed')
    from.mockReturnValueOnce(selectChain({ data: transferRow }))
    transitionTransfer.mockResolvedValue({ ...transferRow, state: 'PAYMENT_FAILED' })
    const app = await buildApp()

    const res = await postOnramp(app)

    expect(res.status).toBe(200)
    const call = transitionTransfer.mock.calls[0]![0] as Record<string, unknown>
    expect(call['toState']).toBe('PAYMENT_FAILED')
    expect(call['ledgerEntries']).toBeUndefined()
    expect(postLedgerTransaction).not.toHaveBeenCalled()
    await app.close()
  })

  it('pre-payment churn (initialized / requires_payment) acks without touching state', async () => {
    processorOverride.current = fakeOnrampProcessor('unhandled')
    const app = await buildApp()

    const res = await postOnramp(app)

    expect(res.status).toBe(200)
    expect(res.body).toEqual({ received: true })
    expect(from).not.toHaveBeenCalled()
    expect(transitionTransfer).not.toHaveBeenCalled()
    await app.close()
  })
})

// ── funding refund tails (PR-S2) ─────────────────────────────────────────────

describe('POST /v1/webhooks/funding — refund tails (PR-S2)', () => {
  beforeEach(() => {
    recordEvent.mockReset()
    markProcessed.mockReset()
    actOnRefundTailEvent.mockReset()
    transitionTransfer.mockReset()
  })

  const refundFailedBody = () =>
    fundingBody('refund_failed', { undo_ref: 'mockrefund_9', reason: 'account_closed' })

  it('records to payment_events (source funding), acts, marks processed — no state transition', async () => {
    recordEvent.mockResolvedValue({ id: 'pe-1', inserted: true, status: 'received' })
    markProcessed.mockResolvedValue(undefined)
    const app = await buildApp()

    const body = refundFailedBody()
    const res = await postFunding(app, body, fundingSign(body))

    expect(res.status).toBe(200)
    expect(recordEvent).toHaveBeenCalledWith({
      source: 'funding',
      externalEventId: 'evt_f1',
      eventType: 'refund_failed',
      transferId: TRANSFER_ID,
      providerRef: 'mockrefund_9',
      payload: expect.objectContaining({ id: 'evt_f1', type: 'refund_failed' }),
    })
    expect(actOnRefundTailEvent).toHaveBeenCalledWith({
      eventType: 'refund_failed',
      transferId: TRANSFER_ID,
      refundRef: 'mockrefund_9',
      reason: 'account_closed',
    })
    expect(markProcessed).toHaveBeenCalledWith('pe-1')
    // Money truth only — the transfer settled at REFUNDED when the undo was issued
    expect(transitionTransfer).not.toHaveBeenCalled()
    await app.close()
  })

  it('refund_settled records and marks without a reason', async () => {
    recordEvent.mockResolvedValue({ id: 'pe-2', inserted: true, status: 'received' })
    markProcessed.mockResolvedValue(undefined)
    const app = await buildApp()

    const body = fundingBody('refund_settled', { undo_ref: 'mockrefund_9' })
    const res = await postFunding(app, body, fundingSign(body))

    expect(res.status).toBe(200)
    expect(actOnRefundTailEvent).toHaveBeenCalledWith({
      eventType: 'refund_settled',
      transferId: TRANSFER_ID,
      refundRef: 'mockrefund_9',
    })
    expect(markProcessed).toHaveBeenCalledWith('pe-2')
    await app.close()
  })

  it('a replayed delivery already handled short-circuits: no act, no re-mark', async () => {
    recordEvent.mockResolvedValue({ id: 'pe-1', inserted: false, status: 'processed' })
    const app = await buildApp()

    const body = refundFailedBody()
    const res = await postFunding(app, body, fundingSign(body))

    expect(res.status).toBe(200)
    expect(actOnRefundTailEvent).not.toHaveBeenCalled()
    expect(markProcessed).not.toHaveBeenCalled()
    await app.close()
  })

  it("a redelivery whose first attempt died before the mark re-drives the act (status still 'received')", async () => {
    recordEvent.mockResolvedValue({ id: 'pe-1', inserted: false, status: 'received' })
    markProcessed.mockResolvedValue(undefined)
    const app = await buildApp()

    const body = refundFailedBody()
    const res = await postFunding(app, body, fundingSign(body))

    expect(res.status).toBe(200)
    expect(actOnRefundTailEvent).toHaveBeenCalledTimes(1)
    expect(markProcessed).toHaveBeenCalledWith('pe-1')
    await app.close()
  })

  it('500s when the record insert fails so the provider redelivers', async () => {
    recordEvent.mockRejectedValue(new Error('insert failed'))
    const app = await buildApp()

    const body = refundFailedBody()
    const res = await postFunding(app, body, fundingSign(body))

    expect(res.status).toBe(500)
    expect(actOnRefundTailEvent).not.toHaveBeenCalled()
    await app.close()
  })

  it('still acks 200 when the mark fails — the act is done and the sweep→job path retires the row', async () => {
    recordEvent.mockResolvedValue({ id: 'pe-1', inserted: true, status: 'received' })
    markProcessed.mockRejectedValue(new Error('db blip'))
    const app = await buildApp()

    const body = refundFailedBody()
    const res = await postFunding(app, body, fundingSign(body))

    expect(res.status).toBe(200)
    expect(actOnRefundTailEvent).toHaveBeenCalledTimes(1)
    await app.close()
  })

  it('a dashboard-issued refund (no metadata echo) joins through funding_payment_ref', async () => {
    const lookup = selectChain({ data: { id: TRANSFER_ID } })
    from.mockReturnValueOnce(lookup)
    recordEvent.mockResolvedValue({ id: 'pe-3', inserted: true, status: 'received' })
    markProcessed.mockResolvedValue(undefined)
    processorOverride.current = fakeStripeProcessor({
      parseEvent: vi.fn(() => ({
        outcome: 'event',
        event: {
          eventId: 'evt_r9',
          type: 'refund_failed',
          transferRef: null,
          paymentRef: 'pi_123',
          undoRef: 're_9',
          reason: 'declined',
        },
      })),
    })
    const app = await buildApp()

    const res = await supertest(app.server)
      .post('/v1/webhooks/funding')
      .set('Content-Type', 'application/json')
      .set('Stripe-Signature', 'sig_v1')
      .send(JSON.stringify({ id: 'evt_r9', type: 'refund.failed' }))

    expect(res.status).toBe(200)
    expect(lookup['eq']).toHaveBeenCalledWith('funding_payment_ref', 'pi_123')
    expect(recordEvent).toHaveBeenCalledWith(
      expect.objectContaining({ transferId: TRANSFER_ID, providerRef: 're_9' }),
    )
    await app.close()
  })
})

// ── bridge transfer events (slice 5 PR 3) ────────────────────────────────────

const transferEventBody = (state = 'payment_processed', overrides: Record<string, unknown> = {}) =>
  JSON.stringify({
    event_type: 'transfer.updated.status_transitioned',
    event_object_id: 'bt-1',
    event_object: { id: 'bt-1', state, client_reference_id: TRANSFER_ID, ...overrides },
  })

const postBridge = (app: Awaited<ReturnType<typeof buildApp>>, body: string, header?: string) =>
  supertest(app.server)
    .post('/v1/webhooks/bridge')
    .set('Content-Type', 'application/json')
    .set('X-Webhook-Signature', header ?? signHeader(body))
    .send(body)

describe('POST /v1/webhooks/bridge — transfer events', () => {
  beforeEach(() => {
    recordEvent.mockReset()
    enqueuePaymentEventProcess.mockReset()
  })

  it('records the event, resolves our transfer, enqueues processing, acks 200', async () => {
    // transfers resolve (client_reference_id → our id)
    from.mockReturnValueOnce(selectChain({ data: { id: TRANSFER_ID } }))
    recordEvent.mockResolvedValue({ id: 'ev-1', inserted: true })
    const app = await buildApp()

    const body = transferEventBody('payment_processed')
    const res = await postBridge(app, body)

    expect(res.status).toBe(200)
    expect(recordEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        source: 'bridge',
        externalEventId: 'bt-1:payment_processed',
        eventType: 'payment_processed',
        transferId: TRANSFER_ID,
        providerRef: 'bt-1',
      }),
    )
    expect(enqueuePaymentEventProcess).toHaveBeenCalledWith('ev-1', 'api')
    await app.close()
  })

  it('does not enqueue on a duplicate (already-recorded) event', async () => {
    from.mockReturnValueOnce(selectChain({ data: { id: TRANSFER_ID } }))
    recordEvent.mockResolvedValue({ id: 'ev-1', inserted: false })
    const app = await buildApp()

    const res = await postBridge(app, transferEventBody('payment_submitted'))

    expect(res.status).toBe(200)
    expect(enqueuePaymentEventProcess).not.toHaveBeenCalled()
    await app.close()
  })

  it('still acks 200 when the enqueue fails — the sweep heals', async () => {
    from.mockReturnValueOnce(selectChain({ data: { id: TRANSFER_ID } }))
    recordEvent.mockResolvedValue({ id: 'ev-1', inserted: true })
    enqueuePaymentEventProcess.mockRejectedValue(new Error('boss down'))
    const app = await buildApp()

    const res = await postBridge(app, transferEventBody())

    expect(res.status).toBe(200)
    await app.close()
  })

  it('records with a null transfer when client_reference_id resolves nothing', async () => {
    from.mockReturnValueOnce(selectChain({ data: null }))
    recordEvent.mockResolvedValue({ id: 'ev-1', inserted: true })
    const app = await buildApp()

    await postBridge(app, transferEventBody('payment_submitted', { client_reference_id: 'unknown' }))

    expect(recordEvent).toHaveBeenCalledWith(expect.objectContaining({ transferId: null, providerRef: 'bt-1' }))
    await app.close()
  })

  it('acks a malformed transfer event (missing state) without recording', async () => {
    const app = await buildApp()
    const body = JSON.stringify({
      event_type: 'transfer.updated.status_transitioned',
      event_object: { id: 'bt-1', client_reference_id: TRANSFER_ID },
    })
    const res = await postBridge(app, body)

    expect(res.status).toBe(200)
    expect(recordEvent).not.toHaveBeenCalled()
    await app.close()
  })

  it('500s when recording fails so Bridge redelivers', async () => {
    from.mockReturnValueOnce(selectChain({ data: { id: TRANSFER_ID } }))
    recordEvent.mockRejectedValue(new Error('insert failed'))
    const app = await buildApp()

    const res = await postBridge(app, transferEventBody())

    expect(res.status).toBe(500)
    await app.close()
  })

  it('rejects a transfer event with a bad signature (400), no recording', async () => {
    const app = await buildApp()
    const body = transferEventBody()
    const res = await postBridge(app, body, 't=1,v0=bad')

    expect(res.status).toBe(400)
    expect(recordEvent).not.toHaveBeenCalled()
    await app.close()
  })
})
