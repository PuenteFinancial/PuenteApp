'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { useLanguage } from '@/components/LanguageProvider'
import { SIGNUP_PHONE_KEY, normalizePhone } from '@/lib/phone'

export default function PhoneForm() {
  const { t } = useLanguage()
  const s = t.onboarding.signup
  const router = useRouter()

  const [phone, setPhone] = useState('')
  const [smsConsent, setSmsConsent] = useState(false)
  const [status, setStatus] = useState<'idle' | 'loading' | 'error'>('idle')

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    setStatus('loading')

    const normalized = normalizePhone(phone)

    try {
      const res = await fetch('/api/auth/otp/send', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ phone: normalized, smsConsent }),
      })
      if (!res.ok) throw new Error('Failed')

      // Phone stays out of the URL (PII rule) — the verify page reads it here
      sessionStorage.setItem(SIGNUP_PHONE_KEY, normalized)
      router.push('/signup/verify')
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
          <label htmlFor="signup-phone">{s.phone}</label>
          <input
            id="signup-phone"
            required
            type="tel"
            inputMode="tel"
            autoComplete="tel"
            value={phone}
            onChange={(e) => setPhone(e.target.value)}
            placeholder={s.phonePh}
          />
        </div>

        {/* TCPA: unchecked by default, required before any SMS is sent */}
        <label style={{ display: 'flex', gap: 10, alignItems: 'flex-start', cursor: 'pointer' }}>
          <input
            type="checkbox"
            required
            checked={smsConsent}
            onChange={(e) => setSmsConsent(e.target.checked)}
            style={{ marginTop: 3, flexShrink: 0 }}
          />
          <span style={{ fontSize: 13, color: 'var(--muted)', lineHeight: 1.5 }}>
            {s.smsConsent}
          </span>
        </label>

        <button
          className="btn btn--accent"
          type="submit"
          disabled={status === 'loading'}
          style={{ fontSize: 17, padding: '17px 28px' }}
        >
          {status === 'loading' ? s.sending : s.cta}
        </button>

        {status === 'error' && (
          <p role="alert" style={{ color: 'var(--color-error)', fontFamily: 'var(--mono)', fontSize: 12, textAlign: 'center', margin: '4px 0 0' }}>
            {s.error}
          </p>
        )}
      </form>
    </div>
  )
}
