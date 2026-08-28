import { NextRequest, NextResponse } from 'next/server'
import { apiFetch, getSessionToken } from '@/lib/session'

// POST /api/crypto/transfers/:id/onramp-session → POST /v1/crypto/transfers/:id/onramp-session.
// Creates the headless onramp session for a confirmed transfer. The amount is
// server-pinned from the transfer row — the client sends only the SDK-minted
// payment token. Forwards the real client IP (confirm-route pattern): Stripe
// geo-checks it at session create. Header, never a URL param.
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const token = await getSessionToken()
  if (!token) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  try {
    const { id } = await params
    const { paymentTokenId } = await req.json()
    const clientIp =
      req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ||
      req.headers.get('x-real-ip') ||
      null
    const apiRes = await apiFetch(
      `/v1/crypto/transfers/${encodeURIComponent(id)}/onramp-session`,
      token,
      {
        method: 'POST',
        body: JSON.stringify({ paymentTokenId }),
        headers: {
          ...(clientIp ? { 'x-client-ip': clientIp } : {}),
        },
      },
    )
    const body = await apiRes.json().catch(() => ({}))
    return NextResponse.json(body, { status: apiRes.status })
  } catch (err) {
    console.error('Onramp session error:', err instanceof Error ? err.message : 'Unknown error')
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
