import { cookies } from 'next/headers'

export const SESSION_COOKIE = 'puente_session'

// Session token lives in an httpOnly cookie — server-side code only.
export async function getSessionToken(): Promise<string | null> {
  const cookieStore = await cookies()
  return cookieStore.get(SESSION_COOKIE)?.value ?? null
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
