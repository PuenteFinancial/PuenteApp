import { NextRequest, NextResponse } from 'next/server'
import { apiFetch, getSessionToken } from '@/lib/session'

// The CLABE passes through this proxy in the request body and goes straight
// to the API over the internal network — it is never logged or persisted here.
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const token = await getSessionToken()
  if (!token) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  try {
    const { id } = await params
    const { method, currency, details, label } = await req.json()
    const apiRes = await apiFetch(`/v1/recipients/${encodeURIComponent(id)}/destinations`, token, {
      method: 'POST',
      body: JSON.stringify({
        method,
        currency,
        details,
        ...(label !== undefined && { label }),
      }),
    })
    const body = await apiRes.json().catch(() => ({}))
    return NextResponse.json(body, { status: apiRes.status })
  } catch (err) {
    // no PII in this log line — the error message never includes the body
    console.error('Destination create error:', err instanceof Error ? err.message : 'Unknown error')
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
