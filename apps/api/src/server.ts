import './instrument.js'
import * as Sentry from '@sentry/node'
import Fastify from 'fastify'
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
import { recipientsRoute } from './routes/v1/recipients.js'
import { destinationsRoute } from './routes/v1/destinations.js'
import { quotesRoute } from './routes/v1/quotes.js'
import { webhooksRoute } from './routes/v1/webhooks.js'

// Fail boot on a bad DETAILS_ENCRYPTION_KEY — otherwise a wrong key stays
// invisible until the first payout decrypt.
assertEncryptionKeyUsable()

const server = Fastify({
  logger: {
    level: env.LOG_LEVEL,
    ...(env.NODE_ENV === 'development' && { transport: { target: 'pino-pretty' } }),
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
await server.register(recipientsRoute, { prefix: '/v1' })
await server.register(destinationsRoute, { prefix: '/v1' })
await server.register(quotesRoute, { prefix: '/v1' })
await server.register(webhooksRoute, { prefix: '/v1' })

try {
  await server.listen({ port: env.PORT, host: env.HOST })
} catch (err) {
  server.log.error(err)
  process.exit(1)
}
