import { NextRequest, NextResponse } from 'next/server'
import {
  apiFetch,
  SESSION_COOKIE,
  REFRESH_COOKIE,
  REFRESH_COOKIE_PATH,
  REFRESH_MAX_AGE,
} from '@/lib/session'

export async function POST(req: NextRequest) {
  try {
    const { phone, token } = await req.json()
    if (typeof phone !== 'string' || !phone.trim() || typeof token !== 'string' || !token.trim()) {
      return NextResponse.json({ error: 'Phone and code are required' }, { status: 400 })
    }

    const apiRes = await apiFetch('/v1/auth/otp/verify', null, {
      method: 'POST',
      body: JSON.stringify({ phone: phone.trim(), token: token.trim() }),
    })

    if (apiRes.status === 401) {
      return NextResponse.json({ error: 'Invalid or expired code' }, { status: 401 })
    }
    if (!apiRes.ok) {
      console.error('OTP verify failed with status', apiRes.status)
      return NextResponse.json({ error: 'Failed to verify code' }, { status: 502 })
    }

    const { accessToken, refreshToken, expiresIn } = (await apiRes.json()) as {
      accessToken: string
      refreshToken: string
      expiresIn: number
    }

    // Both tokens go straight into httpOnly cookies — they never reach
    // client-side JavaScript.
    const res = NextResponse.json({ ok: true })
    res.cookies.set(SESSION_COOKIE, accessToken, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'lax',
      path: '/',
      maxAge: expiresIn,
    })
    res.cookies.set(REFRESH_COOKIE, refreshToken, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'lax',
      path: REFRESH_COOKIE_PATH,
      maxAge: REFRESH_MAX_AGE,
    })
    return res
  } catch (err) {
    console.error('OTP verify error:', err instanceof Error ? err.message : 'Unknown error')
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
