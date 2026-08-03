import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import supertest from 'supertest'
import Fastify, { type FastifyRequest } from 'fastify'
import { SignJWT, generateKeyPair } from 'jose'
import type { GenerateKeyPairResult } from 'jose'

// Real-crypto tests (slice 8.5-v1.1): tokens are SIGNED with real keypairs and
// verified by the real jose jwtVerify — only the network JWKS fetch is replaced
// with a local resolver that picks a key by the token's `alg`, the way a real
// JWKS does. The previous version mocked jose wholesale, which made
// issuer/audience pinning unfalsifiable: a vacuous mock passes whatever options
// auth.ts forgets to send.
//
// The issuer is derived from SUPABASE_URL, and CI's DB-test job sets that to
// the LOCAL supabase (setup.ts only fills it in when unset), so this file pins
// its own value before env.ts parses — otherwise the expected issuer below
// silently drifts with the environment and the suite fails only in one job.
const keys = vi.hoisted(() => {
  process.env.SUPABASE_URL = 'https://test-project.supabase.co'
  return { es256: null as GenerateKeyPairResult | null, rs256: null as GenerateKeyPairResult | null }
})

vi.mock('jose', async (importOriginal) => {
  const actual = await importOriginal<typeof import('jose')>()
  return {
    ...actual,
    // Stands in for the remote JWKS: same (protectedHeader, token) => key
    // contract jose's createRemoteJWKSet returns. It hands back the asymmetric
    // key it has for ANY header alg — including a forged HS256 header — so the
    // symmetric-confusion test below is refused by verification, not by a
    // conveniently strict mock.
    createRemoteJWKSet: vi.fn(() => async (header: { alg: string }) =>
      header.alg === 'RS256' ? keys.rs256!.publicKey : keys.es256!.publicKey,
    ),
  }
})

const { authPlugin } = await import('./auth.js')

// Hard-coded, NOT re-derived from env: if auth.ts computed the issuer wrongly
// (bare origin, wrong path), mirroring its formula here would hide the bug.
// Verified 2026-08-01 against both projects' /auth/v1/.well-known/
// openid-configuration — GoTrue stamps iss = <SUPABASE_URL>/auth/v1.
const ISSUER = 'https://test-project.supabase.co/auth/v1'
const AUDIENCE = 'authenticated'

interface TokenClaims {
  sub?: string
  iss?: string
  aud?: string
  exp?: string
  alg?: 'ES256' | 'RS256'
}

async function mint(claims: TokenClaims = {}) {
  const alg = claims.alg ?? 'ES256'
  const jwt = new SignJWT({})
    .setProtectedHeader({ alg })
    .setIssuedAt()
    .setIssuer(claims.iss ?? ISSUER)
    .setAudience(claims.aud ?? AUDIENCE)
    .setExpirationTime(claims.exp ?? '5m')
  if (claims.sub !== undefined) jwt.setSubject(claims.sub)
  return jwt.sign(alg === 'RS256' ? keys.rs256!.privateKey : keys.es256!.privateKey)
}

describe('authPlugin', () => {
  let app: ReturnType<typeof Fastify>

  beforeAll(async () => {
    keys.es256 = await generateKeyPair('ES256')
    keys.rs256 = await generateKeyPair('RS256')
    app = Fastify({ logger: false })
    await app.register(authPlugin)
    app.get('/protected', async (request: FastifyRequest) => ({ userId: request.user?.id }))
    app.get('/open', { config: { public: true } }, async () => ({ ok: true }))
    await app.ready()
  })

  afterAll(() => app.close())

  const get = (token?: string) => {
    const req = supertest(app.server).get('/protected')
    return token === undefined ? req : req.set('Authorization', `Bearer ${token}`)
  }

  it('rejects requests without an Authorization header', async () => {
    expect((await get()).status).toBe(401)
  })

  it('rejects non-Bearer Authorization headers', async () => {
    const res = await supertest(app.server).get('/protected').set('Authorization', 'Basic abc123')
    expect(res.status).toBe(401)
  })

  it('rejects garbage tokens', async () => {
    expect((await get('garbage')).status).toBe(401)
  })

  it('rejects a well-signed token from the WRONG issuer', async () => {
    const token = await mint({ sub: 'user-123', iss: 'https://attacker.example.com/auth/v1' })
    expect((await get(token)).status).toBe(401)
  })

  it('rejects a well-signed token with the WRONG audience', async () => {
    const token = await mint({ sub: 'user-123', aud: 'anon' })
    expect((await get(token)).status).toBe(401)
  })

  it('rejects an expired token', async () => {
    const token = await mint({ sub: 'user-123', exp: '-1m' })
    expect((await get(token)).status).toBe(401)
  })

  it('rejects tokens without a sub claim', async () => {
    expect((await get(await mint({}))).status).toBe(401)
  })

  it('rejects an HS256 token signed with the public key (algorithm confusion)', async () => {
    // The classic JWKS attack: forge alg:HS256 and HMAC the token with the
    // published public key. The JWKS hands back that same asymmetric key, so
    // acceptance would mean anyone could mint an admin session from public data.
    const publicJwk = await (await import('jose')).exportSPKI(
      keys.es256!.publicKey as Parameters<typeof import('jose').exportSPKI>[0],
    )
    const forged = await new SignJWT({})
      .setProtectedHeader({ alg: 'HS256' })
      .setIssuedAt()
      .setIssuer(ISSUER)
      .setAudience(AUDIENCE)
      .setSubject('user-123')
      .setExpirationTime('5m')
      .sign(new TextEncoder().encode(publicJwk))
    expect((await get(forged)).status).toBe(401)
  })

  it('sets request.user for a valid ES256 token (right issuer, audience, sub)', async () => {
    const res = await get(await mint({ sub: 'user-123' }))
    expect(res.status).toBe(200)
    expect(res.body).toEqual({ userId: 'user-123' })
  })

  it('still accepts RS256 — a Supabase signing-key rotation must not lock everyone out', async () => {
    // Both projects advertise RS256 alongside ES256; the JWKS holds ES256 today.
    // If the pin were ES256-only, the next key rotation would 401 every user on
    // every route at once, with no code change to blame.
    const res = await get(await mint({ sub: 'user-456', alg: 'RS256' }))
    expect(res.status).toBe(200)
    expect(res.body).toEqual({ userId: 'user-456' })
  })

  it('skips auth for routes marked public', async () => {
    const res = await supertest(app.server).get('/open')
    expect(res.status).toBe(200)
    expect(res.body).toEqual({ ok: true })
  })
})
