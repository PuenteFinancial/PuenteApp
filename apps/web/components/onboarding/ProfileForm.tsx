'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { US_STATES } from '@puente/shared'
import { useLanguage } from '@/components/LanguageProvider'

export type ProfileFormInitial = {
  firstName?: string
  lastName?: string
  email?: string
  addressLine1?: string
  addressLine2?: string
  addressCity?: string
  addressState?: string
  addressPostalCode?: string
}

export default function ProfileForm({ initial = {} }: { initial?: ProfileFormInitial }) {
  const { t } = useLanguage()
  const s = t.onboarding.profile
  const router = useRouter()

  const [firstName, setFirstName] = useState(initial.firstName ?? '')
  const [lastName, setLastName] = useState(initial.lastName ?? '')
  const [email, setEmail] = useState(initial.email ?? '')
  const [addressLine1, setAddressLine1] = useState(initial.addressLine1 ?? '')
  const [addressLine2, setAddressLine2] = useState(initial.addressLine2 ?? '')
  const [addressCity, setAddressCity] = useState(initial.addressCity ?? '')
  const [addressState, setAddressState] = useState(initial.addressState ?? '')
  const [addressPostalCode, setAddressPostalCode] = useState(initial.addressPostalCode ?? '')
  const [status, setStatus] = useState<'idle' | 'loading' | 'error'>('idle')

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    setStatus('loading')

    try {
      const res = await fetch('/api/users/me', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          firstName,
          lastName,
          email,
          addressLine1,
          // Omit rather than send '' — the API's minLength/optionality rules
          // treat absent and empty differently only for line2.
          ...(addressLine2 ? { addressLine2 } : {}),
          addressCity,
          addressState,
          addressPostalCode,
        }),
      })
      if (!res.ok) throw new Error('Failed')

      // Next onboarding step (K1). The consent page bounces to /continue on
      // its own when the user has already consented to everything current.
      router.push('/onboarding/consent')
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

        <h2 style={{ fontFamily: 'var(--font)', fontSize: 17, fontWeight: 700, margin: '12px 0 0', color: 'var(--ink)' }}>
          {s.address.heading}
        </h2>
        <p style={{ fontSize: 13, color: 'var(--muted)', margin: '0 0 4px' }}>{s.address.note}</p>

        <div className="field">
          <label htmlFor="profile-address-line1">{s.address.line1}</label>
          <input
            id="profile-address-line1"
            required
            autoComplete="address-line1"
            value={addressLine1}
            onChange={(e) => setAddressLine1(e.target.value)}
          />
        </div>
        <div className="field">
          <label htmlFor="profile-address-line2">{s.address.line2}</label>
          <input
            id="profile-address-line2"
            autoComplete="address-line2"
            value={addressLine2}
            onChange={(e) => setAddressLine2(e.target.value)}
          />
        </div>
        <div className="field-row">
          <div className="field">
            <label htmlFor="profile-address-city">{s.address.city}</label>
            <input
              id="profile-address-city"
              required
              autoComplete="address-level2"
              value={addressCity}
              onChange={(e) => setAddressCity(e.target.value)}
            />
          </div>
          <div className="field">
            <label htmlFor="profile-address-state">{s.address.state}</label>
            <select
              id="profile-address-state"
              required
              autoComplete="address-level1"
              value={addressState}
              onChange={(e) => setAddressState(e.target.value)}
            >
              <option value="" disabled>
                {s.address.statePh}
              </option>
              {US_STATES.map((st) => (
                <option key={st.code} value={st.code}>
                  {st.name}
                </option>
              ))}
            </select>
          </div>
        </div>
        <div className="field">
          <label htmlFor="profile-address-zip">{s.address.zip}</label>
          <input
            id="profile-address-zip"
            required
            inputMode="numeric"
            pattern="[0-9]{5}(-[0-9]{4})?"
            autoComplete="postal-code"
            value={addressPostalCode}
            onChange={(e) => setAddressPostalCode(e.target.value)}
          />
        </div>

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
