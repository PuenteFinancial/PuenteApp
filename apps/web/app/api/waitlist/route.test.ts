import { describe, it, expect, beforeEach, vi } from 'vitest'
import { NextRequest } from 'next/server'

const capture = vi.fn()
const identify = vi.fn()

vi.mock('@/lib/posthog-server', () => ({
  getPostHogClient: () => ({ capture, identify }),
  flushPostHog: async () => {},
}))

vi.mock('@/lib/apiBaseUrl', () => ({
  internalApiUrl: () => 'http://api.test',
}))

const { POST } = await import('./route')

const FORM_BODY = {
  first_name: 'María Santos',
  phone: '5551234567',
  destination_country: 'Mexico',
  referral_source: 'Instagram',
  lang: 'es',
  submission_id: '11111111-1111-4111-8111-111111111111',
  attempt: 1,
}

function request(body: Record<string, unknown> = FORM_BODY) {
  return new NextRequest('https://puentefinancial.com/api/waitlist', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-POSTHOG-DISTINCT-ID': 'ph-distinct-1',
      'X-POSTHOG-SESSION-ID': 'ph-session-1',
    },
    body: JSON.stringify(body),
  })
}

function forwardedBody(): Record<string, unknown> {
  const fetchMock = globalThis.fetch as unknown as ReturnType<typeof vi.fn>
  return JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))
}

function capturedEvent(name: string) {
  return capture.mock.calls.map(([arg]) => arg).find((arg) => arg?.event === name)
}

beforeEach(() => {
  capture.mockReset()
  identify.mockReset()
})

describe('POST /api/waitlist', () => {
  it('forwards the diagnostic fields and the browser distinct id', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify({ success: true }), { status: 200 })),
    )

    const res = await POST(request({ ...FORM_BODY, attempt: 2, prior_error: 'http_504' }))

    expect(res.status).toBe(200)
    expect(forwardedBody()).toMatchObject({
      submission_id: '11111111-1111-4111-8111-111111111111',
      attempt: 2,
      prior_error: 'http_504',
      client_distinct_id: 'ph-distinct-1',
    })
  })

  it('omits the diagnostic fields when the client did not send them', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify({ success: true }), { status: 200 })),
    )
    const { submission_id, attempt, ...withoutDiagnostics } = FORM_BODY
    void submission_id
    void attempt

    await POST(request(withoutDiagnostics))

    const body = forwardedBody()
    expect(body).not.toHaveProperty('submission_id')
    expect(body).not.toHaveProperty('attempt')
    expect(body).not.toHaveProperty('prior_error')
  })

  it('returns 504 and reports the timeout when the API stalls', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw Object.assign(new Error('signal timed out'), { name: 'TimeoutError' })
      }),
    )

    const res = await POST(request())

    // Not 500: the write may have committed, and the client records this exact
    // status as the prior_error it carries into a retry.
    expect(res.status).toBe(504)
    const event = capturedEvent('waitlist_upstream_unreachable')
    expect(event?.properties).toMatchObject({
      reason: 'timeout',
      submission_id: '11111111-1111-4111-8111-111111111111',
      attempt: 1,
    })
    expect(typeof event?.properties?.upstream_ms).toBe('number')
  })

  it('distinguishes a transport failure from a timeout', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new TypeError('fetch failed')
      }),
    )

    const res = await POST(request())

    expect(res.status).toBe(504)
    expect(capturedEvent('waitlist_upstream_unreachable')?.properties).toMatchObject({
      reason: 'transport',
    })
  })

  it('sets a deadline on the upstream call', async () => {
    // Params are declared so the call tuple keeps its shape — an argless mock
    // types every recorded call as `[]`, which loses `init.signal`.
    const fetchMock = vi.fn(
      async (_input: RequestInfo | URL, _init?: RequestInit) =>
        new Response(JSON.stringify({ success: true }), { status: 200 }),
    )
    vi.stubGlobal('fetch', fetchMock)

    await POST(request())

    // Without a signal the platform kills the invocation instead, and a killed
    // invocation flushes no analytics at all.
    expect(fetchMock.mock.calls[0]?.[1]?.signal).toBeInstanceOf(AbortSignal)
  })

  it('still passes an upstream 400 through as a 400', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(JSON.stringify({ error: { code: 'validation_error', message: 'bad' } }), {
            status: 400,
          }),
      ),
    )

    const res = await POST(request())

    expect(res.status).toBe(400)
    expect(capturedEvent('waitlist_signup_failed')?.properties).toMatchObject({
      error_code: 'validation_error',
    })
  })

  it('rejects a submission with no first name before calling the API', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)

    const res = await POST(request({ ...FORM_BODY, first_name: '  ' }))

    expect(res.status).toBe(400)
    expect(fetchMock).not.toHaveBeenCalled()
  })
})
