import { NextRequest, NextResponse } from 'next/server'
import { apiFetch, getSessionToken } from '@/lib/session'
import { forwardIdempotencyKey } from '@/lib/proxy'

// POST /api/ops/treasury/float-topup → POST /v1/ops/treasury/float-topup
// (funding-ops-automation slice 2: the ad-hoc top-up card). Money-moving:
// forwards the browser-minted Idempotency-Key — which is also what the API
// derives the ledger ref from when the operator leaves the reference blank.
export async function POST(req: NextRequest) {
  const token = await getSessionToken()
  if (!token) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  try {
    const { amountMinor, currency, externalRef } = await req.json()
    const apiRes = await apiFetch('/v1/ops/treasury/float-topup', token, {
      method: 'POST',
      body: JSON.stringify({
        amountMinor,
        currency,
        ...(externalRef !== undefined && { externalRef }),
      }),
      headers: forwardIdempotencyKey(req),
    })
    const body = await apiRes.json().catch(() => ({}))
    return NextResponse.json(body, { status: apiRes.status })
  } catch (err) {
    console.error('Ops float-topup error:', err instanceof Error ? err.message : 'Unknown error')
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
