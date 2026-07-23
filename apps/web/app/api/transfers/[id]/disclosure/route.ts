import { NextRequest, NextResponse } from 'next/server'
import { apiFetch, getSessionToken } from '@/lib/session'

// GET /api/transfers/:id/disclosure → GET /v1/transfers/:id/disclosure
// (server-authored Reg E prepayment disclosure content).
export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const token = await getSessionToken()
  if (!token) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  try {
    const { id } = await params
    const apiRes = await apiFetch(`/v1/transfers/${encodeURIComponent(id)}/disclosure`, token)
    const body = await apiRes.json().catch(() => ({}))
    return NextResponse.json(body, { status: apiRes.status })
  } catch (err) {
    console.error('Disclosure fetch error:', err instanceof Error ? err.message : 'Unknown error')
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
