import { NextRequest, NextResponse } from 'next/server'
import {
  apiFetch,
  SESSION_COOKIE,
  REFRESH_COOKIE,
  REFRESH_COOKIE_PATH,
  REFRESH_MAX_AGE,
} from '@/lib/session'

// Server pages redirect here when their session cookie has expired (server
// components can't set cookies — only route handlers can). Exchanges the
// rotating refresh token for a fresh session and bounces back to `next`.
//
// GET-with-side-effects is deliberate: redirect() can only issue GETs, and
// sameSite=lax keeps the refresh cookie off cross-site subresource requests.
// A forced top-level navigation here can rotate the victim's tokens but
// never read them (httpOnly) — nuisance, not a compromise.

const cookieBase = {
  httpOnly: true,
  secure: process.env.NODE_ENV === 'production',
  sameSite: 'lax',
} as const

function clearSession(res: NextResponse) {
  res.cookies.set(SESSION_COOKIE, '', { ...cookieBase, path: '/', maxAge: 0 })
}

function clearRefresh(res: NextResponse) {
  res.cookies.set(REFRESH_COOKIE, '', { ...cookieBase, path: REFRESH_COOKIE_PATH, maxAge: 0 })
}

// Relative same-host paths only. new URL() treats backslash like slash, so
// '/\evil.com' would escape a plain startsWith('//') check — validate the
// resolved host instead. Also refuse to bounce back into this handler.
function safeNext(param: string | null, base: URL): string {
  if (!param?.startsWith('/') || param.startsWith('//')) return '/continue'
  let target: URL
  try {
    target = new URL(param, base)
  } catch {
    return '/continue'
  }
  if (target.host !== base.host || target.pathname.startsWith('/api/auth')) return '/continue'
  return target.pathname + target.search
}

export async function GET(req: NextRequest) {
  const next = safeNext(req.nextUrl.searchParams.get('next'), req.nextUrl)

  const refreshToken = req.cookies.get(REFRESH_COOKIE)?.value
  if (!refreshToken) {
    const res = NextResponse.redirect(new URL('/signup', req.url))
    clearSession(res)
    return res
  }

  let apiRes: Response
  try {
    apiRes = await apiFetch('/v1/auth/refresh', null, {
      method: 'POST',
      body: JSON.stringify({ refreshToken }),
    })
  } catch (err) {
    // API unreachable: a transient outage must not destroy a 30-day session,
    // so keep the refresh cookie and let the user land on /signup for now.
    console.error('Session refresh error:', err instanceof Error ? err.message : 'Unknown error')
    return NextResponse.redirect(new URL('/signup', req.url))
  }

  if (apiRes.status === 401) {
    // Token spent, revoked, or expired — the session is truly over.
    const res = NextResponse.redirect(new URL('/signup', req.url))
    clearSession(res)
    clearRefresh(res)
    return res
  }

  if (!apiRes.ok) {
    console.error('Session refresh failed with status', apiRes.status)
    return NextResponse.redirect(new URL('/signup', req.url))
  }

  const { accessToken, refreshToken: rotatedToken, expiresIn } = (await apiRes.json()) as {
    accessToken: string
    refreshToken: string
    expiresIn: number
  }

  const res = NextResponse.redirect(new URL(next, req.url))
  res.cookies.set(SESSION_COOKIE, accessToken, {
    ...cookieBase,
    path: '/',
    maxAge: expiresIn,
  })
  // Rolling 30 days: each rotation restarts the clock.
  res.cookies.set(REFRESH_COOKIE, rotatedToken, {
    ...cookieBase,
    path: REFRESH_COOKIE_PATH,
    maxAge: REFRESH_MAX_AGE,
  })
  return res
}
