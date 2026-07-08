'use client'

import { useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import { useLanguage } from '@/components/LanguageProvider'
import { SIGNUP_PHONE_KEY } from '@/lib/phone'

type Status = 'idle' | 'loading' | 'error' | 'resent'

export default function OtpForm() {
  const { t } = useLanguage()
  const s = t.onboarding.verify
  const router = useRouter()

  const [phone, setPhone] = useState<string | null>(null)
  const [code, setCode] = useState('')
  const [status, setStatus] = useState<Status>('idle')

  useEffect(() => {
    const stored = sessionStorage.getItem(SIGNUP_PHONE_KEY)
    if (!stored) {
      router.replace('/signup')
      return
    }
    setPhone(stored)
  }, [router])

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
    if (!phone) return
    try {
      // Consent was already given on the signup form that sent them here
      const res = await fetch('/api/auth/otp/send', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ phone, smsConsent: true }),
      })
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
          disabled={status === 'loading'}
        >
          {s.resend}
        </button>

        {status === 'resent' && (
          <p role="status" style={{ color: 'var(--muted)', fontFamily: 'var(--mono)', fontSize: 12, textAlign: 'center', margin: '4px 0 0' }}>
            {s.resent}
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
