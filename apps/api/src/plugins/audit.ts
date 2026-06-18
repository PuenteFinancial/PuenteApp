import fp from 'fastify-plugin'
import type { FastifyInstance } from 'fastify'

/**
 * Audit plugin — logs every request that touches authenticated routes.
 * Logs user ID, route, method, timestamp. NEVER logs PII values.
 * Required for GLBA Safeguards Rule compliance.
 */
export const auditPlugin = fp(async (server: FastifyInstance) => {
  server.addHook('onRequest', async (request) => {
    // Skip public routes and health checks
    if ((request.routeOptions?.config as { public?: boolean })?.public) return
    if (request.url === '/v1/health') return

    server.log.info({
      audit: true,
      method: request.method,
      url: request.url,
      ip: request.ip,
      userAgent: request.headers['user-agent'],
      // userId attached after JWT verification — logged in onSend if available
    })
  })

  server.addHook('onSend', async (request, _reply, payload) => {
    const user = request.user as { id?: string } | undefined
    if (!user?.id) return payload

    server.log.info({
      audit: true,
      userId: user.id,
      method: request.method,
      url: request.url,
      // Do NOT log request body or response body — may contain PII
    })

    return payload
  })
})
