import { NextRequest, NextResponse } from 'next/server'
import { apiFetch, getSessionToken } from '@/lib/session'
import { forwardIdempotencyKey } from '@/lib/proxy'

// POST /api/ops/transfers/funding → POST /v1/ops/transfers/funding
// (funding-ops-automation slice 1: the Release payout button). Money-moving:
// forwards the browser-minted Idempotency-Key. Body allowlist by
// destructuring, status/body relayed verbatim — same shape as the
// cancellations/resolve proxy.
export async function POST(req: NextRequest) {
  const token = await getSessionToken()
  if (!token) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  try {
    const { transferId, kind, externalRef, amountMinor, currency } = await req.json()
    const apiRes = await apiFetch('/v1/ops/transfers/funding', token, {
      method: 'POST',
      body: JSON.stringify({ transferId, kind, externalRef, amountMinor, currency }),
      headers: forwardIdempotencyKey(req),
    })
    const body = await apiRes.json().catch(() => ({}))
    return NextResponse.json(body, { status: apiRes.status })
  } catch (err) {
    console.error('Ops funding error:', err instanceof Error ? err.message : 'Unknown error')
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
