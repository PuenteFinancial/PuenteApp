import 'fastify'

declare module 'fastify' {
  interface FastifyContextConfig {
    public?: boolean
  }
}
