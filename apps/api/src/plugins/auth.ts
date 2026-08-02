import fp from 'fastify-plugin'
import type { FastifyInstance } from 'fastify'
import { createRemoteJWKSet, jwtVerify } from 'jose'
import { env } from '../config/env.js'
import { sendError } from '../utils/errors.js'

export const authPlugin = fp(async (server: FastifyInstance) => {
  // JWKS is fetched lazily and cached by jose — create once, not per request
  const jwks = createRemoteJWKSet(new URL(env.SUPABASE_JWKS_URL))

  // Claim pinning (slice 8.5-v1.1): signature-only verification was tolerable
  // while `sub` merely selected rows the caller already owned; once a token
  // grants ops write authority, accept only OUR project's user tokens.
  // - issuer: derived from SUPABASE_URL (hosted `https://<ref>.supabase.co/
  //   auth/v1`, local `http://127.0.0.1:54321/auth/v1`) — no new env var.
  // - audience: 'authenticated' — GoTrue's aud on every user access token.
  // - algorithms: the ASYMMETRIC set Supabase advertises, not just the one alg
  //   in today's JWKS. Both projects hold a single ES256 key right now but
  //   advertise RS256 too (/auth/v1/.well-known/openid-configuration, checked
  //   2026-08-01), so an ES256-only pin would turn a routine signing-key
  //   rotation into a total lockout — every user, every route, no deploy to
  //   blame. Excluding HS* is the part that carries the security value: it
  //   keeps a forged `alg:HS256` from being verified with the published public
  //   key as an HMAC secret (auth.test.ts pins that attack).
  const issuer = new URL('/auth/v1', env.SUPABASE_URL).href
  const verifyOptions = { issuer, audience: 'authenticated', algorithms: ['ES256', 'RS256'] }

  server.addHook('onRequest', async (request, reply) => {
    if (request.routeOptions?.config?.public) return

    const header = request.headers.authorization
    if (!header || !header.startsWith('Bearer ')) {
      return sendError(reply, 401, 'unauthorized', 'Unauthorized')
    }

    try {
      const { payload } = await jwtVerify(header.slice('Bearer '.length), jwks, verifyOptions)
      if (!payload.sub) throw new Error('token has no sub claim')
      request.user = { id: payload.sub }
    } catch {
      return sendError(reply, 401, 'unauthorized', 'Unauthorized')
    }
  })
})
