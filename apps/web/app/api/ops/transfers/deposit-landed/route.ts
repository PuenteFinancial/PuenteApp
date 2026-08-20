import { NextRequest, NextResponse } from 'next/server'
import { apiFetch, getSessionToken } from '@/lib/session'

// POST /api/ops/transfers/deposit-landed → the "deposit landed" button:
// cleared + float top-up in one action (funding-ops-automation slice 1).
// No Idempotency-Key: both legs are naturally idempotent on the onramp ref
// (cleared replays as cleared_skipped; the ledger key is float_topup:<ref>),
// so a re-tap heals a partial failure instead of double-counting.
export async function POST(req: NextRequest) {
  const token = await getSessionToken()
  if (!token) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  try {
    const { transferId, externalRef, amountMinor, currency } = await req.json()
    const apiRes = await apiFetch('/v1/ops/transfers/deposit-landed', token, {
      method: 'POST',
      body: JSON.stringify({ transferId, externalRef, amountMinor, currency }),
    })
    const body = await apiRes.json().catch(() => ({}))
    return NextResponse.json(body, { status: apiRes.status })
  } catch (err) {
    console.error('Ops deposit-landed error:', err instanceof Error ? err.message : 'Unknown error')
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
