'use client'

import { useLanguage } from '@/components/LanguageProvider'
import type { IdentityFormValues } from '@/lib/bridgeIdentity'

// The DOB + tax ID inputs. Shared by the crypto rail's full KYC form (first
// pass) and its two-field re-entry form (reload edge / Bridge correction, K6
// decision 12), and by the Checkout rail's identity form (C3) — which is why
// this moved out of crypto/ and reads its types from lib/bridgeIdentity.
// These values ONLY ever reach the reducer's KYC_SUBMIT / RELAY_FORM_SUBMIT
// events; the PII-guard test in lib/cryptoPayStep.test.ts pins which two
// effects may carry them. Dispatch-only: zero fetches here.
export default function IdentityFields({
  values,
  privacyNote,
  onChange,
}: {
  values: IdentityFormValues
  /**
   * Where these two values go, in this rail's words. REQUIRED, and a prop
   * rather than a constant, because the answer differs by rail and getting it
   * wrong is a false statement about someone's SSN: the crypto rail sends them
   * to Stripe AND Bridge, the Checkout rail only to Bridge. This component
   * used to hardcode the crypto sentence, which the Checkout form then
   * double-printed with a contradicting one (caught in compliance review,
   * 2026-09-09). No default — every caller states its own truth.
   */
  privacyNote: string
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
        {privacyNote}
      </p>
    </>
  )
}
