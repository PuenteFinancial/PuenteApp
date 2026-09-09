import { NextRequest, NextResponse } from 'next/server'
import { apiFetch, getSessionToken } from '@/lib/session'
import { forwardIdempotencyKey } from '@/lib/proxy'

// POST /api/ops/transfers/hold-release → POST /v1/ops/transfers/hold-release
// (ops board slice 1 / O-B: the Release hold button on the detail page).
// Initiates a payout submission, so it forwards the browser-minted
// Idempotency-Key. Body allowlist by destructuring — the actor is never in the
// body (the API takes it from the JWT); status/body relayed verbatim so the
// client's per-code branches see the API's own envelope.
export async function POST(req: NextRequest) {
  const token = await getSessionToken()
  if (!token) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  try {
    const { transferId, reason, note } = await req.json()
    const apiRes = await apiFetch('/v1/ops/transfers/hold-release', token, {
      method: 'POST',
      body: JSON.stringify({ transferId, reason, note }),
      headers: forwardIdempotencyKey(req),
    })
    const body = await apiRes.json().catch(() => ({}))
    return NextResponse.json(body, { status: apiRes.status })
  } catch (err) {
    console.error('Ops hold-release error:', err instanceof Error ? err.message : 'Unknown error')
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
