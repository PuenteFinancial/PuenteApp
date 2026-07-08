import { NextResponse } from 'next/server'
import { SESSION_COOKIE, REFRESH_COOKIE, REFRESH_COOKIE_PATH } from '@/lib/session'

export async function POST() {
  const res = NextResponse.json({ ok: true })
  res.cookies.set(SESSION_COOKIE, '', {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    path: '/',
    maxAge: 0,
  })
  // path must match the set or the delete is a no-op
  res.cookies.set(REFRESH_COOKIE, '', {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    path: REFRESH_COOKIE_PATH,
    maxAge: 0,
  })
  return res
}
