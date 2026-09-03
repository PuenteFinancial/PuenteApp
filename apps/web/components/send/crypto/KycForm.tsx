'use client'

import { useState } from 'react'
import { US_STATES } from '@puente/shared'
import { useLanguage } from '@/components/LanguageProvider'
import {
  addressEdited,
  type CryptoPrefill,
  type IdentityFormValues,
  type KycFormMode,
  type KycFormValues,
} from '@/lib/cryptoPayStep'
import IdentityFields from './IdentityFields'

// The K5 identity form — OUR UI, prefilled from the profile. The tax ID and
// DOB are rendered here but their values ONLY ever reach the reducer's
// KYC_SUBMIT event, whose sdk_submit_kyc effect hands them to the Stripe SDK
// and whose ctx holds them for the one relay to Bridge (K6); the PII-guard
// test in lib/cryptoPayStep.test.ts pins that no other API-bound payload can
// carry them. Dispatch-only: zero fetches in this component.
export default function KycForm({
  mode,
  prefill,
  invalid,
  notice,
  busy,
  onSubmit,
}: {
  mode: KycFormMode
  prefill: CryptoPrefill | null
  invalid: boolean
  /** Stripe rejected the first attempt; this is the one correction. */
  notice: 'rejected' | null
  busy: boolean
  onSubmit: (values: KycFormValues, edited: boolean) => void
}) {
  const { t } = useLanguage()
  const c = t.send.track.crypto.kyc

  const [values, setValues] = useState<KycFormValues>(() => ({
    firstName: prefill?.firstName ?? '',
    lastName: prefill?.lastName ?? '',
    addressLine1: prefill?.addressLine1 ?? '',
    addressLine2: prefill?.addressLine2 ?? '',
    city: prefill?.addressCity ?? '',
    state: prefill?.addressState ?? '',
    postalCode: prefill?.addressPostalCode ?? '',
    dobMonth: '',
    dobDay: '',
    dobYear: '',
    taxId: '',
    taxIdType: 'ssn',
  }))

  const set = (key: keyof KycFormValues) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) =>
    setValues((v) => ({ ...v, [key]: e.target.value }))
  const setIdentity = (key: keyof IdentityFormValues, value: string) =>
    setValues((v) => ({ ...v, [key]: value }))

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault()
    onSubmit(values, prefill ? addressEdited(prefill, values) : false)
  }

  return (
    <form className="wl-form" onSubmit={handleSubmit} noValidate>
      <p style={{ fontSize: 14.5, fontWeight: 600, color: 'var(--ink)', margin: '0 0 4px' }}>
        {mode === 'l0' ? c.formTitleStepUp : c.formTitle}
      </p>
      <p style={{ fontSize: 13, color: 'var(--muted)', margin: '0 0 10px', lineHeight: 1.5 }}>
        {c.sub}
      </p>
      {notice === 'rejected' && (
        <p role="alert" style={{ color: 'var(--color-error)', fontSize: 13, margin: '0 0 10px', lineHeight: 1.5 }}>
          {c.rejectedOnce}
        </p>
      )}

      <div className="field">
        <label htmlFor="kyc-first">{c.firstName}</label>
        <input id="kyc-first" value={values.firstName} onChange={set('firstName')} autoComplete="given-name" />
      </div>
      <div className="field">
        <label htmlFor="kyc-last">{c.lastName}</label>
        <input id="kyc-last" value={values.lastName} onChange={set('lastName')} autoComplete="family-name" />
      </div>
      <div className="field">
        <label htmlFor="kyc-line1">{c.addressLine1}</label>
        <input id="kyc-line1" value={values.addressLine1} onChange={set('addressLine1')} autoComplete="address-line1" />
      </div>
      <div className="field">
        <label htmlFor="kyc-line2">{c.addressLine2}</label>
        <input id="kyc-line2" value={values.addressLine2} onChange={set('addressLine2')} autoComplete="address-line2" />
      </div>
      <div className="field">
        <label htmlFor="kyc-city">{c.city}</label>
        <input id="kyc-city" value={values.city} onChange={set('city')} autoComplete="address-level2" />
      </div>
      <div style={{ display: 'flex', gap: 10 }}>
        <div className="field" style={{ flex: 1 }}>
          <label htmlFor="kyc-state">{c.state}</label>
          <select id="kyc-state" value={values.state} onChange={set('state')} autoComplete="address-level1">
            <option value="" />
            {US_STATES.map((state) => (
              <option key={state.code} value={state.code}>
                {state.code}
              </option>
            ))}
          </select>
        </div>
        <div className="field" style={{ flex: 1 }}>
          <label htmlFor="kyc-zip">{c.postalCode}</label>
          <input id="kyc-zip" value={values.postalCode} onChange={set('postalCode')} inputMode="numeric" autoComplete="postal-code" />
        </div>
      </div>

      {mode === 'l1' && <IdentityFields values={values} onChange={setIdentity} />}

      {invalid && (
        <p role="alert" style={{ color: 'var(--color-error)', fontSize: 13, margin: '0 0 8px' }}>
          {t.send.errors.validation_error}
        </p>
      )}

      <button type="submit" className="btn btn--accent btn--sm" disabled={busy}>
        {busy ? c.submitting : c.submitCta}
      </button>
    </form>
  )
}
