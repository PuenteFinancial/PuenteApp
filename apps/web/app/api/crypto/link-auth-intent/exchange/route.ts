import { NextRequest, NextResponse } from 'next/server'
import { apiFetch, getSessionToken } from '@/lib/session'

// POST /api/crypto/link-auth-intent/exchange → POST /v1/crypto/link-auth-intent/exchange.
// Forwards only the authIntentId; the token exchange and refresh-token
// storage happen entirely server-side (the API returns { ok: true }, never
// token material).
export async function POST(req: NextRequest) {
  const token = await getSessionToken()
  if (!token) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  try {
    const { authIntentId } = await req.json()
    const apiRes = await apiFetch('/v1/crypto/link-auth-intent/exchange', token, {
      method: 'POST',
      body: JSON.stringify({ authIntentId }),
    })
    const body = await apiRes.json().catch(() => ({}))
    return NextResponse.json(body, { status: apiRes.status })
  } catch (err) {
    console.error('Link token exchange error:', err instanceof Error ? err.message : 'Unknown error')
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
