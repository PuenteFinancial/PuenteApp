import type { FastifyInstance } from 'fastify'
import { env } from '../../config/env.js'
import { errorResponseSchema } from '../../utils/errors.js'

// K6: the one piece of Stripe config the web app needs OUTSIDE a transfer —
// the publishable key for the profile page's AddressElement. It stays a
// server-side var (never NEXT_PUBLIC_, per the PR-S3 decision that processor
// selection and key live together) and is served here, authenticated, the
// same way the funding-session route serves it per transfer. Null when
// unset: the profile page degrades to plain inputs rather than failing, so
// this deliberately does not 503 like the crypto surface.

const webConfigSchema = {
  type: 'object',
  properties: {
    stripePublishableKey: { type: ['string', 'null'] },
  },
} as const

export async function configRoute(server: FastifyInstance) {
  server.get(
    '/config/web',
    {
      schema: {
        response: {
          200: webConfigSchema,
          500: errorResponseSchema,
        },
      },
    },
    async () => ({
      stripePublishableKey: env.STRIPE_PUBLISHABLE_KEY ?? null,
    }),
  )
}
