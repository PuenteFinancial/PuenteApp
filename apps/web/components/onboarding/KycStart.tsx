'use client'

import { useState } from 'react'
import { useLanguage } from '@/components/LanguageProvider'

export default function KycStart({ initialError = false }: { initialError?: boolean }) {
  const { t } = useLanguage()
  const s = t.onboarding.kyc
  const [status, setStatus] = useState<'idle' | 'starting' | 'error'>(initialError ? 'error' : 'idle')
  const starting = status === 'starting'

  // Bridge ToS URLs are session-scoped and must be minted by our API —
  // a hand-built dashboard link produces an unusable signed_agreement_id
  const handleStart = async () => {
    setStatus('starting')
    try {
      const res = await fetch('/api/users/me/tos-link', { method: 'POST' })
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
      <p style={{ fontSize: 15, color: 'var(--muted)', margin: '0 0 16px', lineHeight: 1.6 }}>{s.body}</p>
      {/* GLBA: disclose the data hand-off to Bridge before the user continues */}
      <p style={{ fontSize: 13, color: 'var(--muted)', margin: '0 0 24px', lineHeight: 1.5 }}>
        {s.dataNotice}
      </p>

      <button
        className="btn btn--accent"
        type="button"
        onClick={handleStart}
        disabled={starting}
        style={{ width: '100%', fontSize: 17, padding: '17px 28px' }}
      >
        {starting ? s.starting : s.cta}
      </button>

      {status === 'error' && (
        <p role="alert" style={{ color: 'var(--color-error)', fontFamily: 'var(--mono)', fontSize: 12, textAlign: 'center', margin: '12px 0 0' }}>
          {s.error}
        </p>
      )}
    </div>
  )
}
