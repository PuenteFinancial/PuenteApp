import fp from 'fastify-plugin'
import type { FastifyInstance } from 'fastify'

// onResponse (not onRequest) so request.user — populated by the auth
// plugin's onRequest hook — is available for attribution
export const auditPlugin = fp(async (server: FastifyInstance) => {
  server.addHook('onResponse', async (request, reply) => {
    if ((request.routeOptions?.config as { public?: boolean })?.public) return
    // Compare the path, not the raw URL: /v1/health?x=1 is still the probe.
    if (request.url.split('?')[0] === '/v1/health') return

    server.log.info({
      audit: true,
      userId: request.user?.id,
      method: request.method,
      // PATH ONLY — the query string is deliberately dropped (audit
      // 2026-09-02). No route puts PII in a query param today, because
      // CLAUDE.md forbids it, but this log is durable and centralized: it is
      // exactly where one future route's mistake would quietly turn the audit
      // trail into a PII store. Path params stay — an id is attribution.
      // A route that genuinely needs filter context in the trail should log
      // named, vetted fields rather than re-widening this to the raw URL.
      url: request.url.split('?')[0],
      statusCode: reply.statusCode,
      ip: request.ip,
      userAgent: request.headers['user-agent'],
    })
  })
})
