import fp from 'fastify-plugin'
import type { FastifyInstance } from 'fastify'

export const auditPlugin = fp(async (server: FastifyInstance) => {
  server.addHook('onRequest', async (request) => {
    if ((request.routeOptions?.config as { public?: boolean })?.public) return
    if (request.url === '/v1/health') return

    server.log.info({
      audit: true,
      method: request.method,
      url: request.url,
      ip: request.ip,
      userAgent: request.headers['user-agent'],
    })
  })
})
