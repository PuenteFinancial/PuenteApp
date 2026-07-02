import './instrument.js'
import * as Sentry from '@sentry/node'
import Fastify from 'fastify'
import cors from '@fastify/cors'
import helmet from '@fastify/helmet'
import rateLimit from '@fastify/rate-limit'
import { env } from './config/env.js'
import { auditPlugin } from './plugins/audit.js'
import { healthRoute } from './routes/v1/health.js'
import { waitlistRoute } from './routes/v1/waitlist.js'

const server = Fastify({
  logger: {
    level: env.LOG_LEVEL,
    ...(env.NODE_ENV === 'development' && { transport: { target: 'pino-pretty' } }),
  },
})

Sentry.setupFastifyErrorHandler(server)
await server.register(helmet)
await server.register(cors, {
  origin: env.ALLOWED_ORIGINS,
  credentials: true,
})
await server.register(rateLimit, {
  max: 100,
  timeWindow: '1 minute',
})
await server.register(auditPlugin)
await server.register(healthRoute, { prefix: '/v1' })
await server.register(waitlistRoute, { prefix: '/v1' })

try {
  await server.listen({ port: env.PORT, host: env.HOST })
} catch (err) {
  server.log.error(err)
  process.exit(1)
}
