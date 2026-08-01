import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import supertest from 'supertest'
import Fastify, { type FastifyRequest } from 'fastify'
import { SignJWT, generateKeyPair } from 'jose'
import type { GenerateKeyPairResult } from 'jose'

// Real-crypto tests (slice 8.5-v1.1): tokens are SIGNED with a real ES256
// keypair and verified by the real jose jwtVerify — only the network JWKS
// fetch is replaced with a local resolver. The previous version mocked jose
// wholesale, which made issuer/audience pinning unfalsifiable: a vacuous mock
// would pass whatever options auth.ts forgot to send. Now a wrong or missing
// pin fails these tests with real signature/claim verification.

const keys = vi.hoisted(() => ({ current: null as GenerateKeyPairResult | null }))

vi.mock('jose', async (importOriginal) => {
  const actual = await importOriginal<typeof import('jose')>()
  return {
    ...actual,
    // jwtVerify accepts a KeyLike where auth.ts passes the JWKS resolver; the
    // pinned `algorithms` option still applies against the real key type.
    createRemoteJWKSet: vi.fn(() => keys.current!.publicKey),
  }
})

const { authPlugin } = await import('./auth.js')

// test/setup.ts sets SUPABASE_URL to this host; auth.ts derives the issuer.
const ISSUER = 'https://test-project.supabase.co/auth/v1'
const AUDIENCE = 'authenticated'

interface TokenClaims {
  sub?: string
  iss?: string
  aud?: string
  exp?: string
  alg?: string
}

async function mint(claims: TokenClaims = {}) {
  const jwt = new SignJWT({})
    .setProtectedHeader({ alg: claims.alg ?? 'ES256' })
    .setIssuedAt()
    .setIssuer(claims.iss ?? ISSUER)
    .setAudience(claims.aud ?? AUDIENCE)
    .setExpirationTime(claims.exp ?? '5m')
  if (claims.sub !== undefined) jwt.setSubject(claims.sub)
  return jwt.sign(keys.current!.privateKey)
}

describe('authPlugin', () => {
  let app: ReturnType<typeof Fastify>

  beforeAll(async () => {
    keys.current = await generateKeyPair('ES256')
    app = Fastify({ logger: false })
    await app.register(authPlugin)
    app.get('/protected', async (request: FastifyRequest) => ({ userId: request.user?.id }))
    app.get('/open', { config: { public: true } }, async () => ({ ok: true }))
    await app.ready()
  })

  afterAll(() => app.close())

  it('rejects requests without an Authorization header', async () => {
    const res = await supertest(app.server).get('/protected')
    expect(res.status).toBe(401)
  })

  it('rejects non-Bearer Authorization headers', async () => {
    const res = await supertest(app.server)
      .get('/protected')
      .set('Authorization', 'Basic abc123')
    expect(res.status).toBe(401)
  })

  it('rejects garbage tokens', async () => {
    const res = await supertest(app.server)
      .get('/protected')
      .set('Authorization', 'Bearer garbage')
    expect(res.status).toBe(401)
  })

  it('rejects a well-signed token from the WRONG issuer', async () => {
    const token = await mint({ sub: 'user-123', iss: 'https://attacker.example.com/auth/v1' })
    const res = await supertest(app.server)
      .get('/protected')
      .set('Authorization', `Bearer ${token}`)
    expect(res.status).toBe(401)
  })

  it('rejects a well-signed token with the WRONG audience', async () => {
    const token = await mint({ sub: 'user-123', aud: 'anon' })
    const res = await supertest(app.server)
      .get('/protected')
      .set('Authorization', `Bearer ${token}`)
    expect(res.status).toBe(401)
  })

  it('rejects an expired token', async () => {
    const token = await mint({ sub: 'user-123', exp: '-1m' })
    const res = await supertest(app.server)
      .get('/protected')
      .set('Authorization', `Bearer ${token}`)
    expect(res.status).toBe(401)
  })

  it('rejects tokens without a sub claim', async () => {
    const token = await mint({})
    const res = await supertest(app.server)
      .get('/protected')
      .set('Authorization', `Bearer ${token}`)
    expect(res.status).toBe(401)
  })

  it('sets request.user for a valid token (right issuer, audience, sub)', async () => {
    const token = await mint({ sub: 'user-123' })
    const res = await supertest(app.server)
      .get('/protected')
      .set('Authorization', `Bearer ${token}`)
    expect(res.status).toBe(200)
    expect(res.body).toEqual({ userId: 'user-123' })
  })

  it('skips auth for routes marked public', async () => {
    const res = await supertest(app.server).get('/open')
    expect(res.status).toBe(200)
    expect(res.body).toEqual({ ok: true })
  })
})
