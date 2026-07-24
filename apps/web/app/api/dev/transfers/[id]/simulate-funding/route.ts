import { NextRequest, NextResponse } from 'next/server'
import { apiFetch, getSessionToken } from '@/lib/session'
import { isProductionEnv } from '@/lib/flags'

// POST /api/dev/transfers/:id/simulate-funding → POST /v1/dev/transfers/:id/
// simulate-funding. Stands in for the Stripe pay step until real keys land: the
// API signs a mock funding event with a secret that exists only in its own env
// (never here) and drives it through the real funding webhook.
//
// The API is the authority — it 404s outside non-production and refuses without
// the mock secret — but this proxy refuses in production too, so the route is
// not even a reachable forwarder there. No Idempotency-Key: the endpoint is not
// idempotency-keyed (its PENDING_PAYMENT guard makes a double-fire a clean 409).
export async function POST(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  if (isProductionEnv()) {
    return NextResponse.json({ error: 'Not found' }, { status: 404 })
  }

  const token = await getSessionToken()
  if (!token) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  try {
    const { id } = await params
    // Empty JSON object, NOT an absent body: apiFetch always sets
    // `Content-Type: application/json`, and Fastify rejects a JSON-typed request
    // with an empty body ("Body cannot be empty when content-type is set to
    // 'application/json'") — a 400 before the handler ever runs. The endpoint
    // takes no parameters, so `{}` is the correct payload.
    const apiRes = await apiFetch(
      `/v1/dev/transfers/${encodeURIComponent(id)}/simulate-funding`,
      token,
      { method: 'POST', body: '{}' },
    )
    const body = await apiRes.json().catch(() => ({}))
    return NextResponse.json(body, { status: apiRes.status })
  } catch (err) {
    console.error('Simulate funding error:', err instanceof Error ? err.message : 'Unknown error')
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
