import fp from 'fastify-plugin'
import type { FastifyInstance } from 'fastify'
import { createRemoteJWKSet, jwtVerify } from 'jose'
import { env } from '../config/env.js'
import { sendError } from '../utils/errors.js'

export const authPlugin = fp(async (server: FastifyInstance) => {
  // JWKS is fetched lazily and cached by jose — create once, not per request
  const jwks = createRemoteJWKSet(new URL(env.SUPABASE_JWKS_URL))

  server.addHook('onRequest', async (request, reply) => {
    if (request.routeOptions?.config?.public) return

    const header = request.headers.authorization
    if (!header || !header.startsWith('Bearer ')) {
      return sendError(reply, 401, 'unauthorized', 'Unauthorized')
    }

    try {
      const { payload } = await jwtVerify(header.slice('Bearer '.length), jwks)
      if (!payload.sub) throw new Error('token has no sub claim')
      request.user = { id: payload.sub }
    } catch {
      return sendError(reply, 401, 'unauthorized', 'Unauthorized')
    }
  })
})
