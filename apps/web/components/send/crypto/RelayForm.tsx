'use client'

import { useState } from 'react'
import { useLanguage } from '@/components/LanguageProvider'
import type { IdentityFormValues } from '@/lib/cryptoPayStep'
import IdentityFields from './IdentityFields'

// The two-field re-entry form (K6 decision 12): Stripe has verified the
// sender, but the values Bridge needs are not in hand — either the page was
// reloaded after verification (`reload`) or Bridge refused the create and
// one correction is offered (`correction`). Plainly labelled, dispatch-only.
export default function RelayForm({
  reason,
  invalid,
  onSubmit,
}: {
  reason: 'reload' | 'correction'
  invalid: boolean
  onSubmit: (values: IdentityFormValues) => void
}) {
  const { t } = useLanguage()
  const c = t.send.track.crypto.relay

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
        {c.formTitle}
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
        {reason === 'correction' ? c.formHintCorrection : c.formHintReload}
      </p>

      <IdentityFields values={values} onChange={(key, value) => setValues((v) => ({ ...v, [key]: value }))} />

      {invalid && (
        <p role="alert" style={{ color: 'var(--color-error)', fontSize: 13, margin: '0 0 8px' }}>
          {t.send.errors.validation_error}
        </p>
      )}

      <button type="submit" className="btn btn--accent btn--sm">
        {c.submitCta}
      </button>
    </form>
  )
}
