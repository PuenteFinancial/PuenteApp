import { NextRequest, NextResponse } from 'next/server'
import { apiFetch } from '@/lib/session'

export async function POST(req: NextRequest) {
  try {
    const { phone, smsConsent } = await req.json()
    if (typeof phone !== 'string' || !phone.trim()) {
      return NextResponse.json({ error: 'Phone number is required' }, { status: 400 })
    }
    if (smsConsent !== true) {
      return NextResponse.json({ error: 'SMS consent is required' }, { status: 400 })
    }

    const apiRes = await apiFetch('/v1/auth/otp/send', null, {
      method: 'POST',
      body: JSON.stringify({ phone: phone.trim(), smsConsent: true }),
    })

    if (!apiRes.ok) {
      // status only — never the phone number
      console.error('OTP send failed with status', apiRes.status)
      return NextResponse.json({ error: 'Failed to send code' }, { status: 502 })
    }

    return NextResponse.json({ ok: true })
  } catch (err) {
    console.error('OTP send error:', err instanceof Error ? err.message : 'Unknown error')
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
