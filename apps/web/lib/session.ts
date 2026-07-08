import { cookies, headers } from 'next/headers'

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

export function apiFetch(
  path: string,
  token?: string | null,
  init: RequestInit = {},
): Promise<Response> {
  const apiUrl = process.env.INTERNAL_API_URL
  if (!apiUrl) throw new Error('INTERNAL_API_URL is not configured')

  return fetch(`${apiUrl}${path}`, {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...init.headers,
    },
    cache: 'no-store',
  })
}
