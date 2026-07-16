'use client'

import Link from 'next/link'
import { useLanguage } from '@/components/LanguageProvider'

// Static end-of-flow states: KYC pending review, and the verified dashboard stub
export default function StatusCard({ variant }: { variant: 'pending' | 'dashboard' }) {
  const { t } = useLanguage()

  if (variant === 'pending') {
    const s = t.onboarding.pending
    return (
      <div className="wl-card">
        <h1 style={{ fontFamily: 'var(--font)', fontSize: 24, fontWeight: 700, margin: '0 0 8px', color: 'var(--ink)' }}>
          {s.title}
        </h1>
        <p style={{ fontSize: 15, color: 'var(--muted)', margin: '0 0 8px', lineHeight: 1.6 }}>{s.body}</p>
        <p style={{ fontSize: 15, color: 'var(--muted)', margin: 0, lineHeight: 1.6 }}>{s.autoNote}</p>
      </div>
    )
  }

  const s = t.onboarding.dashboard
  return (
    <div className="wl-card">
      <h1 style={{ fontFamily: 'var(--font)', fontSize: 24, fontWeight: 700, margin: '0 0 8px', color: 'var(--ink)' }}>
        {s.title}
      </h1>
      <p style={{ fontSize: 15, color: 'var(--muted)', margin: '0 0 16px', lineHeight: 1.6 }}>{s.body}</p>
      <Link href="/dashboard/recipients" className="btn btn--accent" style={{ display: 'inline-block' }}>
        {s.recipientsCta}
      </Link>
    </div>
  )
}
