'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { useLanguage } from '@/components/LanguageProvider'
import QuoteScreen, { type SendRecipient, type CreatedTransfer } from './QuoteScreen'
import ReviewConfirm from './ReviewConfirm'

// Client-side step machine for the pre-transfer part of the send flow: quote →
// review+confirm. Once confirmed, the transfer exists and money is about to
// move, so it stops being a step in an in-memory machine and gets its own URL
// (/dashboard/send/:id) — reload-safe, linkable, and where the tracker lives.
export default function SendFlow({ recipients }: { recipients: SendRecipient[] }) {
  const { t } = useLanguage()
  const router = useRouter()
  const [transfer, setTransfer] = useState<CreatedTransfer | null>(null)
  const [confirmed, setConfirmed] = useState(false)

  if (confirmed) {
    // Transitional only — the replace() to the tracker is already in flight.
    // replace(), not push(): "back" must not return to a review screen for a
    // transfer that has already been confirmed.
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
    return (
      <ReviewConfirm
        transfer={transfer}
        onBack={() => setTransfer(null)}
        onConfirmed={() => {
          setConfirmed(true)
          router.replace(`/dashboard/send/${transfer.id}`)
        }}
      />
    )
  }

  return <QuoteScreen recipients={recipients} onCreated={setTransfer} />
}
