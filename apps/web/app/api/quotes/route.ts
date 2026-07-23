import { NextRequest, NextResponse } from 'next/server'
import { apiFetch, getSessionToken } from '@/lib/session'

// POST /api/quotes → POST /v1/quotes. Quotes carry NO idempotency key by design
// (a duplicate quote is harmless — api-contract).
export async function POST(req: NextRequest) {
  const token = await getSessionToken()
  if (!token) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  try {
    const { payoutDestinationId, totalAmount } = await req.json()
    const apiRes = await apiFetch('/v1/quotes', token, {
      method: 'POST',
      body: JSON.stringify({
        payoutDestinationId,
        // Reconstruct the money object rather than passing the raw value through.
        totalAmount: totalAmount && {
          amountMinor: totalAmount.amountMinor,
          currency: totalAmount.currency,
        },
      }),
    })
    const body = await apiRes.json().catch(() => ({}))
    return NextResponse.json(body, { status: apiRes.status })
  } catch (err) {
    console.error('Quote create error:', err instanceof Error ? err.message : 'Unknown error')
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
