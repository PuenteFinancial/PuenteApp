import { NextResponse } from 'next/server'
import { apiFetch, getSessionToken } from '@/lib/session'

// GET /api/users/me/kyc-rejection → GET /v1/users/me/kyc-rejection. The pay
// step's bridge_rejection branch (K6) reads Bridge's customer-facing reasons
// and the retries left to decide between the Persona offer and the terminal
// card. Reason strings can reference the user's documents: they go to the
// client for display and nowhere else (never logged here, never in URLs).
export async function GET() {
  const token = await getSessionToken()
  if (!token) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  try {
    const apiRes = await apiFetch('/v1/users/me/kyc-rejection', token)
    const body = await apiRes.json().catch(() => ({}))
    return NextResponse.json(body, { status: apiRes.status })
  } catch {
    // Fixed string: an upstream error could wrap the reason text.
    console.error('KYC rejection fetch error')
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
