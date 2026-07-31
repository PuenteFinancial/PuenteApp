import { NextRequest, NextResponse } from 'next/server'
import { apiFetch, getSessionToken } from '@/lib/session'

// GET /api/transfers/:id/funding-session → GET /v1/transfers/:id/funding-session
// (pay-step bootstrap: { provider, clientSecret?, publishableKey? }). Plain
// forwarder — the clientSecret passes through to the browser and is never
// logged or stored here.
export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const token = await getSessionToken()
  if (!token) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  try {
    const { id } = await params
    const apiRes = await apiFetch(`/v1/transfers/${encodeURIComponent(id)}/funding-session`, token)
    const body = await apiRes.json().catch(() => ({}))
    return NextResponse.json(body, { status: apiRes.status })
  } catch (err) {
    console.error('Funding session fetch error:', err instanceof Error ? err.message : 'Unknown error')
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
