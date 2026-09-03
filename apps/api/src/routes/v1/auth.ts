import type { FastifyInstance } from 'fastify'
import { admitOtpSend, admitOtpVerify } from '../../services/otp-rate-limit.js'
import { supabaseAdmin, supabaseAuth } from '../../services/supabase.js'
import { sendError, errorResponseSchema } from '../../utils/errors.js'

// North American Numbering Plan: `1`, area code, exchange, line — with the
// standard rule that neither the area code nor the exchange may begin with 0
// or 1. Matches the wire format the clients send (normalizePhone in
// packages/shared emits bare digits with `1` prepended, no `+`).
//
// THIS IS AN ALLOWLIST, NOT A FORMAT CHECK. `525512345678` is perfectly
// well-formed E.164 and is refused anyway. The point is SMS pumping: that fraud
// only pays on expensive international termination, so restricting the
// destination range removes the motive rather than merely slowing it down.
//
// Two things this deliberately is not:
//   - It is not "US only". `1` is NANP, which includes Canada and ~20 Caribbean
//     countries. Filtering to real US area codes is brittle (they get added)
//     and would wrongly exclude Puerto Rico and USVI users, who ARE US
//     residents. This is the pragmatic line, not the tight one.
//   - It is not protection against a user typing a Mexican number. Those are
//     also ten digits, so normalizePhone turns one into a well-formed US number
//     that passes this check (see the note on that function). Only a visible
//     `+1` in the input fixes that.
//
// It encodes a product decision as much as a security one: the sender is a US
// resident, and the Mexican recipient never holds an account or receives an
// OTP. The day senders outside NANP are in scope, this changes.
const NANP_PHONE_PATTERN = '^1[2-9]\\d{2}[2-9]\\d{6}$'

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
            phone: { type: 'string', pattern: NANP_PHONE_PATTERN },
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
          400: errorResponseSchema,
          429: errorResponseSchema,
        },
      },
    },
    async (request, reply) => {
      // Budget check BEFORE the provider call, and it records the attempt as it
      // admits it — see services/otp-rate-limit.ts for why admission rather
      // than success is what gets counted.
      const admission = await admitOtpSend(request.body.phone)
      if (!admission.allowed) {
        void reply.header('Retry-After', String(admission.retryAfterSeconds))
        return sendError(
          reply,
          429,
          'rate_limited',
          'Too many codes requested. Wait a moment and try again.',
        )
      }

      const { error } = await supabaseAuth.auth.signInWithOtp({
        phone: request.body.phone,
        options: { channel: 'sms' },
      })

      if (error) {
        // log status only — never the phone number
        server.log.error({ authError: error.status }, 'otp send failed')
        return sendError(reply, 500, 'internal_error', 'Failed to send code')
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
            // Same allowlist as the send leg. A code can only exist for a
            // number we agreed to send to, so anything outside the range is
            // unanswerable by construction — rejecting it here keeps the two
            // legs from disagreeing about what a valid number is.
            phone: { type: 'string', pattern: NANP_PHONE_PATTERN },
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
          429: errorResponseSchema,
        },
      },
    },
    async (request, reply) => {
      // The brute-force bound (K7a). Admitted — and counted — BEFORE GoTrue is
      // asked, so a refused guess never reaches the provider; see
      // services/otp-rate-limit.ts for why admission rather than failure is
      // what gets counted. Same 429 shape as the send leg; the clients already
      // render it.
      const admission = await admitOtpVerify(request.body.phone)
      if (!admission.allowed) {
        void reply.header('Retry-After', String(admission.retryAfterSeconds))
        return sendError(
          reply,
          429,
          'rate_limited',
          'Too many attempts. Wait a moment and try again.',
        )
      }

      const { data, error } = await supabaseAuth.auth.verifyOtp({
        phone: request.body.phone,
        token: request.body.token,
        type: 'sms',
      })

      if (error || !data.session || !data.user) {
        return sendError(reply, 401, 'unauthorized', 'Invalid or expired code')
      }

      // The users row normally exists via the on-auth-user-created trigger,
      // but rows deleted out-of-band (or predating the trigger) left every
      // profile save 500ing. Self-heal here. ignoreDuplicates is load-bearing:
      // an existing row must never have its kyc_status or profile reset.
      // Non-fatal — a failed write must not block sign-in.
      // `phone` is stored in GoTrue's shape (bare digits, no `+`) — the same
      // shape the signup trigger copies from auth.users. The API normalizes to
      // E.164 at its read boundary (routes/v1/users.ts) rather than holding the
      // one identity in two formats across two tables.
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
        return sendError(reply, 401, 'unauthorized', 'Invalid or expired session')
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
