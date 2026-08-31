'use client'

import { useEffect, useState } from 'react'
import { useLanguage } from '@/components/LanguageProvider'
import { parseLimits } from '@/lib/cryptoPayStep'

// K5 expectation banner (flag-ON only — the server page decides): identity
// verification happens at payment, on this page. The limits pre-check is
// BEST-EFFORT by design: a first-time sender has no Link token yet (409),
// the surface may be dark (503), and the response shape is a preview-API
// unknown — every one of those renders the generic copy. Never blocks
// quoting, never shows an error.
export default function LimitsBanner() {
  const { t } = useLanguage()
  const b = t.send.limitsBanner
  const [maxUsd, setMaxUsd] = useState<number | null>(null)

  useEffect(() => {
    let alive = true
    void (async () => {
      try {
        const res = await fetch('/api/crypto/limits', { cache: 'no-store' })
        if (!res.ok) return
        const body: unknown = await res.json().catch(() => null)
        const parsed = parseLimits(body)
        if (alive && parsed) setMaxUsd(parsed.maxUsd)
      } catch {
        // Generic copy already covers this.
      }
    })()
    return () => {
      alive = false
    }
  }, [])

  return (
    <div
      style={{
        padding: '11px 13px',
        borderRadius: 'var(--r-sm)',
        background: 'var(--surface-2)',
        border: '1px solid var(--line-2)',
        marginBottom: 14,
      }}
    >
      <p style={{ fontSize: 13.5, fontWeight: 600, color: 'var(--ink)', margin: '0 0 2px' }}>
        {b.title}
      </p>
      <p style={{ fontSize: 13, color: 'var(--muted)', margin: 0, lineHeight: 1.5 }}>
        {b.body}
        {maxUsd !== null && <> {b.limitLine(`$${maxUsd}`)}</>}
      </p>
    </div>
  )
}
