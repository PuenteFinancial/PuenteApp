import { describe, it, expect, beforeEach, vi } from 'vitest'
import supertest from 'supertest'
import Fastify from 'fastify'

const from = vi.fn()

vi.mock('../../services/supabase.js', () => ({
  supabaseAdmin: { from: (...args: unknown[]) => from(...args) },
}))

const captureMessage = vi.fn()
const setFingerprint = vi.fn()
const setContext = vi.fn()

vi.mock('@sentry/node', () => ({
  captureMessage: (...args: unknown[]) => captureMessage(...args),
  withScope: (callback: (scope: unknown) => void) => callback({ setFingerprint, setContext }),
}))

const { waitlistRoute } = await import('./waitlist.js')

async function buildApp() {
  const app = Fastify({ logger: false })
  await app.register(waitlistRoute, { prefix: '/v1' })
  await app.ready()
  return app
}

const VALID_BODY = {
  first_name: 'María Santos',
  phone: '5551234567',
  destination_country: 'Mexico',
  referral_source: 'Instagram',
}

const SUBMISSION_A = '11111111-1111-4111-8111-111111111111'
const SUBMISSION_B = '22222222-2222-4222-8222-222222222222'

// A request shaped the way the real form sends one.
const BROWSER_BODY = {
  ...VALID_BODY,
  submission_id: SUBMISSION_A,
  attempt: 1,
  client_distinct_id: 'ph-distinct-1',
}

interface PriorRowFixture {
  created_at: string
  submission_id: string | null
  attempt: number | null
  client_distinct_id: string | null
  user_agent: string | null
}

function priorRow(overrides: Partial<PriorRowFixture> = {}): PriorRowFixture {
  return {
    created_at: new Date(Date.now() - 30_000).toISOString(),
    submission_id: SUBMISSION_A,
    attempt: 1,
    client_distinct_id: 'ph-distinct-1',
    user_agent: 'Mozilla/5.0',
    ...overrides,
  }
}

function mockWaitlistTable(
  opts: {
    prior?: PriorRowFixture[]
    priorError?: { message: string } | null
    insertError?: { message: string } | null
  } = {},
) {
  const insert = vi.fn(async () => ({ error: opts.insertError ?? null }))
  const limit = vi.fn(async () => ({ data: opts.prior ?? [], error: opts.priorError ?? null }))
  const order = vi.fn(() => ({ limit }))
  const eq = vi.fn(() => ({ order }))
  const select = vi.fn(() => ({ eq }))
  from.mockReturnValue({ insert, select })
  return { insert, select, eq, order, limit }
}

// The classification is the whole product of this instrumentation, so read it
// back the way an operator would: off the Sentry event.
function reportedClassification(): string | undefined {
  const call = captureMessage.mock.calls[0]
  if (!call) return undefined
  return String(call[0]).replace('waitlist duplicate submission: ', '')
}

beforeEach(() => {
  from.mockReset()
  captureMessage.mockReset()
  setFingerprint.mockReset()
  setContext.mockReset()
})

describe('POST /v1/waitlist', () => {
  it('inserts a signup with the 4 required fields', async () => {
    const { insert } = mockWaitlistTable()
    const app = await buildApp()

    const res = await supertest(app.server).post('/v1/waitlist').send(VALID_BODY)

    expect(res.status).toBe(200)
    expect(insert).toHaveBeenCalledWith(
      expect.objectContaining({
        first_name: 'María Santos',
        phone: '5551234567',
        destination_country: 'Mexico',
        referral_source: 'Instagram',
        referral_source_other: null,
      }),
    )
  })

  it('rejects a request missing destination_country', async () => {
    const app = await buildApp()
    const body: Record<string, string> = { ...VALID_BODY }
    delete body.destination_country

    const res = await supertest(app.server).post('/v1/waitlist').send(body)

    expect(res.status).toBe(400)
  })

  it('rejects a request missing referral_source', async () => {
    const app = await buildApp()
    const body: Record<string, string> = { ...VALID_BODY }
    delete body.referral_source

    const res = await supertest(app.server).post('/v1/waitlist').send(body)

    expect(res.status).toBe(400)
  })

  it('requires referral_source_other when referral_source is "Other"', async () => {
    const app = await buildApp()

    const res = await supertest(app.server)
      .post('/v1/waitlist')
      .send({ ...VALID_BODY, referral_source: 'Other' })

    expect(res.status).toBe(400)
    expect(res.body.error.code).toBe('validation_error')
  })

  it('stores referral_source_other when referral_source is "Other"', async () => {
    const { insert } = mockWaitlistTable()
    const app = await buildApp()

    const res = await supertest(app.server)
      .post('/v1/waitlist')
      .send({ ...VALID_BODY, referral_source: 'Other', referral_source_other: 'A radio ad' })

    expect(res.status).toBe(200)
    expect(insert).toHaveBeenCalledWith(
      expect.objectContaining({ referral_source: 'Other', referral_source_other: 'A radio ad' }),
    )
  })

  it('returns 500 when the insert fails', async () => {
    mockWaitlistTable({ insertError: { message: 'db down' } })
    const app = await buildApp()

    const res = await supertest(app.server).post('/v1/waitlist').send(VALID_BODY)

    expect(res.status).toBe(500)
  })
})

describe('POST /v1/waitlist — duplicate diagnostics', () => {
  it('stores the diagnostic fields on the row', async () => {
    const { insert } = mockWaitlistTable()
    const app = await buildApp()

    const res = await supertest(app.server)
      .post('/v1/waitlist')
      .send({ ...BROWSER_BODY, attempt: 2, prior_error: 'http_504' })

    expect(res.status).toBe(200)
    expect(insert).toHaveBeenCalledWith(
      expect.objectContaining({
        submission_id: SUBMISSION_A,
        attempt: 2,
        prior_error: 'http_504',
        client_distinct_id: 'ph-distinct-1',
      }),
    )
  })

  it('rejects a malformed submission_id instead of failing the insert', async () => {
    mockWaitlistTable()
    const app = await buildApp()

    const res = await supertest(app.server)
      .post('/v1/waitlist')
      .send({ ...VALID_BODY, submission_id: 'not-a-uuid' })

    expect(res.status).toBe(400)
  })

  it('looks up prior rows by digits-only phone', async () => {
    const { eq } = mockWaitlistTable()
    const app = await buildApp()

    await supertest(app.server)
      .post('/v1/waitlist')
      .send({ ...BROWSER_BODY, phone: '+1 (555) 123-4567' })

    expect(eq).toHaveBeenCalledWith('phone_normalized', '15551234567')
  })

  it('stays silent when the phone has never been seen', async () => {
    mockWaitlistTable({ prior: [] })
    const app = await buildApp()

    const res = await supertest(app.server).post('/v1/waitlist').send(BROWSER_BODY)

    expect(res.status).toBe(200)
    expect(captureMessage).not.toHaveBeenCalled()
  })

  it('classifies a retry that followed an apparent failure', async () => {
    mockWaitlistTable({ prior: [priorRow({ attempt: 1 })] })
    const app = await buildApp()

    const res = await supertest(app.server)
      .post('/v1/waitlist')
      .send({ ...BROWSER_BODY, attempt: 2, prior_error: 'http_504' })

    expect(res.status).toBe(200)
    expect(reportedClassification()).toBe('retry_after_apparent_failure')
    expect(setFingerprint).toHaveBeenCalledWith([
      'waitlist-duplicate',
      'retry_after_apparent_failure',
    ])
    expect(setContext).toHaveBeenCalledWith(
      'waitlist_duplicate',
      expect.objectContaining({ priorError: 'http_504', sameSubmissionId: true }),
    )
  })

  it('classifies two POSTs from a single click', async () => {
    mockWaitlistTable({ prior: [priorRow({ attempt: 1 })] })
    const app = await buildApp()

    await supertest(app.server).post('/v1/waitlist').send({ ...BROWSER_BODY, attempt: 1 })

    expect(reportedClassification()).toBe('double_fire_same_attempt')
  })

  it('classifies a fresh form session from the same browser as a repeat signup', async () => {
    mockWaitlistTable({ prior: [priorRow({ submission_id: SUBMISSION_B })] })
    const app = await buildApp()

    await supertest(app.server).post('/v1/waitlist').send(BROWSER_BODY)

    expect(reportedClassification()).toBe('repeat_signup_same_browser')
  })

  it('classifies a different browser as a separate repeat signup', async () => {
    mockWaitlistTable({
      prior: [priorRow({ submission_id: SUBMISSION_B, client_distinct_id: 'ph-distinct-2' })],
    })
    const app = await buildApp()

    await supertest(app.server).post('/v1/waitlist').send(BROWSER_BODY)

    expect(reportedClassification()).toBe('repeat_signup_other_browser')
  })

  it('classifies a caller with no form session as non-browser', async () => {
    mockWaitlistTable({ prior: [priorRow()] })
    const app = await buildApp()

    await supertest(app.server).post('/v1/waitlist').send(VALID_BODY)

    expect(reportedClassification()).toBe('non_browser_caller')
  })

  it('refuses to guess when the prior row predates the instrumentation', async () => {
    mockWaitlistTable({
      prior: [priorRow({ submission_id: null, attempt: null, client_distinct_id: null })],
    })
    const app = await buildApp()

    await supertest(app.server).post('/v1/waitlist').send(BROWSER_BODY)

    expect(reportedClassification()).toBe('unclassifiable_legacy_row')
  })

  it('never puts the phone number in the diagnostic payload', async () => {
    mockWaitlistTable({ prior: [priorRow()] })
    const app = await buildApp()

    await supertest(app.server).post('/v1/waitlist').send(BROWSER_BODY)

    const context = JSON.stringify(setContext.mock.calls[0]?.[1] ?? {})
    expect(context).not.toContain('5551234567')
    expect(context).not.toContain('María')
    expect(setContext).toHaveBeenCalledWith(
      'waitlist_duplicate',
      expect.objectContaining({ phoneKey: expect.stringMatching(/^[0-9a-f]{12}$/) }),
    )
  })

  it('still records the signup when the duplicate lookup fails', async () => {
    const { insert } = mockWaitlistTable({ priorError: { message: 'lookup exploded' } })
    const app = await buildApp()

    const res = await supertest(app.server).post('/v1/waitlist').send(BROWSER_BODY)

    expect(res.status).toBe(200)
    expect(insert).toHaveBeenCalled()
    expect(captureMessage).not.toHaveBeenCalled()
  })

  it('does not report a duplicate when the row never landed', async () => {
    mockWaitlistTable({ prior: [priorRow()], insertError: { message: 'db down' } })
    const app = await buildApp()

    const res = await supertest(app.server).post('/v1/waitlist').send(BROWSER_BODY)

    expect(res.status).toBe(500)
    expect(captureMessage).not.toHaveBeenCalled()
  })
})
