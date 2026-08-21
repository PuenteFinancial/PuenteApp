import { NextRequest, NextResponse } from 'next/server'
import { apiFetch, getSessionToken } from '@/lib/session'

// POST /api/transfers/:id/payment-claim → POST /v1/transfers/:id/payment-claim.
// No Idempotency-Key and no body: the claim is a set-once monotone flag keyed
// on the path — a replay returns the existing timestamp (funding-ops slice 4).
export async function POST(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const token = await getSessionToken()
  if (!token) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  try {
    const { id } = await params
    // apiFetch always sends Content-Type: application/json, and Fastify 400s
    // an EMPTY json body — so send an explicit empty object.
    const apiRes = await apiFetch(`/v1/transfers/${encodeURIComponent(id)}/payment-claim`, token, {
      method: 'POST',
      body: JSON.stringify({}),
    })
    const body = await apiRes.json().catch(() => ({}))
    return NextResponse.json(body, { status: apiRes.status })
  } catch (err) {
    console.error('Payment claim error:', err instanceof Error ? err.message : 'Unknown error')
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
