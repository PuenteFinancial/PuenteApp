---
name: api-route
description: Create a new Fastify API route in apps/api
---

When creating a new Fastify route:

## File location
`apps/api/src/routes/v1/<resource>.ts`
Register in `apps/api/src/server.ts` with `prefix: '/v1'`

## Required structure
```ts
import type { FastifyInstance } from 'fastify'

export async function <resource>Route(server: FastifyInstance) {
  server.get('/<resource>', {
    // Public routes: config: { public: true }
    // Authenticated: omit config (auth middleware applies by default)
    schema: {
      body: { type: 'object', required: [...], properties: { ... } },
      response: { 200: { type: 'object', properties: { ... } } },
    },
  }, async (request, reply) => {
    const userId = (request.user as { id: string }).id
    return reply.send({ ... })
  })
}
```

## Checklist before finishing
- [ ] Input schema defined
- [ ] Response schema defined
- [ ] Auth: public flag or auth middleware active
- [ ] Audit log entry if route touches PII or financial data
- [ ] Vitest + Supertest integration test written
- [ ] Registered in server.ts
- [ ] Types from @puente/shared where applicable
