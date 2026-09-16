import { cookies, headers } from 'next/headers'
import { internalApiUrl } from './apiBaseUrl'

export const SESSION_COOKIE = 'puente_session'

// Rotating Supabase refresh token. Path-scoped so the browser only sends it
// to /api/auth/* — it never rides along on page loads or other API proxies.
export const REFRESH_COOKIE = 'puente_refresh'
export const REFRESH_COOKIE_PATH = '/api/auth'
// 30-day rolling session: reset on every successful refresh, re-OTP after.
export const REFRESH_MAX_AGE = 30 * 24 * 60 * 60

// Where server pages send a request whose session cookie has expired: the
// refresh handler rotates the cookies and bounces back to `next`.
export function refreshRedirectPath(next: string): string {
  return `/api/auth/refresh?next=${encodeURIComponent(next)}`
}

// Session token lives in an httpOnly cookie — server-side code only.
export async function getSessionToken(): Promise<string | null> {
  const cookieStore = await cookies()
  return cookieStore.get(SESSION_COOKIE)?.value ?? null
}

// Public origin of the current request, from proxy-aware headers. Sent to
// the API so Bridge ToS/KYC redirects return to the origin the user is on;
// the API only honors it if allowlisted in ALLOWED_ORIGINS.
export async function requestOrigin(): Promise<string | null> {
  const headerList = await headers()
  const host = headerList.get('x-forwarded-host') ?? headerList.get('host')
  if (!host) return null
  const proto = headerList.get('x-forwarded-proto') ?? (host.startsWith('localhost') ? 'http' : 'https')
  return `${proto}://${host}`
}

// PROVES THIS IS THE PROXY, so the API can believe the x-client-ip and
// x-client-ua that several callers below forward.
//
// INTERNAL_API_URL is a public-internet hop, not a private network: the API
// answers anyone (measured 2026-09-16 — a stranger's GET /v1/health returns
// 200), so without this the forwarded headers are just headers and a forged one
// lands in an E-SIGN consent record looking exactly like a real one. Shared
// secret, same value per tier in Doppler `puente-api` and `puente-web`.
//
// NOT NEXT_PUBLIC_. It is read here, server-side; a NEXT_PUBLIC_ prefix would
// ship it to the browser and hand the forgery back to anyone who viewed source.
//
// Absent is a no-op rather than a throw, so local dev and CI need no secret —
// the API then simply ignores the forwarded headers and records the socket
// address. That degradation is silent by design HERE and loud at the API's
// boot check, which is the end that knows whether it is deployed.
function proxyTrustHeader(): Record<string, string> {
  const secret = process.env.PROXY_TRUST_SECRET
  return secret ? { 'x-proxy-trust': secret } : {}
}

export function apiFetch(
  path: string,
  token?: string | null,
  init: RequestInit = {},
): Promise<Response> {
  const apiUrl = internalApiUrl()

  return fetch(`${apiUrl}${path}`, {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      // Caller headers override Content-Type, but NOT the trust header, which
      // is spread last on purpose: no caller may set or clear it, and one that
      // tried would be forging its own proof.
      ...init.headers,
      ...proxyTrustHeader(),
    },
    cache: 'no-store',
  })
}
