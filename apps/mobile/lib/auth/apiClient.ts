import {
  EXPIRY_SKEW_MS,
  isSessionResponse,
  tokensFromSession,
  type TokenStore,
  type Tokens,
} from './types.js'

export interface ApiClientDeps {
  baseUrl: string
  tokens: TokenStore
  // Injected so the whole client tests in Node. Defaults to global fetch,
  // which React Native provides.
  fetchImpl?: typeof fetch
  // Called once when the session is unrecoverable and the store has been
  // cleared, so the UI can route back to sign-in.
  onSignedOut?: () => void
  // Injected for deterministic expiry tests.
  now?: () => number
}

export interface ApiClient {
  fetch(path: string, init?: RequestInit): Promise<Response>
  signOut(): Promise<void>
}

/**
 * The app's only way to reach the API. Injects the bearer token, refreshes it
 * when the API rejects it, and retries the original request exactly once.
 *
 * Two rules this exists to enforce, both of which are easy to get subtly wrong
 * and expensive to debug from a user report:
 *
 *   1. **Refresh is single-flight.** Supabase refresh tokens rotate and are
 *      single-use (apps/api/src/routes/v1/auth.ts:196-208). If a screen fires
 *      three requests that all 401, three concurrent refreshes would race:
 *      the first rotates the token, the other two present one that is now
 *      spent, and the session dies. Every caller awaits the same promise.
 *   2. **The rotated refresh token is persisted.** Dropping it looks fine
 *      until the access token lapses about an hour later, at which point the
 *      user is silently signed out — a bug that reproduces only with time.
 */
export function createApiClient(deps: ApiClientDeps): ApiClient {
  const { baseUrl, tokens, fetchImpl = fetch, onSignedOut, now = Date.now } = deps

  // Module-free, closure-scoped: one in-flight refresh per client instance.
  let inflight: Promise<Tokens | null> | null = null

  async function persistOrClear(res: Response): Promise<Tokens | null> {
    if (!res.ok) {
      // The refresh token itself was rejected — nothing left to try.
      await tokens.clear()
      onSignedOut?.()
      return null
    }
    const body: unknown = await res.json().catch(() => null)
    if (!isSessionResponse(body)) {
      // A 200 we cannot read is not a usable session. Treat it as a hard
      // failure rather than storing a half-session that fails later.
      await tokens.clear()
      onSignedOut?.()
      return null
    }
    const next = tokensFromSession(body, now())
    await tokens.write(next)
    return next
  }

  async function doRefresh(): Promise<Tokens | null> {
    const current = await tokens.read()
    if (!current) {
      onSignedOut?.()
      return null
    }
    let res: Response
    try {
      res = await fetchImpl(`${baseUrl}/v1/auth/refresh`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ refreshToken: current.refreshToken }),
      })
    } catch {
      // Network failure is NOT an invalid session — keep the stored tokens so
      // the next attempt (better connectivity) can still succeed. Signing the
      // user out here would make a tunnel or a flaky cell mean re-doing SMS.
      return null
    }
    return persistOrClear(res)
  }

  function refreshOnce(): Promise<Tokens | null> {
    inflight ??= doRefresh().finally(() => {
      inflight = null
    })
    return inflight
  }

  function authorized(init: RequestInit, accessToken: string): RequestInit {
    return {
      ...init,
      headers: {
        'Content-Type': 'application/json',
        ...init.headers,
        Authorization: `Bearer ${accessToken}`,
      },
    }
  }

  return {
    async fetch(path: string, init: RequestInit = {}): Promise<Response> {
      let current = await tokens.read()

      // Proactive refresh: if the token is already past (or within skew of)
      // its expiry, spend one refresh instead of a guaranteed-401 round trip.
      if (current && current.expiresAt - EXPIRY_SKEW_MS <= now()) {
        current = await refreshOnce()
      }

      // Unauthenticated call — let the API decide. Public routes exist
      // (/v1/auth/*), so this is not automatically an error.
      if (!current) return fetchImpl(`${baseUrl}${path}`, init)

      const res = await fetchImpl(`${baseUrl}${path}`, authorized(init, current.accessToken))
      if (res.status !== 401) return res

      // The API rejected a token we believed was live. One refresh, one retry.
      // A second 401 after a fresh token is a real authorization failure, not
      // an expiry, so it is returned to the caller rather than looped on.
      const refreshed = await refreshOnce()
      if (!refreshed) return res

      return fetchImpl(`${baseUrl}${path}`, authorized(init, refreshed.accessToken))
    },

    async signOut(): Promise<void> {
      // There is no server-side revocation endpoint (the web app clears
      // cookies and stops there), so this is local-only, same posture.
      await tokens.clear()
      onSignedOut?.()
    },
  }
}
