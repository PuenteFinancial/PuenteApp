import { createHash } from 'crypto'
import { NextRequest, NextResponse } from 'next/server'
import { getPostHogClient } from '@/lib/posthog-server'

// Hash phone so PostHog never holds raw PII — same phone always hashes to same ID
function hashPhone(phone: string): string {
  return createHash('sha256').update(phone.trim().replace(/\s+/g, '')).digest('hex')
}

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

    const apiUrl = process.env.INTERNAL_API_URL
    if (!apiUrl) throw new Error('INTERNAL_API_URL is not configured')

    const apiRes = await fetch(`${apiUrl}/v1/waitlist`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
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
      }),
    })

    const phoneHash = hashPhone(phone)
    const phId = distinctId ?? phoneHash

    if (!apiRes.ok) {
      const errBody = await apiRes.json().catch(() => ({})) as { error?: string }
      console.error('Waitlist API error:', errBody)
      const ph = getPostHogClient()
      ph.capture({
        distinctId: phId,
        event: 'waitlist_signup_failed',
        properties: {
          destination_country,
          referral_source,
          language: lang || 'en',
          error: errBody?.error ?? 'Unknown',
          $session_id: sessionId ?? undefined,
        },
      })
      return NextResponse.json({ error: 'Failed to join waitlist' }, { status: 500 })
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
        $session_id: sessionId ?? undefined,
      },
    })

    return NextResponse.json({ success: true }, { status: 200 })
  } catch (err) {
    console.error('Waitlist API error:', err instanceof Error ? err.message : 'Unknown error')
    const ph = getPostHogClient()
    ph.captureException(err, distinctId ?? 'anonymous')
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
