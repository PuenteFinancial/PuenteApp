import { NextRequest, NextResponse } from 'next/server'
import { apiFetch, getSessionToken } from '@/lib/session'

// Client-side status polling (pending page) — client JS never talks to the
// Fastify API directly, so reads go through this proxy too.
export async function GET() {
  const token = await getSessionToken()
  if (!token) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  try {
    const apiRes = await apiFetch('/v1/users/me', token)
    const body = await apiRes.json().catch(() => ({}))
    return NextResponse.json(body, { status: apiRes.status })
  } catch (err) {
    console.error('User fetch error:', err instanceof Error ? err.message : 'Unknown error')
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}

export async function PATCH(req: NextRequest) {
  const token = await getSessionToken()
  if (!token) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  try {
    const { firstName, lastName, email, addressLine1, addressLine2, addressCity, addressState, addressPostalCode } =
      await req.json()

    const apiRes = await apiFetch('/v1/users/me', token, {
      method: 'PATCH',
      // Address group is optional (the frozen mobile app PATCHes name-only);
      // JSON.stringify drops undefined keys, so absent stays absent.
      body: JSON.stringify({
        firstName,
        lastName,
        email,
        addressLine1,
        addressLine2,
        addressCity,
        addressState,
        addressPostalCode,
      }),
    })

    const body = await apiRes.json().catch(() => ({}))
    return NextResponse.json(body, { status: apiRes.status })
  } catch (err) {
    console.error('Profile update error:', err instanceof Error ? err.message : 'Unknown error')
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
