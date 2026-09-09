'use client'

import { useState } from 'react'
import { useLanguage } from '@/components/LanguageProvider'
import type { IdentityFormValues } from '@/lib/bridgeIdentity'
import IdentityFields from '@/components/send/bridge/IdentityFields'

// The Checkout rail's identity form (C3): DOB + tax ID, once, before any money
// moves. On this rail Bridge is the sole verifier, so this is the whole of
// identity — there is no Stripe verification in front of it and no Link.
//
// Dispatch-only: the values go straight out through onSubmit into the
// reducer's IDENTITY_SUBMIT event and live nowhere else. No fetches here, and
// `invalid` carries field NAMES so a wrong value is never echoed back through
// an error string.
export default function CheckoutIdentityForm({
  reason,
  invalid,
  busy,
  onSubmit,
}: {
  reason: 'first' | 'correction'
  /** Field names from invalidIdentityFields — never values. */
  invalid: string[]
  busy: boolean
  onSubmit: (values: IdentityFormValues) => void
}) {
  const { t } = useLanguage()
  const c = t.send.track.pay.checkout

  const [values, setValues] = useState<IdentityFormValues>({
    dobMonth: '',
    dobDay: '',
    dobYear: '',
    taxId: '',
    taxIdType: 'ssn',
  })

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault()
    onSubmit(values)
  }

  return (
    <form className="wl-form" onSubmit={handleSubmit} noValidate>
      <p style={{ fontSize: 14.5, fontWeight: 600, color: 'var(--ink)', margin: '0 0 4px' }}>
        {c.identityTitle}
      </p>
      <p
        role={reason === 'correction' ? 'alert' : undefined}
        style={{
          fontSize: 13,
          color: reason === 'correction' ? 'var(--color-error)' : 'var(--muted)',
          margin: '0 0 10px',
          lineHeight: 1.5,
        }}
      >
        {reason === 'correction' ? c.identityHintCorrection : c.identityHint}
      </p>

      {/* The privacy note is IdentityFields' own slot, not a second paragraph
          under it: the crypto rail's hardcoded sentence names Stripe, and
          printing that here alongside ours would tell a sender their SSN goes
          somewhere it does not. */}
      <IdentityFields
        values={values}
        privacyNote={c.identityPrivacyNote}
        onChange={(key, value) => setValues((v) => ({ ...v, [key]: value }))}
      />

      {invalid.length > 0 && (
        <p role="alert" style={{ color: 'var(--color-error)', fontSize: 13, margin: '0 0 8px' }}>
          {t.send.errors.validation_error}
        </p>
      )}

      <button type="submit" className="btn btn--accent btn--sm" disabled={busy}>
        {busy ? c.identitySubmitting : c.identitySubmit}
      </button>
    </form>
  )
}
