import { NextRequest, NextResponse } from 'next/server'
import { apiFetch, getSessionToken } from '@/lib/session'
import { forwardIdempotencyKey } from '@/lib/proxy'

// POST /api/ops/transfers/refund → POST /v1/ops/transfers/refund (ops board
// slice 1 / O-B: the Refund button on a PAYOUT_FAILED detail page). Money-
// moving: forwards the browser-minted Idempotency-Key. Body allowlist by
// destructuring — there is NO reclaim field on purpose (an abandoned claim is
// the STOP state; runbook only); status/body relayed verbatim so the client's
// danger branches (claim_abandoned, principal_not_returned) see the API's code.
export async function POST(req: NextRequest) {
  const token = await getSessionToken()
  if (!token) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  try {
    const { transferId, note } = await req.json()
    const apiRes = await apiFetch('/v1/ops/transfers/refund', token, {
      method: 'POST',
      body: JSON.stringify({ transferId, note }),
      headers: forwardIdempotencyKey(req),
    })
    const body = await apiRes.json().catch(() => ({}))
    return NextResponse.json(body, { status: apiRes.status })
  } catch (err) {
    console.error('Ops refund error:', err instanceof Error ? err.message : 'Unknown error')
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
