import fp from 'fastify-plugin'
import type { FastifyError, FastifyInstance } from 'fastify'

// Envelope for errors that never reach a route handler: schema-validation
// failures (err.validation), unknown routes, and anything unexpected.
// Route handlers use sendError() from utils/errors.ts; this plugin makes the
// framework's own failures speak the same shape.
export const errorHandlerPlugin = fp(async (server: FastifyInstance) => {
  server.setErrorHandler((err: FastifyError, request, reply) => {
    if (err.validation) {
      return reply.status(400).send({
        error: {
          code: 'validation_error',
          message: 'Invalid request.',
          requestId: request.id,
          details: err.validation.map((v) => ({
            path: `${err.validationContext ?? 'body'}${v.instancePath}`,
            issue: v.message ?? 'is invalid',
          })),
        },
      })
    }
    const status = err.statusCode && err.statusCode >= 400 ? err.statusCode : 500
    if (status >= 500) {
      // Sentry's handler has already captured 5xx by the time we shape the
      // body; the envelope never leaks internals to the client.
      request.log.error({ err }, 'unhandled route error')
    }
    return reply.status(status).send({
      error: {
        code: status >= 500 ? 'internal_error' : 'validation_error',
        message: status >= 500 ? 'Something went wrong' : err.message,
        requestId: request.id,
      },
    })
  })

  server.setNotFoundHandler((request, reply) =>
    reply.status(404).send({
      error: { code: 'not_found', message: 'Route not found', requestId: request.id },
    }),
  )
})
