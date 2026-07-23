import { NextRequest, NextResponse } from 'next/server'
import { apiFetch, getSessionToken } from '@/lib/session'
import { forwardIdempotencyKey } from '@/lib/proxy'

// POST /api/transfers/:id/cancel → POST /v1/transfers/:id/cancel. Money-moving:
// forwards the browser-minted Idempotency-Key. The body MUST carry transferId —
// the API's idempotency identity excludes the :id path param, so transferId in
// the body is what ties a reused key to THIS transfer (otherwise a reused key
// could replay a different transfer's cancel).
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const token = await getSessionToken()
  if (!token) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  try {
    const { id } = await params
    const { transferId } = await req.json()
    const apiRes = await apiFetch(`/v1/transfers/${encodeURIComponent(id)}/cancel`, token, {
      method: 'POST',
      body: JSON.stringify({ transferId }),
      headers: forwardIdempotencyKey(req),
    })
    const body = await apiRes.json().catch(() => ({}))
    return NextResponse.json(body, { status: apiRes.status })
  } catch (err) {
    console.error('Transfer cancel error:', err instanceof Error ? err.message : 'Unknown error')
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
