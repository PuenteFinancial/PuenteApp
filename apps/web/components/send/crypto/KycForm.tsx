'use client'

import { useState } from 'react'
import { US_STATES } from '@puente/shared'
import { useLanguage } from '@/components/LanguageProvider'
import {
  addressEdited,
  type CryptoPrefill,
  type KycFormMode,
  type KycFormValues,
} from '@/lib/cryptoPayStep'

// The K5 identity form — OUR UI, prefilled from the profile. SSN and DOB are
// rendered here but their values ONLY ever reach the reducer's KYC_SUBMIT
// event, whose sdk_submit_kyc effect hands them to the Stripe SDK; the
// PII-guard test in lib/cryptoPayStep.test.ts pins that no API-bound payload
// can carry them. Dispatch-only: zero fetches in this component.
export default function KycForm({
  mode,
  prefill,
  invalid,
  busy,
  onSubmit,
}: {
  mode: KycFormMode
  prefill: CryptoPrefill | null
  invalid: boolean
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
    ssn: '',
  }))

  const set = (key: keyof KycFormValues) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) =>
    setValues((v) => ({ ...v, [key]: e.target.value }))

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

      {mode === 'l1' && (
        <>
          <fieldset style={{ border: 0, padding: 0, margin: 0 }}>
            <legend
              style={{ fontSize: 13, fontWeight: 600, color: 'var(--ink)', padding: 0, marginBottom: 4 }}
            >
              {c.dobLegend}
            </legend>
            <div style={{ display: 'flex', gap: 10 }}>
              <div className="field" style={{ flex: 1 }}>
                <label htmlFor="kyc-dob-m">{c.dobMonth}</label>
                <input id="kyc-dob-m" value={values.dobMonth} onChange={set('dobMonth')} inputMode="numeric" placeholder="MM" autoComplete="bday-month" />
              </div>
              <div className="field" style={{ flex: 1 }}>
                <label htmlFor="kyc-dob-d">{c.dobDay}</label>
                <input id="kyc-dob-d" value={values.dobDay} onChange={set('dobDay')} inputMode="numeric" placeholder="DD" autoComplete="bday-day" />
              </div>
              <div className="field" style={{ flex: 1.4 }}>
                <label htmlFor="kyc-dob-y">{c.dobYear}</label>
                <input id="kyc-dob-y" value={values.dobYear} onChange={set('dobYear')} inputMode="numeric" placeholder="YYYY" autoComplete="bday-year" />
              </div>
            </div>
          </fieldset>
          <div className="field">
            <label htmlFor="kyc-ssn">{c.ssn}</label>
            {/* SSN: SDK-only destination; never autofilled from the browser,
                never logged, never in any payload to our own API. */}
            <input id="kyc-ssn" value={values.ssn} onChange={set('ssn')} inputMode="numeric" autoComplete="off" />
          </div>
          <p style={{ fontSize: 12.5, color: 'var(--muted)', margin: '0 0 10px', lineHeight: 1.5 }}>
            {c.ssnPrivacyNote}
          </p>
        </>
      )}

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
