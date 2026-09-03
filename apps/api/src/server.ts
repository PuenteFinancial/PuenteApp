import './instrument.js'
import * as Sentry from '@sentry/node'
import Fastify from 'fastify'
import type { FastifyRequest } from 'fastify'
import cors from '@fastify/cors'
import helmet from '@fastify/helmet'
import rateLimit from '@fastify/rate-limit'
import { env } from './config/env.js'
import { assertEncryptionKeyUsable } from './utils/encryption.js'
import { auditPlugin } from './plugins/audit.js'
import { authPlugin } from './plugins/auth.js'
import { errorHandlerPlugin } from './plugins/error-handler.js'
import { idempotencyPlugin } from './plugins/idempotency.js'
import { healthRoute } from './routes/v1/health.js'
import { waitlistRoute } from './routes/v1/waitlist.js'
import { authRoute } from './routes/v1/auth.js'
import { usersRoute } from './routes/v1/users.js'
import { consentsRoute } from './routes/v1/consents.js'
import { bridgeCustomerRoute } from './routes/v1/bridge-customer.js'
import { cryptoRoute } from './routes/v1/crypto.js'
import { recipientsRoute } from './routes/v1/recipients.js'
import { destinationsRoute } from './routes/v1/destinations.js'
import { quotesRoute } from './routes/v1/quotes.js'
import { transfersRoute } from './routes/v1/transfers.js'
import { webhooksRoute } from './routes/v1/webhooks.js'
import { devRoute, devEndpointsEnabled } from './routes/v1/dev.js'
import { opsRoute } from './routes/v1/ops.js'

// Fail boot on a bad DETAILS_ENCRYPTION_KEY — otherwise a wrong key stays
// invisible until the first payout decrypt.
assertEncryptionKeyUsable()

const server = Fastify({
  logger: {
    level: env.LOG_LEVEL,
    ...(env.NODE_ENV === 'development' && { transport: { target: 'pino-pretty' } }),
    serializers: {
      // Pino's default req serializer logs the full URL, query string included.
      // Query strings here can carry one-time secrets — the mobile KYC return
      // leg arrives as GET /v1/kyc/tos-return?state=<nonce>&signed_agreement_id=…
      // because iOS only intercepts a 302, so the nonce has nowhere else to
      // ride. Log the path and drop the query.
      //
      // Wholesale rather than a denylist of known-sensitive keys: a denylist
      // silently fails the next time someone adds a token to a query param, and
      // the ids worth having are already logged as structured fields by the
      // audit plugin rather than scraped out of URLs. Allowlist a specific
      // parameter here if one ever proves worth keeping.
      //
      // NOTE: this only covers OUR logs. Railway's edge sees the full URL and
      // its retention is not ours to set — which is why the nonce is single-use
      // and useless without the copy in the device keychain.
      req(request: FastifyRequest) {
        const [path] = request.url.split('?')
        const host = request.headers.host
        const remotePort = request.socket?.remotePort
        // Conditional spreads because exactOptionalPropertyTypes rejects an
        // explicit `undefined` for pino's optional serializer fields.
        return {
          method: request.method,
          url: path ?? request.url,
          remoteAddress: request.ip,
          ...(host !== undefined && { host }),
          ...(remotePort !== undefined && { remotePort }),
        }
      },
    },
  },
  // Railway's edge appends the real client IP as the RIGHTMOST X-Forwarded-For
  // entry; a hop count trusts exactly that. Without this, request.ip is the
  // proxy's address and every user shares the same rate-limit bucket. See
  // TRUST_PROXY_HOPS in config/env.ts for why `true` would be a bypass.
  trustProxy: env.TRUST_PROXY_HOPS === 0 ? false : env.TRUST_PROXY_HOPS,
})

Sentry.setupFastifyErrorHandler(server, {
  // 4xx are client mistakes (validation failures, bad tokens) — public
  // endpoints see these constantly and they'd drown out real faults
  shouldHandleError: (_error, _request, reply) => reply.statusCode >= 500,
})
await server.register(helmet)
await server.register(cors, {
  origin: env.ALLOWED_ORIGINS,
  credentials: true,
})
await server.register(rateLimit, {
  max: 100,
  timeWindow: '1 minute',
  errorResponseBuilder: (request, context) => ({
    error: {
      code: 'rate_limited',
      message: `Rate limit exceeded, retry in ${context.after}`,
      requestId: request.id,
    },
  }),
})

await server.register(errorHandlerPlugin)
await server.register(auditPlugin)
await server.register(authPlugin)
await server.register(idempotencyPlugin)
await server.register(healthRoute, { prefix: '/v1' })
await server.register(waitlistRoute, { prefix: '/v1' })
await server.register(authRoute, { prefix: '/v1' })
await server.register(usersRoute, { prefix: '/v1' })
await server.register(consentsRoute, { prefix: '/v1' })
await server.register(bridgeCustomerRoute, { prefix: '/v1' })
await server.register(cryptoRoute, { prefix: '/v1' })
await server.register(recipientsRoute, { prefix: '/v1' })
await server.register(destinationsRoute, { prefix: '/v1' })
await server.register(quotesRoute, { prefix: '/v1' })
await server.register(transfersRoute, { prefix: '/v1' })
await server.register(webhooksRoute, { prefix: '/v1' })
// Dev-only simulate-funding surface. Both controls default off (see dev.ts), so
// unless they are BOTH positively set the route is never registered and 404s
// from the router; the handler re-checks independently.
if (devEndpointsEnabled()) {
  await server.register(devRoute, { prefix: '/v1' })
}
// Read-only ops overview (slice 8.5-v1): registered only when an allowlist
// exists (fail closed — unset means the route 404s from the router); the
// handler re-checks membership independently, dev-route posture.
if (env.OPS_ADMIN_USER_IDS.size > 0) {
  await server.register(opsRoute, { prefix: '/v1' })
}

try {
  await server.listen({ port: env.PORT, host: env.HOST })
} catch (err) {
  server.log.error(err)
  process.exit(1)
}
