import { NextResponse } from 'next/server'
import { apiFetch, getSessionToken, requestOrigin } from '@/lib/session'

export async function POST() {
  const token = await getSessionToken()
  if (!token) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  try {
    const origin = await requestOrigin()
    const apiRes = await apiFetch('/v1/users/me/kyc-link/retry', token, {
      method: 'POST',
      body: JSON.stringify(origin ? { origin } : {}),
    })
    const body = await apiRes.json().catch(() => ({}))

    if (apiRes.ok) {
      // Same guard as the tos-return page: the browser only ever gets sent
      // to Bridge or its KYC vendor Persona, never an arbitrary host.
      const ALLOWED_HOSTS = ['bridge.xyz', 'bridge.withpersona.com']
      const { url } = body as { url?: string }
      let host = ''
      let protocol = ''
      try {
        const parsed = new URL(url ?? '')
        host = parsed.hostname
        protocol = parsed.protocol
      } catch {
        return NextResponse.json({ error: 'Verification unavailable' }, { status: 502 })
      }
      if (protocol !== 'https:' || (!ALLOWED_HOSTS.includes(host) && !host.endsWith('.bridge.xyz'))) {
        // host only — never log the full URL (contains inquiry/reference ids)
        console.error(`KYC retry returned an unexpected redirect host: ${host}`)
        return NextResponse.json({ error: 'Verification unavailable' }, { status: 502 })
      }
    }

    return NextResponse.json(body, { status: apiRes.status })
  } catch (err) {
    console.error('KYC retry error:', err instanceof Error ? err.message : 'Unknown error')
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
