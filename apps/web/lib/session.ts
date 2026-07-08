import { cookies, headers } from 'next/headers'

export const SESSION_COOKIE = 'puente_session'

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
