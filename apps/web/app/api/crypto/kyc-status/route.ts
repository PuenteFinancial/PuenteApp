import { NextResponse } from 'next/server'
import { apiFetch, getSessionToken } from '@/lib/session'

// GET /api/crypto/kyc-status → GET /v1/crypto/kyc-status. The K5 pay step
// polls this (2.5s) while a KYC submission verifies. 404 = no crypto customer
// yet; 409 link_auth_required = restart Link auth.
export async function GET() {
  const token = await getSessionToken()
  if (!token) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  try {
    const apiRes = await apiFetch('/v1/crypto/kyc-status', token)
    const body = await apiRes.json().catch(() => ({}))
    return NextResponse.json(body, { status: apiRes.status })
  } catch (err) {
    console.error('KYC status fetch error:', err instanceof Error ? err.message : 'Unknown error')
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
