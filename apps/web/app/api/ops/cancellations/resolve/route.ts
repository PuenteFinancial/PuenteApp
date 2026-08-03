import { NextRequest, NextResponse } from 'next/server'
import { apiFetch, getSessionToken } from '@/lib/session'
import { forwardIdempotencyKey } from '@/lib/proxy'

// POST /api/ops/cancellations/resolve → POST /v1/ops/cancellations/resolve
// (slice 8.5-v1.1). Money-moving: forwards the browser-minted Idempotency-Key.
// No path param by design — transferId (and the decision) live in the body, so
// the API's idempotency identity is inherently per-transfer and per-decision.
// The status and body are relayed verbatim: the client branches on the real
// API codes (404 gate posture, the 409 refusal taxonomy) via resolveErrorKind.
export async function POST(req: NextRequest) {
  const token = await getSessionToken()
  if (!token) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  try {
    const { transferId, decision, depositedAt } = await req.json()
    const apiRes = await apiFetch('/v1/ops/cancellations/resolve', token, {
      method: 'POST',
      body: JSON.stringify({
        transferId,
        decision,
        ...(depositedAt !== undefined && { depositedAt }),
      }),
      headers: forwardIdempotencyKey(req),
    })
    const body = await apiRes.json().catch(() => ({}))
    return NextResponse.json(body, { status: apiRes.status })
  } catch (err) {
    console.error('Ops resolve error:', err instanceof Error ? err.message : 'Unknown error')
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
