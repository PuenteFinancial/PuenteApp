import Fastify from 'fastify'
import cors from '@fastify/cors'
import helmet from '@fastify/helmet'
import rateLimit from '@fastify/rate-limit'
import jwt from '@fastify/jwt'
import { healthRoute } from './routes/v1/health.js'
import { creditRoute } from './routes/v1/credit.js'
import { authRoute } from './routes/v1/auth.js'
import { auditPlugin } from './plugins/audit.js'

const server = Fastify({
  logger: {
    level: process.env.LOG_LEVEL ?? 'info',
    transport:
      process.env.NODE_ENV === 'development'
        ? { target: 'pino-pretty' }
        : undefined,
  },
})

// Security
await server.register(helmet)
await server.register(cors, {
  origin: process.env.ALLOWED_ORIGINS?.split(',') ?? [],
  credentials: true,
})

// Rate limiting — global default
await server.register(rateLimit, {
  max: 100,
  timeWindow: '1 minute',
})

// Auth
await server.register(jwt, {
  secret: process.env.JWT_SECRET!,
})

// Audit logging (must register before routes)
await server.register(auditPlugin)

// Routes — all versioned under /v1
await server.register(healthRoute, { prefix: '/v1' })
await server.register(authRoute, { prefix: '/v1' })
await server.register(creditRoute, { prefix: '/v1' })

const port = Number(process.env.PORT ?? 3000)
const host = process.env.HOST ?? '0.0.0.0'

try {
  await server.listen({ port, host })
} catch (err) {
  server.log.error(err)
  process.exit(1)
}
