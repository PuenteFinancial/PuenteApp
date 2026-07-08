'use client'

import { useState } from 'react'
import { useLanguage } from '@/components/LanguageProvider'

const SUPPORT_EMAIL = 'joshua@puentefinancial.com'

// KYC came back rejected. Copy is strictly about identity verification —
// it must never read as a credit or account denial (no adverse-action
// implication). Reasons arrive from Bridge in English and render verbatim.
export default function RejectedCard({
  reasons,
  retriesRemaining,
}: {
  reasons: string[]
  retriesRemaining: number
}) {
  const { t } = useLanguage()
  const s = t.onboarding.rejected
  const [status, setStatus] = useState<'idle' | 'starting' | 'error'>('idle')
  const starting = status === 'starting'
  const canRetry = retriesRemaining > 0

  const handleRetry = async () => {
    setStatus('starting')
    try {
      const res = await fetch('/api/users/me/kyc-link/retry', { method: 'POST' })
      if (!res.ok) throw new Error('Failed')
      const { url } = (await res.json()) as { url: string }
      window.location.href = url
    } catch {
      setStatus('error')
    }
  }

  return (
    <div className="wl-card">
      <h1 style={{ fontFamily: 'var(--font)', fontSize: 24, fontWeight: 700, margin: '0 0 8px', color: 'var(--ink)' }}>
        {s.title}
      </h1>
      <p style={{ fontSize: 15, color: 'var(--muted)', margin: '0 0 16px', lineHeight: 1.6 }}>
        {canRetry ? s.body : s.exhaustedBody}
      </p>

      {canRetry && reasons.length > 0 && (
        <div style={{ margin: '0 0 24px' }}>
          <p style={{ fontSize: 13, fontWeight: 600, color: 'var(--ink)', margin: '0 0 4px' }}>
            {s.reasonLabel}
          </p>
          <ul style={{ fontSize: 13, color: 'var(--muted)', margin: 0, paddingLeft: 20, lineHeight: 1.6 }}>
            {reasons.map((reason) => (
              <li key={reason}>{reason}</li>
            ))}
          </ul>
        </div>
      )}

      {canRetry && (
        <button
          className="btn btn--accent"
          type="button"
          onClick={handleRetry}
          disabled={starting}
          style={{ width: '100%', fontSize: 17, padding: '17px 28px' }}
        >
          {starting ? s.retrying : s.retryCta}
        </button>
      )}

      <a
        className="btn btn--ghost btn--sm"
        href={`mailto:${SUPPORT_EMAIL}`}
        style={{ display: 'block', textAlign: 'center', marginTop: canRetry ? 12 : 0 }}
      >
        {s.supportCta}
      </a>

      {status === 'error' && (
        <p role="alert" style={{ color: 'var(--color-error)', fontFamily: 'var(--mono)', fontSize: 12, textAlign: 'center', margin: '12px 0 0' }}>
          {s.retryError}
        </p>
      )}
    </div>
  )
}
