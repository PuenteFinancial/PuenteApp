import { NextRequest, NextResponse } from 'next/server'
import { apiFetch, getSessionToken } from '@/lib/session'

// POST /api/crypto/customer → POST /v1/crypto/customer. Persists the crc_ id
// from the SDK's authenticate callback (the API verifies it under the user's
// own OAuth token before persisting — verify-then-persist).
export async function POST(req: NextRequest) {
  const token = await getSessionToken()
  if (!token) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  try {
    const { customerId } = await req.json()
    const apiRes = await apiFetch('/v1/crypto/customer', token, {
      method: 'POST',
      body: JSON.stringify({ customerId }),
    })
    const body = await apiRes.json().catch(() => ({}))
    return NextResponse.json(body, { status: apiRes.status })
  } catch (err) {
    console.error('Crypto customer error:', err instanceof Error ? err.message : 'Unknown error')
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
