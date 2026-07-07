import type { FastifyInstance } from 'fastify'
import { supabaseAdmin } from '../../services/supabase.js'

interface OtpSendBody {
  phone: string
  smsConsent: boolean
}

interface OtpVerifyBody {
  phone: string
  token: string
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
      const { error } = await supabaseAdmin.auth.signInWithOtp({
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
      const { data, error } = await supabaseAdmin.auth.verifyOtp({
        phone: request.body.phone,
        token: request.body.token,
        type: 'sms',
      })

      if (error || !data.session || !data.user) {
        return reply.status(401).send({ error: 'Invalid or expired code' })
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

      return {
        accessToken: data.session.access_token,
        refreshToken: data.session.refresh_token,
        expiresIn: data.session.expires_in,
        userId: data.user.id,
      }
    },
  )
}
