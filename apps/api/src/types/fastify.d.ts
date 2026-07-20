import 'fastify'

declare module 'fastify' {
  interface FastifyContextConfig {
    public?: boolean
    /** Route requires an Idempotency-Key header (see plugins/idempotency.ts). */
    idempotency?: boolean
  }

  interface FastifyRequest {
    user?: { id: string }
    /** Set by the idempotency plugin when this request won the claim. */
    idempotencyClaimId?: string
  }
}
