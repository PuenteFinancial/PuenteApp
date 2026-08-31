import { NextRequest, NextResponse } from 'next/server'
import { apiFetch, getSessionToken } from '@/lib/session'

// POST /api/crypto/transfers/:id/onramp-checkout → POST /v1/crypto/transfers/:id/onramp-checkout.
// Called only from inside the SDK's performCheckout callback. The clientSecret
// in the response passes through to the SDK and is never logged or stored here.
//
// ACH mandate evidence: the API reads the accepting browser's IP and
// user-agent off the request headers. apiFetch's undici would otherwise
// substitute ITS user agent as the sender's Reg E mandate evidence, so both
// headers are forwarded explicitly (the UA forward is what makes this proxy
// different from every other forwarder — do not remove it).
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const token = await getSessionToken()
  if (!token) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  try {
    const { id } = await params
    const { sessionId, paymentMethodType } = await req.json()
    const clientIp =
      req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ||
      req.headers.get('x-real-ip') ||
      null
    const userAgent = req.headers.get('user-agent')
    const apiRes = await apiFetch(
      `/v1/crypto/transfers/${encodeURIComponent(id)}/onramp-checkout`,
      token,
      {
        method: 'POST',
        body: JSON.stringify({ sessionId, paymentMethodType }),
        headers: {
          ...(clientIp ? { 'x-client-ip': clientIp } : {}),
          ...(userAgent ? { 'user-agent': userAgent } : {}),
        },
      },
    )
    const body = await apiRes.json().catch(() => ({}))
    return NextResponse.json(body, { status: apiRes.status })
  } catch (err) {
    console.error('Onramp checkout error:', err instanceof Error ? err.message : 'Unknown error')
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
