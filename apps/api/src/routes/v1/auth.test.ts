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
const from = vi.fn((..._args: unknown[]) => ({
  update: vi.fn(() => ({ eq: vi.fn(() => ({ is: consentIs })) })),
  upsert: (...args: unknown[]) => upsert(...args),
}))

vi.mock('../../services/supabase.js', () => ({
  // DB access is service-role; session-minting GoTrue calls live on a
  // separate client so they can't pollute the admin client's identity
  supabaseAdmin: {
    from: (...args: unknown[]) => from(...args),
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
