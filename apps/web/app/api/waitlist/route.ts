import { createHash } from 'crypto'
import { NextRequest, NextResponse } from 'next/server'
import { getPostHogClient, flushPostHog } from '@/lib/posthog-server'
import { internalApiUrl } from '@/lib/apiBaseUrl'
import { parseApiError } from '@/lib/apiError'

// Hash phone so PostHog never holds raw PII — same phone always hashes to same ID
function hashPhone(phone: string): string {
  return createHash('sha256').update(phone.trim().replace(/\s+/g, '')).digest('hex')
}

// Deliberately under the 10s floor of every Vercel plan. Without our own
// deadline the platform kills the invocation instead, and a killed invocation
// logs nothing and flushes no analytics — the exact blind spot that makes a
// "the row committed but the response was lost" duplicate impossible to prove.
const UPSTREAM_TIMEOUT_MS = 8_000

export async function POST(req: NextRequest) {
  const distinctId = req.headers.get('X-POSTHOG-DISTINCT-ID')
  const sessionId = req.headers.get('X-POSTHOG-SESSION-ID')

  try {
    const body = await req.json()
    const {
      first_name,
      phone,
      destination_country,
      referral_source,
      referral_source_other,
      lang,
      // Duplicate-submission diagnostics. Passed straight through to the API,
      // which stores them on the row and classifies any collision.
      submission_id,
      attempt,
      prior_error,
    } = body

    if (!first_name?.trim()) {
      return NextResponse.json({ error: 'First name is required' }, { status: 400 })
    }
    if (!phone?.trim()) {
      return NextResponse.json({ error: 'Phone number is required' }, { status: 400 })
    }
    if (!destination_country?.trim()) {
      return NextResponse.json({ error: 'Destination country is required' }, { status: 400 })
    }
    if (!referral_source?.trim()) {
      return NextResponse.json({ error: 'Referral source is required' }, { status: 400 })
    }
    if (referral_source === 'Other' && !referral_source_other?.trim()) {
      return NextResponse.json({ error: 'Please specify how you heard about us' }, { status: 400 })
    }

    const url = new URL(req.url)
    const referer = req.headers.get('referer')
    const utm_source_referer = referer
      ? (() => {
          try {
            return new URL(referer).searchParams.get('utm_source')
          } catch {
            return null
          }
        })()
      : null

    const apiUrl = internalApiUrl()

    // Computed before the call, not after: the failure path below needs an
    // identity to attribute its event to.
    const phoneHash = hashPhone(phone)
    const phId = distinctId ?? phoneHash

    const startedAt = Date.now()
    let apiRes: Response
    try {
      apiRes = await fetch(`${apiUrl}/v1/waitlist`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
        body: JSON.stringify({
          first_name: first_name.trim(),
          phone: phone.trim(),
          destination_country: destination_country.trim(),
          referral_source,
          ...(referral_source === 'Other' && { referral_source_other: referral_source_other.trim() }),
          language_preference: lang || 'en',
          ...(url.searchParams.get('utm_source') ?? utm_source_referer
            ? { utm_source: url.searchParams.get('utm_source') ?? utm_source_referer }
            : {}),
          ...(url.searchParams.get('utm_medium') && {
            utm_medium: url.searchParams.get('utm_medium'),
          }),
          ...(url.searchParams.get('utm_campaign') && {
            utm_campaign: url.searchParams.get('utm_campaign'),
          }),
          ...(req.headers.get('user-agent') && { user_agent: req.headers.get('user-agent') }),
          ...(submission_id && { submission_id }),
          ...(typeof attempt === 'number' && { attempt }),
          ...(prior_error && { prior_error }),
          ...(distinctId && { client_distinct_id: distinctId }),
        }),
      })
    } catch (err) {
      // The row may ALREADY exist. The insert can commit and the response still
      // be lost — a stalled upstream, a torn-down invocation, a dropped socket.
      // We cannot tell from here, so we report the failure honestly and let the
      // API classify the retry if one arrives. 504 (not 500) so the client can
      // record precisely what it saw.
      const upstreamMs = Date.now() - startedAt
      const reason =
        err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError')
          ? 'timeout'
          : 'transport'
      console.error('Waitlist upstream unreachable:', { reason, upstreamMs })
      const ph = getPostHogClient()
      ph.capture({
        distinctId: phId,
        event: 'waitlist_upstream_unreachable',
        properties: {
          reason,
          upstream_ms: upstreamMs,
          submission_id,
          attempt,
          destination_country,
          language: lang || 'en',
          $session_id: sessionId ?? undefined,
        },
      })
      await flushPostHog()
      return NextResponse.json({ error: 'Failed to join waitlist' }, { status: 504 })
    }

    if (!apiRes.ok) {
      // The API returns the uniform envelope { error: { code, message, ... } },
      // so `error` is an OBJECT here, not a string. Reading it as a string put
      // "[object Object]" into the analytics property and threw away the `code`
      // that makes a failure diagnosable.
      const errBody = await apiRes.json().catch(() => ({}))
      const apiError = parseApiError(errBody)
      console.error('Waitlist API error:', { status: apiRes.status, ...(apiError ?? { errBody }) })
      const ph = getPostHogClient()
      ph.capture({
        distinctId: phId,
        event: 'waitlist_signup_failed',
        properties: {
          destination_country,
          referral_source,
          language: lang || 'en',
          status: apiRes.status,
          error_code: apiError?.code ?? 'unknown',
          request_id: apiError?.requestId,
          submission_id,
          attempt,
          $session_id: sessionId ?? undefined,
        },
      })
      await flushPostHog()
      // Pass the upstream status through instead of flattening everything to
      // 500: a 400 is the submitter's to fix and the client renders a different
      // message for it, while 5xx is ours.
      const status = apiRes.status === 400 ? 400 : 500
      return NextResponse.json({ error: 'Failed to join waitlist' }, { status })
    }

    const ph = getPostHogClient()
    ph.identify({
      distinctId: phId,
      properties: {
        first_name: first_name.trim(),
        // No phone or email in PostHog — raw PII stays in Supabase only
        language_preference: lang || 'en',
      },
    })
    ph.capture({
      distinctId: phId,
      event: 'waitlist_signup_completed',
      properties: {
        destination_country,
        referral_source,
        language: lang || 'en',
        utm_source: url.searchParams.get('utm_source') ?? utm_source_referer,
        utm_medium: url.searchParams.get('utm_medium'),
        utm_campaign: url.searchParams.get('utm_campaign'),
        submission_id,
        attempt,
        $session_id: sessionId ?? undefined,
      },
    })

    await flushPostHog()
    return NextResponse.json({ success: true }, { status: 200 })
  } catch (err) {
    console.error('Waitlist API error:', err instanceof Error ? err.message : 'Unknown error')
    const ph = getPostHogClient()
    ph.captureException(err, distinctId ?? 'anonymous')
    await flushPostHog()
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
