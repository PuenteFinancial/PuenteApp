---
name: tdd
description: Enforce test-as-you-go for every new feature, route, or service
---

Every implementation session must produce tests in the same commit.
Never mark a task done without passing tests. This is non-negotiable.

## Rule: test file lives alongside source file
```
apps/api/src/routes/v1/auth.ts       ← implementation
apps/api/src/routes/v1/auth.test.ts  ← tests (same directory)
packages/shared/src/types/credit.ts
packages/shared/src/types/credit.test.ts
```

## Minimum required tests per new API route
1. Happy path (correct input → expected status + response shape)
2. Missing required field → 400
3. Unauthenticated request on protected route → 401
4. Any business rule specific to that route (e.g. FCRA gate → 403)

## Supertest integration test template (API routes)
```ts
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import supertest from 'supertest'
import Fastify from 'fastify'
import { <resource>Route } from './<resource>.js'

describe('<METHOD> /v1/<resource>', () => {
  let app: ReturnType<typeof Fastify>

  beforeAll(async () => {
    app = Fastify({ logger: false })
    await app.register(<resource>Route, { prefix: '/v1' })
    await app.ready()
  })

  afterAll(() => app.close())

  it('happy path', async () => {
    const res = await supertest(app.server)
      .post('/v1/<resource>')
      .send({ /* valid input */ })
    expect(res.status).toBe(200)
    expect(res.body).toMatchObject({ /* expected shape */ })
  })

  it('returns 400 with missing required field', async () => {
    const res = await supertest(app.server)
      .post('/v1/<resource>')
      .send({})
    expect(res.status).toBe(400)
  })

  it('returns 401 without auth token', async () => {
    const res = await supertest(app.server)
      .get('/v1/<resource>')
    expect(res.status).toBe(401)
  })
})
```

## Unit test template (pure functions)
```ts
import { describe, it, expect } from 'vitest'
import { <functionName> } from './<file>.js'

describe('<functionName>', () => {
  it('<expected behavior>', () => {
    expect(<functionName>(<input>)).toBe(<expected>)
  })

  it('handles edge case: <describe case>', () => {
    expect(<functionName>(<edge input>)).toBe(<expected>)
  })
})
```

## Workflow — follow this order every time
1. Write the failing test first (or alongside)
2. Run `npm test` — confirm it fails for the right reason
3. Implement the feature
4. Run `npm test` — confirm it passes
5. Add edge case tests
6. Run `npm run typecheck`
7. Commit — tests and implementation together

## Run tests
```bash
# From repo root
npm test

# Watch mode during development
cd apps/api && npm run test:watch

# Single file
cd apps/api && npx vitest run src/routes/v1/auth.test.ts
```

## Fintech-specific tests to never skip
- FCRA gate: credit endpoint returns 403 if user.fcraConsentAt is null
- Cache: second credit score call returns cached: true
- PII: verify no names/emails/phones appear in server logs
- Auth: every non-public route rejects missing or expired JWT
