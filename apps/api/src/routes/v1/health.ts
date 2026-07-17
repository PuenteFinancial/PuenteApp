import type { FastifyInstance } from 'fastify'

// Railway injects RAILWAY_GIT_COMMIT_SHA at build time; local/dev has no
// value. Read once at module load — it can't change within a process.
const sha = process.env.RAILWAY_GIT_COMMIT_SHA
const commit = sha ? sha.slice(0, 7) : null

export async function healthRoute(server: FastifyInstance) {
  server.get(
    '/health',
    {
      config: { public: true },
      schema: {
        response: {
          200: {
            type: 'object',
            properties: {
              status: { type: 'string' },
              // which build is serving — Railway's health-gated cutover keeps
              // the previous build alive on a failed deploy, so "ok" alone
              // can't distinguish old from new
              commit: { type: 'string', nullable: true },
              timestamp: { type: 'string' },
            },
          },
        },
      },
    },
    async () => {
      return { status: 'ok', commit, timestamp: new Date().toISOString() }
    },
  )
}
