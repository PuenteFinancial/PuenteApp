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

## Idempotency (required for any money-moving route)
Any route that posts to a ledger, initiates a transfer, or draws on a credit line MUST accept and enforce an `Idempotency-Key` header:

```ts
// In schema:
headers: {
  type: 'object',
  required: ['idempotency-key'],
  properties: {
    'idempotency-key': { type: 'string', format: 'uuid' },
  },
},

// In handler:
const idempotencyKey = request.headers['idempotency-key'] as string
const existing = await db.from('idempotency_keys').select('response').eq('key', idempotencyKey).single()
if (existing.data) return reply.send(existing.data.response)  // replay stored result

// ... do the work ...

await db.from('idempotency_keys').insert({ key: idempotencyKey, response: result, expiresAt: addHours(new Date(), 24) })
return reply.send(result)
```

Non-money routes do not need idempotency keys.

## Checklist before finishing
- [ ] Input schema defined
- [ ] Response schema defined
- [ ] Auth: public flag or auth middleware active
- [ ] Audit log entry if route touches PII or financial data
- [ ] Idempotency-Key enforced if route moves money (see above)
- [ ] Invoke `ledger` skill if posting ledger entries
- [ ] Invoke `adverse-action` skill if route can return a credit denial
- [ ] Vitest + Supertest integration test written
- [ ] Registered in server.ts
- [ ] Types from @puente/shared where applicable
