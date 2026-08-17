'use client'

import { useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import { useLanguage } from '@/components/LanguageProvider'
import { OTP_RESEND_COOLDOWN_SECONDS, SIGNUP_PHONE_KEY } from '@/lib/phone'

type Status = 'idle' | 'loading' | 'error' | 'resent' | 'rateLimited'

export default function OtpForm() {
  const { t } = useLanguage()
  const s = t.onboarding.verify
  const router = useRouter()

  const [phone, setPhone] = useState<string | null>(null)
  const [code, setCode] = useState('')
  const [status, setStatus] = useState<Status>('idle')
  // Resend was previously unthrottled here. The API now enforces a per-phone
  // cooldown of the same length (OTP_COOLDOWN_SECONDS defaults to this shared
  // constant), so without this the button's only feedback for a second tap
  // would be a 429. Starts armed: this screen is only reached by a code having
  // just been sent.
  const [cooldown, setCooldown] = useState(OTP_RESEND_COOLDOWN_SECONDS)

  useEffect(() => {
    const stored = sessionStorage.getItem(SIGNUP_PHONE_KEY)
    if (!stored) {
      router.replace('/signup')
      return
    }
    setPhone(stored)
  }, [router])

  // One interval for the life of the form; resending restarts the count by
  // setting the number, not by re-arming a timer.
  useEffect(() => {
    const id = setInterval(() => {
      setCooldown((n) => (n > 0 ? n - 1 : 0))
    }, 1000)
    return () => clearInterval(id)
  }, [])

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!phone) return
    setStatus('loading')

    try {
      const res = await fetch('/api/auth/otp/verify', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ phone, token: code }),
      })
      if (!res.ok) throw new Error('Failed')

      sessionStorage.removeItem(SIGNUP_PHONE_KEY)
      // /continue routes by server-side state — never assume a fresh signup
      router.push('/continue')
    } catch {
      setStatus('error')
    }
  }

  const handleResend = async () => {
    if (!phone || cooldown > 0) return
    setCooldown(OTP_RESEND_COOLDOWN_SECONDS)
    try {
      // Consent was already given on the signup form that sent them here
      const res = await fetch('/api/auth/otp/send', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ phone, smsConsent: true }),
      })
      // 429 is its own state — see the note in mobile's verify screen. The
      // generic error claims the code was wrong, which is not what happened.
      if (res.status === 429) {
        setStatus('rateLimited')
        return
      }
      if (!res.ok) throw new Error('Failed')
      setStatus('resent')
    } catch {
      setStatus('error')
    }
  }

  return (
    <div className="wl-card">
      <h1 style={{ fontFamily: 'var(--font)', fontSize: 24, fontWeight: 700, margin: '0 0 8px', color: 'var(--ink)' }}>
        {s.title}
      </h1>
      <p style={{ fontSize: 15, color: 'var(--muted)', margin: '0 0 20px' }}>{s.sub}</p>

      <form className="wl-form" onSubmit={handleSubmit}>
        <div className="field">
          <label htmlFor="otp-code">{s.code}</label>
          <input
            id="otp-code"
            required
            inputMode="numeric"
            autoComplete="one-time-code"
            pattern="[0-9]{6}"
            maxLength={6}
            value={code}
            onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))}
            placeholder="123456"
          />
        </div>

        <button
          className="btn btn--accent"
          type="submit"
          disabled={status === 'loading' || !phone}
          style={{ fontSize: 17, padding: '17px 28px' }}
        >
          {status === 'loading' ? s.verifying : s.cta}
        </button>

        <button
          type="button"
          className="btn btn--ghost btn--sm"
          onClick={handleResend}
          disabled={cooldown > 0 || status === 'loading'}
        >
          {cooldown > 0 ? s.resendIn(cooldown) : s.resend}
        </button>

        {status === 'resent' && (
          <p role="status" style={{ color: 'var(--muted)', fontFamily: 'var(--mono)', fontSize: 12, textAlign: 'center', margin: '4px 0 0' }}>
            {s.resent}
          </p>
        )}
        {status === 'rateLimited' && (
          <p role="alert" style={{ color: 'var(--color-error)', fontSize: 13, textAlign: 'center', margin: '4px 0 0' }}>
            {t.send.errors.rate_limited}
          </p>
        )}

        {status === 'error' && (
          <p role="alert" style={{ color: 'var(--color-error)', fontFamily: 'var(--mono)', fontSize: 12, textAlign: 'center', margin: '4px 0 0' }}>
            {s.error}
          </p>
        )}
      </form>
    </div>
  )
}
