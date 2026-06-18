import { NextRequest, NextResponse } from 'next/server'
import { getSupabaseClient } from '@/lib/supabase'
import { getPostHogClient } from '@/lib/posthog-server'

export async function POST(req: NextRequest) {
  const distinctId = req.headers.get('X-POSTHOG-DISTINCT-ID')
  const sessionId = req.headers.get('X-POSTHOG-SESSION-ID')

  try {
    const body = await req.json()
    const { first_name, phone, email, monthly_send_amount, destination_country, remittance_provider, remit_frequency, remit_years, knows_credit_score, credit_score_range, lang } = body

    if (!first_name?.trim()) {
      return NextResponse.json({ error: 'First name is required' }, { status: 400 })
    }
    if (!phone?.trim()) {
      return NextResponse.json({ error: 'Phone number is required' }, { status: 400 })
    }
    const url = new URL(req.url)
    const utm_source = req.headers.get('referer')
      ? new URL(req.headers.get('referer')!).searchParams.get('utm_source')
      : null

    const supabase = getSupabaseClient()
    const { error } = await supabase.from('waitlist').insert({
      first_name: first_name.trim(),
      phone: phone.trim(),
      email: email?.trim() || null,
      monthly_send_amount: monthly_send_amount || null,
      destination_country: destination_country || null,
      remittance_provider: remittance_provider || null,
      remit_frequency: remit_frequency || null,
      remit_years: remit_years || null,
      knows_credit_score: knows_credit_score || null,
      credit_score_range: credit_score_range || null,
      language_preference: lang || 'en',
      utm_source: url.searchParams.get('utm_source') ?? utm_source,
      utm_medium: url.searchParams.get('utm_medium'),
      utm_campaign: url.searchParams.get('utm_campaign'),
      user_agent: req.headers.get('user-agent'),
    })

    if (error) {
      console.error('Supabase insert error:', error)
      const ph = getPostHogClient()
      ph.capture({
        distinctId: distinctId ?? phone.trim(),
        event: 'waitlist_signup_failed',
        properties: {
          destination_country,
          monthly_send_amount,
          language: lang || 'en',
          error: error.message,
          $session_id: sessionId ?? undefined,
        },
      })
      return NextResponse.json({ error: 'Failed to join waitlist' }, { status: 500 })
    }

    const ph = getPostHogClient()
    ph.identify({
      distinctId: distinctId ?? phone.trim(),
      properties: {
        first_name: first_name.trim(),
        phone: phone.trim(),
        email: email?.trim() || undefined,
        language_preference: lang || 'en',
      },
    })
    ph.capture({
      distinctId: distinctId ?? phone.trim(),
      event: 'waitlist_signup_completed',
      properties: {
        destination_country,
        monthly_send_amount,
        remittance_provider,
        remit_frequency: remit_frequency || undefined,
        remit_years: remit_years || undefined,
        language: lang || 'en',
        utm_source: url.searchParams.get('utm_source') ?? utm_source,
        utm_medium: url.searchParams.get('utm_medium'),
        utm_campaign: url.searchParams.get('utm_campaign'),
        $session_id: sessionId ?? undefined,
      },
    })

    return NextResponse.json({ success: true }, { status: 200 })
  } catch (err) {
    console.error('Waitlist API error:', err)
    const ph = getPostHogClient()
    ph.captureException(err, distinctId ?? 'anonymous')
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
