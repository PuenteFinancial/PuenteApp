import 'fastify'

declare module 'fastify' {
  interface FastifyContextConfig {
    public?: boolean
  }

  interface FastifyRequest {
    user?: { id: string }
  }
}
