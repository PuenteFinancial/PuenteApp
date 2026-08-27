import { NextRequest, NextResponse } from 'next/server'
import { apiFetch, getSessionToken } from '@/lib/session'

// Client JS never talks to the Fastify API directly — the consent form's
// reads and writes go through this proxy like every other authenticated call.
export async function GET() {
  const token = await getSessionToken()
  if (!token) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  try {
    const apiRes = await apiFetch('/v1/users/me/consents', token)
    const body = await apiRes.json().catch(() => ({}))
    return NextResponse.json(body, { status: apiRes.status })
  } catch (err) {
    console.error('Consents fetch error:', err instanceof Error ? err.message : 'Unknown error')
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}

export async function POST(req: NextRequest) {
  const token = await getSessionToken()
  if (!token) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  try {
    const { consents, locale } = await req.json()

    // The API only sees this server's address and UA — forward the real
    // client's (otp/verify + transfer-confirm pattern) so the consent
    // evidence records the browser that actually assented, not the proxy.
    // Header, never a URL param.
    const clientIp =
      req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ||
      req.headers.get('x-real-ip') ||
      null
    const userAgent = req.headers.get('user-agent')

    const apiRes = await apiFetch('/v1/users/me/consents', token, {
      method: 'POST',
      body: JSON.stringify({ consents, locale }),
      headers: {
        ...(clientIp ? { 'x-client-ip': clientIp } : {}),
        ...(userAgent ? { 'user-agent': userAgent } : {}),
      },
    })

    const body = await apiRes.json().catch(() => ({}))
    return NextResponse.json(body, { status: apiRes.status })
  } catch (err) {
    console.error('Consent grant error:', err instanceof Error ? err.message : 'Unknown error')
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
