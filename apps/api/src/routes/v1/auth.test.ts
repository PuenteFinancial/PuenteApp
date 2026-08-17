import { describe, it, expect, beforeAll, afterAll, vi, beforeEach } from 'vitest'
import supertest from 'supertest'
import Fastify from 'fastify'

const signInWithOtp = vi.fn()
const verifyOtp = vi.fn()
const refreshSession = vi.fn()
const consentIs = vi.fn(async () => ({ error: null }))
const upsert = vi.fn(
  async (..._args: unknown[]): Promise<{ error: { code: string } | null }> => ({ error: null }),
)
const signInInsert = vi.fn(
  async (..._args: unknown[]): Promise<{ error: { code: string } | null }> => ({ error: null }),
)
// The per-phone limiter calls otp_attempt_admit through supabaseAdmin.rpc.
// Defaults to admitting, so every pre-existing test keeps exercising the path
// it was written for; the rate-limit tests below override it per case.
const rpc = vi.fn(
  async (
    ..._args: unknown[]
  ): Promise<{ data: unknown; error: { message: string } | null }> => ({
    data: [{ allowed: true, retry_after_seconds: 0 }],
    error: null,
  }),
)

const from = vi.fn((table: string) => {
  if (table === 'sign_in_events') {
    return { insert: (...args: unknown[]) => signInInsert(...args) }
  }
  return {
    update: vi.fn(() => ({ eq: vi.fn(() => ({ is: consentIs })) })),
    upsert: (...args: unknown[]) => upsert(...args),
  }
})

vi.mock('../../services/supabase.js', () => ({
  // DB access is service-role; session-minting GoTrue calls live on a
  // separate client so they can't pollute the admin client's identity
  supabaseAdmin: {
    from: (table: string) => from(table),
    rpc: (...args: unknown[]) => rpc(...args),
  },
  supabaseAuth: {
    auth: {
      signInWithOtp: (...args: unknown[]) => signInWithOtp(...args),
      verifyOtp: (...args: unknown[]) => verifyOtp(...args),
      refreshSession: (...args: unknown[]) => refreshSession(...args),
    },
  },
}))

const { authRoute } = await import('./auth.js')

describe('auth OTP routes', () => {
  let app: ReturnType<typeof Fastify>

  beforeAll(async () => {
    app = Fastify({ logger: false })
    await app.register(authRoute, { prefix: '/v1' })
    await app.ready()
  })

  afterAll(() => app.close())

  beforeEach(() => {
    signInWithOtp.mockReset()
    verifyOtp.mockReset()
    refreshSession.mockReset()
    from.mockClear()
    consentIs.mockClear()
    upsert.mockClear()
    upsert.mockResolvedValue({ error: null })
    signInInsert.mockClear()
    signInInsert.mockResolvedValue({ error: null })
    rpc.mockClear()
    rpc.mockResolvedValue({ data: [{ allowed: true, retry_after_seconds: 0 }], error: null })
  })

  describe('POST /v1/auth/otp/send', () => {
    it('sends an OTP via SMS', async () => {
      signInWithOtp.mockResolvedValue({ data: {}, error: null })

      const res = await supertest(app.server)
        .post('/v1/auth/otp/send')
        .send({ phone: '15555555555', smsConsent: true })

      expect(res.status).toBe(200)
      expect(res.body).toEqual({ message: 'OTP sent' })
      expect(signInWithOtp).toHaveBeenCalledWith({
        phone: '15555555555',
        options: { channel: 'sms' },
      })
    })

    it('returns 400 when phone is missing', async () => {
      const res = await supertest(app.server)
        .post('/v1/auth/otp/send')
        .send({ smsConsent: true })
      expect(res.status).toBe(400)
      expect(signInWithOtp).not.toHaveBeenCalled()
    })

    it('returns 400 without SMS consent (TCPA)', async () => {
      for (const body of [{ phone: '15555555555' }, { phone: '15555555555', smsConsent: false }]) {
        const res = await supertest(app.server).post('/v1/auth/otp/send').send(body)
        expect(res.status).toBe(400)
      }
      expect(signInWithOtp).not.toHaveBeenCalled()
    })

    // The allowlist is the anti-SMS-pumping control: that fraud only pays on
    // expensive international termination, so a refused number must never reach
    // the provider at all. Asserting `not.toHaveBeenCalled()` is the assertion
    // that matters — a 400 after the send would cost the same money.
    it.each([
      ['a Mexican number', '525512345678'],
      ['a UK number', '447700900123'],
      ['a premium-rate international range', '881612345678'],
      ['E.164 with the leading plus', '+15555555555'],
      ['a bare ten-digit number, no country code', '5555555555'],
      ['an area code starting with 1', '11555555555'],
      ['an exchange starting with 0', '15550555555'],
      ['too few digits', '1555555555'],
      ['too many digits', '155555555555'],
      ['letters', '1555555555a'],
    ])('rejects %s without calling the provider', async (_case, phone) => {
      const res = await supertest(app.server)
        .post('/v1/auth/otp/send')
        .send({ phone, smsConsent: true })

      expect(res.status).toBe(400)
      expect(signInWithOtp).not.toHaveBeenCalled()
      // Nor should a refused format consume any of that number's budget.
      expect(rpc).not.toHaveBeenCalled()
    })

    it('admits the send before calling the provider, not after', async () => {
      signInWithOtp.mockResolvedValue({ data: {}, error: null })

      await supertest(app.server)
        .post('/v1/auth/otp/send')
        .send({ phone: '15555555555', smsConsent: true })

      // Admission control: the attempt is recorded when it is admitted, so a
      // caller who can induce provider errors cannot spin for free.
      expect(rpc).toHaveBeenCalledWith('otp_attempt_admit', expect.any(Object))
      const admitOrder = rpc.mock.invocationCallOrder.at(0) ?? Infinity
      const sendOrder = signInWithOtp.mock.invocationCallOrder.at(0) ?? -Infinity
      expect(admitOrder).toBeLessThan(sendOrder)
    })

    it('never puts the phone number in the rpc arguments', async () => {
      signInWithOtp.mockResolvedValue({ data: {}, error: null })

      await supertest(app.server)
        .post('/v1/auth/otp/send')
        .send({ phone: '15555555555', smsConsent: true })

      // The bucket key is a peppered HMAC precisely so this table can exist
      // under the no-PII rule. A raw number reaching the DB is the failure.
      const args = JSON.stringify(rpc.mock.calls[0])
      expect(args).not.toContain('15555555555')
      expect(args).toMatch(/[0-9a-f]{64}/)
    })

    it('returns 429 with Retry-After when the number is over budget', async () => {
      rpc.mockResolvedValue({ data: [{ allowed: false, retry_after_seconds: 42 }], error: null })

      const res = await supertest(app.server)
        .post('/v1/auth/otp/send')
        .send({ phone: '15555555555', smsConsent: true })

      expect(res.status).toBe(429)
      expect(res.body.error.code).toBe('rate_limited')
      expect(res.headers['retry-after']).toBe('42')
      expect(signInWithOtp).not.toHaveBeenCalled()
    })

    it('fails closed when the limiter itself errors', async () => {
      rpc.mockResolvedValue({ data: null, error: { message: 'connection refused' } })

      const res = await supertest(app.server)
        .post('/v1/auth/otp/send')
        .send({ phone: '15555555555', smsConsent: true })

      // Opposite of the usual login-path advice, deliberately: the downside
      // here is a bill, not an inconvenience, and a limiter that opens under
      // load is not a limiter.
      expect(res.status).toBe(429)
      expect(signInWithOtp).not.toHaveBeenCalled()
    })

    it('answers identically for a number with no account (no enumeration oracle)', async () => {
      // The limit is keyed only on the number supplied, and the handler's reply
      // is a flat message either way. A response that differed for known vs
      // unknown numbers would turn this public endpoint into an account probe.
      signInWithOtp.mockResolvedValue({ data: {}, error: null })
      const known = await supertest(app.server)
        .post('/v1/auth/otp/send')
        .send({ phone: '15555555555', smsConsent: true })

      signInWithOtp.mockResolvedValue({ data: {}, error: null })
      const unknown = await supertest(app.server)
        .post('/v1/auth/otp/send')
        .send({ phone: '12125550123', smsConsent: true })

      expect(known.status).toBe(unknown.status)
      expect(known.body).toEqual(unknown.body)
    })

    it('returns 500 when Supabase rejects the send', async () => {
      signInWithOtp.mockResolvedValue({ data: {}, error: { status: 429 } })

      const res = await supertest(app.server)
        .post('/v1/auth/otp/send')
        .send({ phone: '15555555555', smsConsent: true })

      expect(res.status).toBe(500)
    })
  })

  describe('POST /v1/auth/otp/verify', () => {
    it('returns tokens for a valid code', async () => {
      verifyOtp.mockResolvedValue({
        data: {
          session: {
            access_token: 'access-abc',
            refresh_token: 'refresh-abc',
            expires_in: 3600,
          },
          user: { id: 'user-123', phone: '15555555555' },
        },
        error: null,
      })

      const res = await supertest(app.server)
        .post('/v1/auth/otp/verify')
        .send({ phone: '15555555555', token: '123456' })

      expect(res.status).toBe(200)
      expect(res.body).toEqual({
        accessToken: 'access-abc',
        refreshToken: 'refresh-abc',
        expiresIn: 3600,
        userId: 'user-123',
      })
      // missing users row self-heals — without ever touching an existing one
      expect(upsert).toHaveBeenCalledWith(
        { id: 'user-123', phone: '15555555555', kyc_status: 'not_started' },
        { onConflict: 'id', ignoreDuplicates: true },
      )
      // sms_consent_at recorded once the user row exists
      expect(from).toHaveBeenCalledWith('users')
      expect(consentIs).toHaveBeenCalledWith('sms_consent_at', null)
    })

    it('still returns tokens when the self-heal upsert fails', async () => {
      verifyOtp.mockResolvedValue({
        data: {
          session: {
            access_token: 'access-abc',
            refresh_token: 'refresh-abc',
            expires_in: 3600,
          },
          user: { id: 'user-123', phone: '15555555555' },
        },
        error: null,
      })
      upsert.mockResolvedValue({ error: { code: '23505' } })

      const res = await supertest(app.server)
        .post('/v1/auth/otp/verify')
        .send({ phone: '15555555555', token: '123456' })

      expect(res.status).toBe(200)
      expect(res.body.accessToken).toBe('access-abc')
    })

    it('records a sign_in_events row with the forwarded client IP and UA', async () => {
      verifyOtp.mockResolvedValue({
        data: {
          session: {
            access_token: 'access-abc',
            refresh_token: 'refresh-abc',
            expires_in: 3600,
          },
          user: { id: 'user-123', phone: '15555555555' },
        },
        error: null,
      })

      const res = await supertest(app.server)
        .post('/v1/auth/otp/verify')
        .set('x-client-ip', '203.0.113.7')
        .set('x-client-ua', 'Mozilla/5.0 (iPhone)')
        .send({ phone: '15555555555', token: '123456' })

      expect(res.status).toBe(200)
      expect(signInInsert).toHaveBeenCalledWith({
        user_id: 'user-123',
        ip: '203.0.113.7',
        user_agent: 'Mozilla/5.0 (iPhone)',
        auth_method: 'sms_otp',
      })
    })

    it('falls back to the socket IP and UA header when nothing is forwarded', async () => {
      verifyOtp.mockResolvedValue({
        data: {
          session: {
            access_token: 'access-abc',
            refresh_token: 'refresh-abc',
            expires_in: 3600,
          },
          user: { id: 'user-123', phone: '15555555555' },
        },
        error: null,
      })

      const res = await supertest(app.server)
        .post('/v1/auth/otp/verify')
        .set('User-Agent', 'direct-caller/1.0')
        .send({ phone: '15555555555', token: '123456' })

      expect(res.status).toBe(200)
      expect(signInInsert).toHaveBeenCalledWith({
        user_id: 'user-123',
        ip: expect.any(String), // supertest's loopback socket address
        user_agent: 'direct-caller/1.0',
        auth_method: 'sms_otp',
      })
    })

    it('still returns tokens when the sign_in_events insert fails', async () => {
      verifyOtp.mockResolvedValue({
        data: {
          session: {
            access_token: 'access-abc',
            refresh_token: 'refresh-abc',
            expires_in: 3600,
          },
          user: { id: 'user-123', phone: '15555555555' },
        },
        error: null,
      })
      signInInsert.mockResolvedValue({ error: { code: '22P02' } })

      const res = await supertest(app.server)
        .post('/v1/auth/otp/verify')
        .send({ phone: '15555555555', token: '123456' })

      expect(res.status).toBe(200)
      expect(res.body.accessToken).toBe('access-abc')
    })

    it('returns 401 for an invalid code', async () => {
      verifyOtp.mockResolvedValue({
        data: { session: null, user: null },
        error: { status: 401 },
      })

      const res = await supertest(app.server)
        .post('/v1/auth/otp/verify')
        .send({ phone: '15555555555', token: '000000' })

      expect(res.status).toBe(401)
      expect(from).not.toHaveBeenCalled()
      expect(signInInsert).not.toHaveBeenCalled()
    })

    it('rejects a non-NANP number without calling the provider', async () => {
      const res = await supertest(app.server)
        .post('/v1/auth/otp/verify')
        .send({ phone: '525512345678', token: '123456' })

      expect(res.status).toBe(400)
      expect(verifyOtp).not.toHaveBeenCalled()
    })

    it('returns 400 when token is missing', async () => {
      const res = await supertest(app.server)
        .post('/v1/auth/otp/verify')
        .send({ phone: '15555555555' })
      expect(res.status).toBe(400)
      expect(verifyOtp).not.toHaveBeenCalled()
    })
  })

  describe('POST /v1/auth/refresh', () => {
    it('exchanges a refresh token for a new session', async () => {
      refreshSession.mockResolvedValue({
        data: {
          session: {
            access_token: 'access-new',
            refresh_token: 'refresh-new',
            expires_in: 3600,
          },
          user: { id: 'user-123' },
        },
        error: null,
      })

      const res = await supertest(app.server)
        .post('/v1/auth/refresh')
        .send({ refreshToken: 'refresh-old' })

      expect(res.status).toBe(200)
      expect(res.body).toEqual({
        accessToken: 'access-new',
        refreshToken: 'refresh-new',
        expiresIn: 3600,
        userId: 'user-123',
      })
      // rotation: the old token is spent, the response carries its successor
      expect(refreshSession).toHaveBeenCalledWith({ refresh_token: 'refresh-old' })
    })

    it('returns 401 for an invalid or expired refresh token', async () => {
      refreshSession.mockResolvedValue({
        data: { session: null, user: null },
        error: { status: 400 },
      })

      const res = await supertest(app.server)
        .post('/v1/auth/refresh')
        .send({ refreshToken: 'refresh-spent' })

      expect(res.status).toBe(401)
    })

    it('returns 400 when refreshToken is missing', async () => {
      const res = await supertest(app.server).post('/v1/auth/refresh').send({})
      expect(res.status).toBe(400)
      expect(refreshSession).not.toHaveBeenCalled()
    })
  })
})
