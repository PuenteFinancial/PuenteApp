import { NextRequest, NextResponse } from 'next/server'
import { apiFetch, getSessionToken } from '@/lib/session'

// POST /api/ops/transfers/deposit-instructions → the attach action
// (funding-ops-automation slice 1; break-glass once slice 3 auto-attaches).
// No Idempotency-Key: the API route is naturally idempotent (upsert of a pure
// Bridge read) and takes none.
export async function POST(req: NextRequest) {
  const token = await getSessionToken()
  if (!token) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  try {
    const { transferId, bridgeTransferId } = await req.json()
    const apiRes = await apiFetch('/v1/ops/transfers/deposit-instructions', token, {
      method: 'POST',
      body: JSON.stringify({ transferId, bridgeTransferId }),
    })
    const body = await apiRes.json().catch(() => ({}))
    return NextResponse.json(body, { status: apiRes.status })
  } catch (err) {
    console.error('Ops attach error:', err instanceof Error ? err.message : 'Unknown error')
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
