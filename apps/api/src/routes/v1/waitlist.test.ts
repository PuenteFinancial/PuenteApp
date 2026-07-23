import { describe, it, expect, beforeEach, vi } from 'vitest'
import supertest from 'supertest'
import Fastify from 'fastify'

const from = vi.fn()

vi.mock('../../services/supabase.js', () => ({
  supabaseAdmin: { from: (...args: unknown[]) => from(...args) },
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

beforeEach(() => {
  from.mockReset()
})

describe('POST /v1/waitlist', () => {
  it('inserts a signup with the 4 required fields', async () => {
    const insertSpy = vi.fn(async () => ({ error: null }))
    from.mockReturnValue({ insert: insertSpy })
    const app = await buildApp()

    const res = await supertest(app.server).post('/v1/waitlist').send(VALID_BODY)

    expect(res.status).toBe(200)
    expect(insertSpy).toHaveBeenCalledWith(
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
    const insertSpy = vi.fn(async () => ({ error: null }))
    from.mockReturnValue({ insert: insertSpy })
    const app = await buildApp()

    const res = await supertest(app.server)
      .post('/v1/waitlist')
      .send({ ...VALID_BODY, referral_source: 'Other', referral_source_other: 'A radio ad' })

    expect(res.status).toBe(200)
    expect(insertSpy).toHaveBeenCalledWith(
      expect.objectContaining({ referral_source: 'Other', referral_source_other: 'A radio ad' }),
    )
  })

  it('returns 500 when the insert fails', async () => {
    const insertSpy = vi.fn(async () => ({ error: { message: 'db down' } }))
    from.mockReturnValue({ insert: insertSpy })
    const app = await buildApp()

    const res = await supertest(app.server).post('/v1/waitlist').send(VALID_BODY)

    expect(res.status).toBe(500)
  })
})
