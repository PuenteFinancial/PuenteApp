import type { FastifyInstance } from 'fastify'
import { supabaseAdmin, supabaseAuth } from '../../services/supabase.js'

interface OtpSendBody {
  phone: string
  smsConsent: boolean
}

interface OtpVerifyBody {
  phone: string
  token: string
}

interface RefreshBody {
  refreshToken: string
}

export async function authRoute(server: FastifyInstance) {
  server.post<{ Body: OtpSendBody }>(
    '/auth/otp/send',
    {
      config: { public: true },
      schema: {
        body: {
          type: 'object',
          required: ['phone', 'smsConsent'],
          properties: {
            phone: { type: 'string', minLength: 1 },
            // TCPA: no SMS without affirmative consent — enforced server-side
            smsConsent: { type: 'boolean', const: true },
          },
          additionalProperties: false,
        },
        response: {
          200: {
            type: 'object',
            properties: { message: { type: 'string' } },
          },
        },
      },
    },
    async (request, reply) => {
      const { error } = await supabaseAuth.auth.signInWithOtp({
        phone: request.body.phone,
        options: { channel: 'sms' },
      })

      if (error) {
        // log status only — never the phone number
        server.log.error({ authError: error.status }, 'otp send failed')
        return reply.status(500).send({ error: 'Failed to send code' })
      }

      return { message: 'OTP sent' }
    },
  )

  server.post<{ Body: OtpVerifyBody }>(
    '/auth/otp/verify',
    {
      config: { public: true },
      schema: {
        body: {
          type: 'object',
          required: ['phone', 'token'],
          properties: {
            phone: { type: 'string', minLength: 1 },
            token: { type: 'string', minLength: 1 },
          },
          additionalProperties: false,
        },
        response: {
          200: {
            type: 'object',
            properties: {
              accessToken: { type: 'string' },
              refreshToken: { type: 'string' },
              expiresIn: { type: 'number' },
              userId: { type: 'string' },
            },
          },
        },
      },
    },
    async (request, reply) => {
      const { data, error } = await supabaseAuth.auth.verifyOtp({
        phone: request.body.phone,
        token: request.body.token,
        type: 'sms',
      })

      if (error || !data.session || !data.user) {
        return reply.status(401).send({ error: 'Invalid or expired code' })
      }

      // The users row normally exists via the on-auth-user-created trigger,
      // but rows deleted out-of-band (or predating the trigger) left every
      // profile save 500ing. Self-heal here. ignoreDuplicates is load-bearing:
      // an existing row must never have its kyc_status or profile reset.
      // Non-fatal — a failed write must not block sign-in.
      const { error: upsertError } = await supabaseAdmin.from('users').upsert(
        { id: data.user.id, phone: data.user.phone, kyc_status: 'not_started' },
        { onConflict: 'id', ignoreDuplicates: true },
      )

      if (upsertError) {
        server.log.warn(
          { userId: data.user.id, supabaseError: upsertError.code },
          'users row self-heal upsert failed',
        )
      }

      // TCPA consent was collected on the signup form before the OTP was
      // sent; the row only exists now, so this is the earliest it can be
      // recorded. Non-fatal — a failed write must not block sign-in.
      const { error: consentError } = await supabaseAdmin
        .from('users')
        .update({ sms_consent_at: new Date().toISOString() })
        .eq('id', data.user.id)
        .is('sms_consent_at', null)

      if (consentError) {
        server.log.warn(
          { userId: data.user.id, supabaseError: consentError.code },
          'sms consent timestamp write failed',
        )
      }

      // Durable per-sign-in record (risk substrate — no UI). Browser traffic
      // arrives via the Next.js proxy, so the real client IP/UA ride in
      // x-client-ip / x-client-ua; request.ip is the fallback for direct
      // callers. The route is public, so a direct caller can spoof headers —
      // they only mislabel their own sign-in, acceptable for risk data.
      // Non-fatal — a failed write must not block sign-in. Log the error code
      // only: IP/UA live in the table, never in logs, and a failed inet parse
      // would echo the value into error.message.
      const forwardedIp = request.headers['x-client-ip']
      const forwardedUa = request.headers['x-client-ua']
      const userAgent =
        (typeof forwardedUa === 'string' ? forwardedUa : request.headers['user-agent']) || null
      const { error: signInEventError } = await supabaseAdmin.from('sign_in_events').insert({
        user_id: data.user.id,
        ip: (typeof forwardedIp === 'string' ? forwardedIp : request.ip) || null,
        // real UAs are <300 chars; cap so a hostile caller can't pad rows
        user_agent: userAgent?.slice(0, 512) ?? null,
        auth_method: 'sms_otp',
      })

      if (signInEventError) {
        server.log.warn(
          { userId: data.user.id, supabaseError: signInEventError.code },
          'sign_in_events insert failed',
        )
      }

      return {
        accessToken: data.session.access_token,
        refreshToken: data.session.refresh_token,
        expiresIn: data.session.expires_in,
        userId: data.user.id,
      }
    },
  )

  server.post<{ Body: RefreshBody }>(
    '/auth/refresh',
    {
      // Public by definition: the caller's access token is already expired.
      config: { public: true },
      schema: {
        body: {
          type: 'object',
          required: ['refreshToken'],
          properties: {
            refreshToken: { type: 'string', minLength: 1 },
          },
          additionalProperties: false,
        },
        response: {
          200: {
            type: 'object',
            properties: {
              accessToken: { type: 'string' },
              refreshToken: { type: 'string' },
              expiresIn: { type: 'number' },
              userId: { type: 'string' },
            },
          },
        },
      },
    },
    async (request, reply) => {
      // Session-minting GoTrue call — must stay on supabaseAuth, never
      // supabaseAdmin (see services/supabase.ts). Refresh tokens rotate and
      // are single-use; GoTrue's reuse-interval grace absorbs concurrent-tab
      // races, so one attempt is enough.
      const { data, error } = await supabaseAuth.auth.refreshSession({
        refresh_token: request.body.refreshToken,
      })

      if (error || !data.session || !data.user) {
        // log status only — never the token
        server.log.info({ authError: error?.status }, 'session refresh rejected')
        return reply.status(401).send({ error: 'Invalid or expired session' })
      }

      return {
        accessToken: data.session.access_token,
        refreshToken: data.session.refresh_token,
        expiresIn: data.session.expires_in,
        userId: data.user.id,
      }
    },
  )
}
