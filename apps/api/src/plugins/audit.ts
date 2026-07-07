import fp from 'fastify-plugin'
import type { FastifyInstance } from 'fastify'

// onResponse (not onRequest) so request.user — populated by the auth
// plugin's onRequest hook — is available for attribution
export const auditPlugin = fp(async (server: FastifyInstance) => {
  server.addHook('onResponse', async (request, reply) => {
    if ((request.routeOptions?.config as { public?: boolean })?.public) return
    if (request.url === '/v1/health') return

    server.log.info({
      audit: true,
      userId: request.user?.id,
      method: request.method,
      url: request.url,
      statusCode: reply.statusCode,
      ip: request.ip,
      userAgent: request.headers['user-agent'],
    })
  })
})
