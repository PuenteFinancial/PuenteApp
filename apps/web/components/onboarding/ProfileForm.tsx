'use client'

import { useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import type { Stripe, StripeAddressElementChangeEvent } from '@stripe/stripe-js'
import { AddressElement, Elements } from '@stripe/react-stripe-js'
import { US_STATES } from '@puente/shared'
import { useLanguage } from '@/components/LanguageProvider'
import { getStripe } from '@/lib/stripe'

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

/** The address fields the PATCH carries — one shape whether they came from
 *  the plain inputs or from Stripe's AddressElement. */
type AddressFields = {
  firstName: string
  lastName: string
  addressLine1: string
  addressLine2: string
  addressCity: string
  addressState: string
  addressPostalCode: string
}

// K6b (decision 7): when the API serves a publishable key, the name + address
// inputs are Stripe's AddressElement (autocomplete + normalization, the same
// vendor that verifies the address at first send), and our email input stays
// outside it. Without a key, or if Stripe fails to load, the plain inputs
// render unchanged — the PATCH body is identical either way.
export default function ProfileForm({
  initial = {},
  publishableKey = null,
}: {
  initial?: ProfileFormInitial
  /** From GET /v1/config/web; null = plain inputs. */
  publishableKey?: string | null
}) {
  const { t, lang } = useLanguage()
  const s = t.onboarding.profile
  const router = useRouter()

  const [email, setEmail] = useState(initial.email ?? '')
  const [fields, setFields] = useState<AddressFields>({
    firstName: initial.firstName ?? '',
    lastName: initial.lastName ?? '',
    addressLine1: initial.addressLine1 ?? '',
    addressLine2: initial.addressLine2 ?? '',
    addressCity: initial.addressCity ?? '',
    addressState: initial.addressState ?? '',
    addressPostalCode: initial.addressPostalCode ?? '',
  })
  const set = (key: keyof AddressFields) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) =>
    setFields((f) => ({ ...f, [key]: e.target.value }))

  // 'loading' while the js.stripe.com loader resolves; null = no key or the
  // load failed (plain inputs); a Stripe instance = the element renders.
  const [stripe, setStripe] = useState<Stripe | null | 'loading'>(publishableKey ? 'loading' : null)
  // The element validates itself; we only refuse to submit until it says
  // the address is complete.
  const [addressComplete, setAddressComplete] = useState(!publishableKey)
  const [status, setStatus] = useState<'idle' | 'loading' | 'incomplete' | 'error'>('idle')

  useEffect(() => {
    if (!publishableKey) return
    let cancelled = false
    getStripe(publishableKey)
      .then((instance) => {
        if (cancelled) return
        setStripe(instance)
        if (!instance) setAddressComplete(true) // plain inputs take over
      })
      .catch(() => {
        if (cancelled) return
        setStripe(null)
        setAddressComplete(true)
      })
    return () => {
      cancelled = true
    }
  }, [publishableKey])

  const onAddressChange = (event: StripeAddressElementChangeEvent) => {
    const v = event.value
    setFields({
      firstName: v.firstName ?? '',
      lastName: v.lastName ?? '',
      addressLine1: v.address.line1,
      addressLine2: v.address.line2 ?? '',
      addressCity: v.address.city,
      addressState: v.address.state,
      addressPostalCode: v.address.postal_code,
    })
    setAddressComplete(event.complete)
    if (status === 'incomplete' && event.complete) setStatus('idle')
  }

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!addressComplete) {
      setStatus('incomplete')
      return
    }
    setStatus('loading')

    try {
      const res = await fetch('/api/users/me', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          firstName: fields.firstName,
          lastName: fields.lastName,
          email,
          addressLine1: fields.addressLine1,
          // Omit rather than send '' — the API's minLength/optionality rules
          // treat absent and empty differently only for line2.
          ...(fields.addressLine2 ? { addressLine2: fields.addressLine2 } : {}),
          addressCity: fields.addressCity,
          addressState: fields.addressState,
          addressPostalCode: fields.addressPostalCode,
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

  const usingElement = stripe !== null

  return (
    <div className="wl-card">
      <h1 style={{ fontFamily: 'var(--font)', fontSize: 24, fontWeight: 700, margin: '0 0 8px', color: 'var(--ink)' }}>
        {s.title}
      </h1>
      <p style={{ fontSize: 15, color: 'var(--muted)', margin: '0 0 20px' }}>{s.sub}</p>

      <form className="wl-form" onSubmit={handleSubmit}>
        {!usingElement && (
          <div className="field-row">
            <div className="field">
              <label htmlFor="profile-first-name">{s.firstName}</label>
              <input
                id="profile-first-name"
                required
                autoComplete="given-name"
                value={fields.firstName}
                onChange={set('firstName')}
              />
            </div>
            <div className="field">
              <label htmlFor="profile-last-name">{s.lastName}</label>
              <input
                id="profile-last-name"
                required
                autoComplete="family-name"
                value={fields.lastName}
                onChange={set('lastName')}
              />
            </div>
          </div>
        )}
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

        {stripe === 'loading' && (
          <p role="status" style={{ fontSize: 13, color: 'var(--muted)', margin: 0 }}>
            {s.address.loading}
          </p>
        )}

        {usingElement && stripe !== 'loading' && (
          <Elements stripe={stripe} options={{ locale: lang }}>
            <AddressElement
              options={{
                mode: 'billing',
                allowedCountries: ['US'],
                // The element always renders a name; split matches our
                // first/last columns so the PATCH maps 1:1.
                display: { name: 'split' },
                autocomplete: { mode: 'automatic' },
                defaultValues: {
                  firstName: fields.firstName,
                  lastName: fields.lastName,
                  address: {
                    line1: fields.addressLine1,
                    line2: fields.addressLine2,
                    city: fields.addressCity,
                    state: fields.addressState,
                    postal_code: fields.addressPostalCode,
                    country: 'US',
                  },
                },
              }}
              onChange={onAddressChange}
            />
          </Elements>
        )}

        {!usingElement && (
          <>
            <div className="field">
              <label htmlFor="profile-address-line1">{s.address.line1}</label>
              <input
                id="profile-address-line1"
                required
                autoComplete="address-line1"
                value={fields.addressLine1}
                onChange={set('addressLine1')}
              />
            </div>
            <div className="field">
              <label htmlFor="profile-address-line2">{s.address.line2}</label>
              <input
                id="profile-address-line2"
                autoComplete="address-line2"
                value={fields.addressLine2}
                onChange={set('addressLine2')}
              />
            </div>
            <div className="field-row">
              <div className="field">
                <label htmlFor="profile-address-city">{s.address.city}</label>
                <input
                  id="profile-address-city"
                  required
                  autoComplete="address-level2"
                  value={fields.addressCity}
                  onChange={set('addressCity')}
                />
              </div>
              <div className="field">
                <label htmlFor="profile-address-state">{s.address.state}</label>
                <select
                  id="profile-address-state"
                  required
                  autoComplete="address-level1"
                  value={fields.addressState}
                  onChange={set('addressState')}
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
                value={fields.addressPostalCode}
                onChange={set('addressPostalCode')}
              />
            </div>
          </>
        )}

        <button
          className="btn btn--accent"
          type="submit"
          disabled={status === 'loading' || stripe === 'loading'}
          style={{ fontSize: 17, padding: '17px 28px' }}
        >
          {status === 'loading' ? s.saving : s.cta}
        </button>

        {status === 'incomplete' && (
          <p role="alert" style={{ color: 'var(--color-error)', fontFamily: 'var(--mono)', fontSize: 12, textAlign: 'center', margin: '4px 0 0' }}>
            {s.address.incomplete}
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
