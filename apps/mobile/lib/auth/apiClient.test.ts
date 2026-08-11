import { describe, it, expect, vi } from 'vitest'
import { createApiClient } from './apiClient'
import type { TokenStore, Tokens } from './types'

const BASE = 'http://api.test'

function memoryStore(initial: Tokens | null = null): TokenStore & { current: Tokens | null } {
  return {
    current: initial,
    async read() {
      return this.current
    },
    async write(t: Tokens) {
      this.current = t
    },
    async clear() {
      this.current = null
    },
  }
}

function live(overrides: Partial<Tokens> = {}): Tokens {
  return {
    accessToken: 'access-1',
    refreshToken: 'refresh-1',
    expiresAt: 10_000_000,
    ...overrides,
  }
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

const SESSION_2 = {
  accessToken: 'access-2',
  refreshToken: 'refresh-2',
  expiresIn: 3600,
  userId: 'user-1',
}

// Clock fixed well before the default expiresAt so tokens read as live unless
// a test says otherwise.
const now = () => 1_000_000

describe('createApiClient', () => {
  it('attaches the bearer token and leaves a 200 alone', async () => {
    const store = memoryStore(live())
    const fetchImpl = vi.fn().mockResolvedValue(json({ ok: true }))
    const client = createApiClient({ baseUrl: BASE, tokens: store, fetchImpl, now })

    const res = await client.fetch('/v1/users/me')

    expect(res.status).toBe(200)
    expect(fetchImpl).toHaveBeenCalledTimes(1)
    const [url, init] = fetchImpl.mock.calls[0]!
    expect(url).toBe(`${BASE}/v1/users/me`)
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer access-1')
  })

  it('refreshes on 401, retries once, and persists the ROTATED refresh token', async () => {
    const store = memoryStore(live())
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(json({ error: { code: 'unauthorized' } }, 401))
      .mockResolvedValueOnce(json(SESSION_2))
      .mockResolvedValueOnce(json({ ok: true }))
    const client = createApiClient({ baseUrl: BASE, tokens: store, fetchImpl, now })

    const res = await client.fetch('/v1/users/me')

    expect(res.status).toBe(200)
    expect(fetchImpl).toHaveBeenCalledTimes(3)
    expect(fetchImpl.mock.calls[1]![0]).toBe(`${BASE}/v1/auth/refresh`)

    // The retry must carry the NEW access token, not the one that just 401'd.
    const retryInit = fetchImpl.mock.calls[2]![1]
    expect((retryInit.headers as Record<string, string>).Authorization).toBe('Bearer access-2')

    // Supabase rotates refresh tokens and they are single-use. Dropping the
    // rotated value strands the session about an hour later, which is the
    // failure this assertion exists to prevent.
    expect(store.current?.refreshToken).toBe('refresh-2')
    expect(store.current?.expiresAt).toBe(now() + 3600 * 1000)
  })

  it('issues exactly one refresh for N concurrent 401s', async () => {
    const store = memoryStore(live())
    let refreshCalls = 0
    const firstHit = new Set<string>()

    const fetchMock = vi.fn(async (url: string): Promise<Response> => {
      if (url.endsWith('/v1/auth/refresh')) {
        refreshCalls += 1
        // Hold the refresh open so all three callers are genuinely overlapping
        // — without this they could serialize and pass for the wrong reason.
        await new Promise((r) => setTimeout(r, 10))
        return json(SESSION_2)
      }
      // Each data path 401s once, then succeeds on the post-refresh retry.
      if (!firstHit.has(url)) {
        firstHit.add(url)
        return json({}, 401)
      }
      return json({ ok: true })
    })

    const client = createApiClient({
      baseUrl: BASE,
      tokens: store,
      // vi.fn() infers a single signature; fetch is overloaded, so the cast is
      // needed to pass it while keeping mock introspection.
      fetchImpl: fetchMock as unknown as typeof fetch,
      now,
    })

    const results = await Promise.all([
      client.fetch('/v1/a'),
      client.fetch('/v1/b'),
      client.fetch('/v1/c'),
    ])

    // Three concurrent refreshes would rotate the token three times; the
    // second and third would present one already spent, and the session dies.
    expect(refreshCalls).toBe(1)
    expect(results.map((r) => r.status)).toEqual([200, 200, 200])
    expect(store.current?.refreshToken).toBe('refresh-2')
  })

  it('clears the store and signs out when the refresh token itself is rejected', async () => {
    const store = memoryStore(live())
    const onSignedOut = vi.fn()
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(json({}, 401))
      .mockResolvedValueOnce(json({ error: { code: 'unauthorized' } }, 401))
    const client = createApiClient({ baseUrl: BASE, tokens: store, fetchImpl, now, onSignedOut })

    const res = await client.fetch('/v1/users/me')

    expect(res.status).toBe(401)
    expect(store.current).toBeNull()
    expect(onSignedOut).toHaveBeenCalledTimes(1)
    // Exactly two calls: the original and the failed refresh. No recursion
    // into refreshing the refresh.
    expect(fetchImpl).toHaveBeenCalledTimes(2)
  })

  it('does NOT sign the user out when the refresh call fails for network reasons', async () => {
    const store = memoryStore(live())
    const onSignedOut = vi.fn()
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(json({}, 401))
      .mockRejectedValueOnce(new TypeError('Network request failed'))
    const client = createApiClient({ baseUrl: BASE, tokens: store, fetchImpl, now, onSignedOut })

    const res = await client.fetch('/v1/users/me')

    expect(res.status).toBe(401)
    // A tunnel or a flaky cell must not cost the user their session and force
    // them back through SMS.
    expect(store.current).not.toBeNull()
    expect(onSignedOut).not.toHaveBeenCalled()
  })

  it('refreshes proactively when the stored token is already past expiry', async () => {
    // expiresAt is behind the clock, so the first data call should never be
    // made with the stale token.
    const store = memoryStore(live({ expiresAt: now() - 1 }))
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(json(SESSION_2))
      .mockResolvedValueOnce(json({ ok: true }))
    const client = createApiClient({ baseUrl: BASE, tokens: store, fetchImpl, now })

    await client.fetch('/v1/users/me')

    expect(fetchImpl.mock.calls[0]![0]).toBe(`${BASE}/v1/auth/refresh`)
    const dataInit = fetchImpl.mock.calls[1]![1]
    expect((dataInit.headers as Record<string, string>).Authorization).toBe('Bearer access-2')
  })

  it('refreshes within the skew window rather than spending a guaranteed 401', async () => {
    // Live by a hair, but inside EXPIRY_SKEW_MS (30s).
    const store = memoryStore(live({ expiresAt: now() + 5_000 }))
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(json(SESSION_2))
      .mockResolvedValueOnce(json({ ok: true }))
    const client = createApiClient({ baseUrl: BASE, tokens: store, fetchImpl, now })

    await client.fetch('/v1/users/me')

    expect(fetchImpl.mock.calls[0]![0]).toBe(`${BASE}/v1/auth/refresh`)
  })

  it('sends an unauthenticated request when there is no session', async () => {
    const store = memoryStore(null)
    const fetchImpl = vi.fn().mockResolvedValue(json({ message: 'OTP sent' }))
    const client = createApiClient({ baseUrl: BASE, tokens: store, fetchImpl, now })

    await client.fetch('/v1/auth/otp/send', { method: 'POST' })

    // Public routes exist, so no token is not an error — but no Authorization
    // header should be fabricated either.
    const [, init] = fetchImpl.mock.calls[0]!
    expect(init?.headers).toBeUndefined()
  })

  it('treats an unreadable 200 from refresh as a hard failure', async () => {
    const store = memoryStore(live())
    const onSignedOut = vi.fn()
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(json({}, 401))
      .mockResolvedValueOnce(json({ unexpected: 'shape' }))
    const client = createApiClient({ baseUrl: BASE, tokens: store, fetchImpl, now, onSignedOut })

    await client.fetch('/v1/users/me')

    // Storing a half-session here would defer the failure to a later request
    // with no obvious cause.
    expect(store.current).toBeNull()
    expect(onSignedOut).toHaveBeenCalledTimes(1)
  })

  it('signOut clears storage and notifies', async () => {
    const store = memoryStore(live())
    const onSignedOut = vi.fn()
    const client = createApiClient({
      baseUrl: BASE,
      tokens: store,
      fetchImpl: vi.fn(),
      now,
      onSignedOut,
    })

    await client.signOut()

    expect(store.current).toBeNull()
    expect(onSignedOut).toHaveBeenCalledTimes(1)
  })
})
