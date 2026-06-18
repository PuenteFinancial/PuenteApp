import type { FastifyInstance } from 'fastify'
import { getCreditScore } from '../../services/crs.js'

export async function creditRoute(server: FastifyInstance) {
  // GET /v1/credit/score — returns authenticated user's credit score
  // FCRA NOTE: Only callable after user has completed FCRA consent flow in the app.
  // Consent must be recorded in DB before this endpoint is reachable.
  server.get(
    '/credit/score',
    {
      schema: {
        response: {
          200: {
            type: 'object',
            properties: {
              score: { type: 'number' },
              range: {
                type: 'object',
                properties: {
                  min: { type: 'number' },
                  max: { type: 'number' },
                },
              },
              factors: {
                type: 'array',
                items: { type: 'string' },
              },
              fetchedAt: { type: 'string' },
              cached: { type: 'boolean' },
            },
          },
        },
      },
    },
    async (request, reply) => {
      // Auth middleware attaches user to request — see plugins/auth.ts
      const userId = (request.user as { id: string }).id
      const result = await getCreditScore(userId)
      return reply.send(result)
    },
  )
}
