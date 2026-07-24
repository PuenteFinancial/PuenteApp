'use client'

import { useRouter } from 'next/navigation'
import Link from 'next/link'
import { useLanguage } from '@/components/LanguageProvider'

// Shown when the transfer exists but we couldn't load it right now (a 500/503
// from the API, a network blip). Distinct from notFound(): a transient fault
// must not tell a sender with money in flight that their transfer doesn't
// exist. Retry re-runs the server component.
export default function TransferLoadError() {
  const { t } = useLanguage()
  const s = t.send.track
  const router = useRouter()

  return (
    <div className="wl-card">
      <h1 style={{ fontFamily: 'var(--font)', fontSize: 24, fontWeight: 700, margin: '0 0 8px', color: 'var(--ink)' }}>
        {s.title}
      </h1>
      <p role="alert" style={{ fontSize: 15, color: 'var(--muted)', margin: '0 0 16px', lineHeight: 1.6 }}>
        {s.loadError}
      </p>
      <button type="button" className="btn btn--accent btn--sm" onClick={() => router.refresh()}>
        {s.retry}
      </button>
      <div>
        <Link href="/dashboard" className="btn btn--ghost btn--sm" style={{ marginTop: 12 }}>
          {s.done}
        </Link>
      </div>
    </div>
  )
}
