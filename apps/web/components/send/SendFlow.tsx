'use client'

import { useState } from 'react'
import { useLanguage } from '@/components/LanguageProvider'
import QuoteScreen, { type SendRecipient, type CreatedTransfer } from './QuoteScreen'
import ReviewConfirm from './ReviewConfirm'

// Client-side step machine for the send flow: quote → review+confirm → confirmed.
// PR3 adds the pay (mock simulate) + tracking step after confirm.
export default function SendFlow({ recipients }: { recipients: SendRecipient[] }) {
  const { t } = useLanguage()
  const [transfer, setTransfer] = useState<CreatedTransfer | null>(null)
  const [confirmed, setConfirmed] = useState(false)

  if (confirmed) {
    const s = t.send.review
    return (
      <div className="wl-card">
        <h1 style={{ fontFamily: 'var(--font)', fontSize: 24, fontWeight: 700, margin: '0 0 8px', color: 'var(--ink)' }}>
          {s.confirmedTitle}
        </h1>
        <p style={{ fontSize: 15, color: 'var(--muted)', margin: 0, lineHeight: 1.6 }}>{s.confirmedBody}</p>
      </div>
    )
  }

  if (transfer) {
    // Back = start over with a new quote. The already-created transfer is left
    // at PENDING_PAYMENT (pre-funding, pre-confirm): economically inert — no
    // ledger entry, no money moved — and swept by the reconcile-pending job.
    // PR3's per-transfer route makes this reload-safe and resolvable in-place.
    return (
      <ReviewConfirm
        transfer={transfer}
        onBack={() => setTransfer(null)}
        onConfirmed={() => setConfirmed(true)}
      />
    )
  }

  return <QuoteScreen recipients={recipients} onCreated={setTransfer} />
}
