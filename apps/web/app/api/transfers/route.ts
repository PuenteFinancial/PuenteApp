import { NextRequest, NextResponse } from 'next/server'
import { apiFetch, getSessionToken } from '@/lib/session'
import { forwardIdempotencyKey } from '@/lib/proxy'

// GET /api/transfers → GET /v1/transfers (cursor-paginated list).
export async function GET(req: NextRequest) {
  const token = await getSessionToken()
  if (!token) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  try {
    const { searchParams } = new URL(req.url)
    const qs = new URLSearchParams()
    const limit = searchParams.get('limit')
    const cursor = searchParams.get('cursor')
    if (limit) qs.set('limit', limit)
    if (cursor) qs.set('cursor', cursor)
    const path = `/v1/transfers${qs.toString() ? `?${qs.toString()}` : ''}`
    const apiRes = await apiFetch(path, token)
    const body = await apiRes.json().catch(() => ({}))
    return NextResponse.json(body, { status: apiRes.status })
  } catch (err) {
    console.error('Transfer list error:', err instanceof Error ? err.message : 'Unknown error')
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}

// POST /api/transfers → POST /v1/transfers (create). Money-moving: forwards the
// browser-minted Idempotency-Key verbatim; the proxy never mints its own.
export async function POST(req: NextRequest) {
  const token = await getSessionToken()
  if (!token) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  try {
    const { quoteId } = await req.json()
    const apiRes = await apiFetch('/v1/transfers', token, {
      method: 'POST',
      body: JSON.stringify({ quoteId }),
      headers: forwardIdempotencyKey(req),
    })
    const body = await apiRes.json().catch(() => ({}))
    return NextResponse.json(body, { status: apiRes.status })
  } catch (err) {
    console.error('Transfer create error:', err instanceof Error ? err.message : 'Unknown error')
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
