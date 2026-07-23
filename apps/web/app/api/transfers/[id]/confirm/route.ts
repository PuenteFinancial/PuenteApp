import { NextRequest, NextResponse } from 'next/server'
import { apiFetch, getSessionToken } from '@/lib/session'
import { forwardIdempotencyKey } from '@/lib/proxy'

// POST /api/transfers/:id/confirm → POST /v1/transfers/:id/confirm. Money-moving
// (initiates funding): forwards the browser-minted Idempotency-Key verbatim.
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const token = await getSessionToken()
  if (!token) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  try {
    const { id } = await params
    const { disclosureId, accepted } = await req.json()
    const apiRes = await apiFetch(`/v1/transfers/${encodeURIComponent(id)}/confirm`, token, {
      method: 'POST',
      body: JSON.stringify({ disclosureId, accepted }),
      headers: forwardIdempotencyKey(req),
    })
    const body = await apiRes.json().catch(() => ({}))
    return NextResponse.json(body, { status: apiRes.status })
  } catch (err) {
    console.error('Transfer confirm error:', err instanceof Error ? err.message : 'Unknown error')
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
