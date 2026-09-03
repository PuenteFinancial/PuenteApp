import { NextResponse } from 'next/server'
import { apiFetch, getSessionToken } from '@/lib/session'

// GET /api/config/web → GET /v1/config/web. The publishable key for surfaces
// with no transfer to fetch a funding session for (K6b: the profile page's
// AddressElement). Server-side var on the API, never NEXT_PUBLIC_; null when
// unset, so callers degrade rather than fail.
export async function GET() {
  const token = await getSessionToken()
  if (!token) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  try {
    const apiRes = await apiFetch('/v1/config/web', token)
    const body = await apiRes.json().catch(() => ({}))
    return NextResponse.json(body, { status: apiRes.status })
  } catch (err) {
    console.error('Web config fetch error:', err instanceof Error ? err.message : 'Unknown error')
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
