'use client'

import { useEffect } from 'react'
import Link from 'next/link'
import posthog from 'posthog-js'
import { useLanguage } from '@/components/LanguageProvider'
import type { DisclosureContent } from '@/lib/disclosure'
import DisclosureBody from './DisclosureBody'

// The receipt for a COMPLETED transfer. The server page fetches the receipt and
// hands us both language renderings; we pick the sender's language and render the
// server-authored content VERBATIM via DisclosureBody. The chrome here (title,
// nav links) is the ONLY web-authored copy — the receipt BODY is counsel-tracked
// (PR7). Do NOT add Reg E receipt elements client-side; the server content owns
// them (the v2 body carries the date-available line, so the old chrome
// completed-on line is gone — it rendered the BROWSER's calendar day, which can
// contradict the document's CDMX day for a few hours around midnight).
export default function ReceiptView({
  content,
  transferId,
}: {
  content: DisclosureContent
  transferId: string
}) {
  const { t, lang } = useLanguage()
  const s = t.send.receipt
  const d = content[lang]

  useEffect(() => {
    posthog.capture('send_receipt_viewed', { transfer_id: transferId })
  }, [transferId])

  return (
    <div className="wl-card">
      <h1 style={{ fontFamily: 'var(--font)', fontSize: 24, fontWeight: 700, margin: '0 0 16px', color: 'var(--ink)' }}>
        {s.title}
      </h1>

      <DisclosureBody d={d} />

      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10, marginTop: 16 }}>
        <Link href="/dashboard/transfers" className="btn btn--ghost btn--sm" style={{ display: 'inline-block' }}>
          {s.viewHistory}
        </Link>
        <Link href="/dashboard" className="btn btn--ghost btn--sm" style={{ display: 'inline-block' }}>
          {t.send.track.done}
        </Link>
      </div>
    </div>
  )
}
