'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { useLanguage } from '@/components/LanguageProvider'

export default function ProfileForm() {
  const { t } = useLanguage()
  const s = t.onboarding.profile
  const router = useRouter()

  const [firstName, setFirstName] = useState('')
  const [lastName, setLastName] = useState('')
  const [email, setEmail] = useState('')
  const [status, setStatus] = useState<'idle' | 'loading' | 'error'>('idle')

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    setStatus('loading')

    try {
      const res = await fetch('/api/users/me', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ firstName, lastName, email }),
      })
      if (!res.ok) throw new Error('Failed')

      router.push('/onboarding/kyc')
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
        <div className="field-row">
          <div className="field">
            <label htmlFor="profile-first-name">{s.firstName}</label>
            <input
              id="profile-first-name"
              required
              autoComplete="given-name"
              value={firstName}
              onChange={(e) => setFirstName(e.target.value)}
            />
          </div>
          <div className="field">
            <label htmlFor="profile-last-name">{s.lastName}</label>
            <input
              id="profile-last-name"
              required
              autoComplete="family-name"
              value={lastName}
              onChange={(e) => setLastName(e.target.value)}
            />
          </div>
        </div>
        <div className="field">
          <label htmlFor="profile-email">{s.email}</label>
          <input
            id="profile-email"
            required
            type="email"
            autoComplete="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
          />
        </div>
        <p style={{ fontSize: 13, color: 'var(--muted)', margin: 0 }}>{s.emailNote}</p>

        <button
          className="btn btn--accent"
          type="submit"
          disabled={status === 'loading'}
          style={{ fontSize: 17, padding: '17px 28px' }}
        >
          {status === 'loading' ? s.saving : s.cta}
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
