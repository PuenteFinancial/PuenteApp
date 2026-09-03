import { NextRequest, NextResponse } from 'next/server'
import { apiFetch, getSessionToken } from '@/lib/session'

// POST /api/users/me/bridge-customer → POST /v1/users/me/bridge-customer.
//
// THE KYC RELAY (K6). This is the one proxy whose body carries identity
// numbers (DOB + SSN/ITIN), on their single pass from the browser to Bridge.
// It forwards the two fields verbatim and touches nothing else: no logging
// of the body or of any error message that could quote it (a JSON parse
// error names the offending input), no storage, no echo — the API's response
// never contains the inputs either (bridge-customer.test.ts pins that).
// Real client IP rides the header (confirm-route pattern) so the API's rate
// limiter keys on the sender, not on this server.
export async function POST(req: NextRequest) {
  const token = await getSessionToken()
  if (!token) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  let payload: unknown
  try {
    payload = await req.json()
  } catch {
    return NextResponse.json(
      { error: { code: 'validation_error', message: 'Invalid JSON body' } },
      { status: 400 },
    )
  }
  const { dob, taxId } = (payload ?? {}) as { dob?: unknown; taxId?: unknown }

  try {
    const clientIp =
      req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ||
      req.headers.get('x-real-ip') ||
      null
    const apiRes = await apiFetch('/v1/users/me/bridge-customer', token, {
      method: 'POST',
      body: JSON.stringify({ dob, taxId }),
      headers: {
        ...(clientIp ? { 'x-client-ip': clientIp } : {}),
      },
    })
    const body = await apiRes.json().catch(() => ({}))
    return NextResponse.json(body, { status: apiRes.status })
  } catch {
    // Deliberately no err.message: an upstream failure can wrap the request.
    console.error('Bridge customer relay error')
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
