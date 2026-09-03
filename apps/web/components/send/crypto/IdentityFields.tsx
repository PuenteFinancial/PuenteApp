'use client'

import { useLanguage } from '@/components/LanguageProvider'
import type { IdentityFormValues } from '@/lib/cryptoPayStep'

// The DOB + tax ID inputs, shared by the full KYC form (first pass) and the
// two-field re-entry form (reload edge / Bridge correction, K6 decision 12).
// These values ONLY ever reach the reducer's KYC_SUBMIT / RELAY_FORM_SUBMIT
// events; the PII-guard test in lib/cryptoPayStep.test.ts pins which two
// effects may carry them. Dispatch-only: zero fetches here.
export default function IdentityFields({
  values,
  onChange,
}: {
  values: IdentityFormValues
  onChange: (key: keyof IdentityFormValues, value: string) => void
}) {
  const { t } = useLanguage()
  const c = t.send.track.crypto.kyc

  const set =
    (key: keyof IdentityFormValues) =>
    (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) =>
      onChange(key, e.target.value)

  return (
    <>
      <fieldset style={{ border: 0, padding: 0, margin: 0 }}>
        <legend style={{ fontSize: 13, fontWeight: 600, color: 'var(--ink)', padding: 0, marginBottom: 4 }}>
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
        <label htmlFor="kyc-taxid-type">{c.taxIdLabel}</label>
        <select id="kyc-taxid-type" value={values.taxIdType} onChange={set('taxIdType')}>
          <option value="ssn">{c.taxIdType.ssn}</option>
          <option value="itin">{c.taxIdType.itin}</option>
        </select>
      </div>
      <div className="field">
        <label htmlFor="kyc-taxid">
          {values.taxIdType === 'itin' ? c.taxIdType.itin : c.taxIdType.ssn}
        </label>
        {/* Tax ID: never autofilled from the browser, never logged, never in
            any payload to our own API except the one relay. */}
        <input id="kyc-taxid" value={values.taxId} onChange={set('taxId')} inputMode="numeric" autoComplete="off" />
      </div>
      <p style={{ fontSize: 12.5, color: 'var(--muted)', margin: '0 0 10px', lineHeight: 1.5 }}>
        {c.ssnPrivacyNote}
      </p>
    </>
  )
}
