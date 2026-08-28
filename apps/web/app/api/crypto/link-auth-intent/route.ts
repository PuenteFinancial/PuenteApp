import { NextResponse } from 'next/server'
import { apiFetch, getSessionToken } from '@/lib/session'

// POST /api/crypto/link-auth-intent → POST /v1/crypto/link-auth-intent.
// No request body: the API reads the user's email from their own row, never
// from the client (K3 identity rule). Response { authIntentId, expiresAt,
// linkAccountExists } is public-shaped — no token material ever rides here.
export async function POST() {
  const token = await getSessionToken()
  if (!token) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  try {
    // apiFetch always sends Content-Type: application/json, and Fastify 400s
    // a JSON content-type with an EMPTY body — so send an explicit {} even
    // though the route reads nothing from it.
    const apiRes = await apiFetch('/v1/crypto/link-auth-intent', token, {
      method: 'POST',
      body: JSON.stringify({}),
    })
    const body = await apiRes.json().catch(() => ({}))
    return NextResponse.json(body, { status: apiRes.status })
  } catch (err) {
    console.error('Link auth intent error:', err instanceof Error ? err.message : 'Unknown error')
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
