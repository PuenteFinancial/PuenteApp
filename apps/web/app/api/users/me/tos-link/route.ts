import { NextResponse } from 'next/server'
import { apiFetch, getSessionToken, requestOrigin } from '@/lib/session'

export async function POST() {
  const token = await getSessionToken()
  if (!token) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  try {
    const origin = await requestOrigin()
    const apiRes = await apiFetch('/v1/users/me/tos-link', token, {
      method: 'POST',
      body: JSON.stringify(origin ? { origin } : {}),
    })
    const body = await apiRes.json().catch(() => ({}))
    return NextResponse.json(body, { status: apiRes.status })
  } catch (err) {
    console.error('ToS link error:', err instanceof Error ? err.message : 'Unknown error')
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
