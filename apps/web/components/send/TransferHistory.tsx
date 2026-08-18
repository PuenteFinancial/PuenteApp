'use client'

import { useState } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { useLanguage } from '@/components/LanguageProvider'
import { parseApiError, errorMessage } from '@/lib/apiError'
import { formatUsd, formatMxn, formatDate } from '@/lib/sendFormat'
import {
  badgeTone,
  isTransferShape,
  outcomeFor,
  type BadgeTone,
  type TrackedTransfer,
} from '@/lib/transferState'

// Badge accent per tone. The tone is the coarse at-a-glance signal; the label
// (reused from the tracker) carries the exact status.
const TONE_COLOR: Record<BadgeTone, string> = {
  success: 'var(--hero)',
  progress: 'var(--accent-2)',
  neutral: 'var(--muted)',
  error: 'var(--color-error)',
}

// The money-moved transaction list. The first page is fetched server-side and
// passed as `initial`; "Load more" pages in the rest via the same-origin proxy.
// `loadFailed` distinguishes a real first-page fetch failure from an empty
// history, so a 5xx never masquerades as "you haven't sent anything".
export default function TransferHistory({
  initial,
  initialCursor,
  loadFailed = false,
}: {
  initial: TrackedTransfer[]
  initialCursor: string | null
  loadFailed?: boolean
}) {
  const { t, lang } = useLanguage()
  const router = useRouter()
  const s = t.send.history
  const [items, setItems] = useState(initial)
  const [cursor, setCursor] = useState(initialCursor)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')

  const loadMore = async () => {
    if (loading || !cursor) return
    setLoading(true)
    setError('')
    try {
      const res = await fetch(`/api/transfers?scope=history&cursor=${encodeURIComponent(cursor)}`, {
        cache: 'no-store',
      })
      // An expired session 401s from here on — route to re-auth like the tracker
      // does, rather than showing a generic error the sender can't act on.
      if (res.status === 401) {
        router.replace('/continue')
        return
      }
      const body = await res.json().catch(() => ({}))
      if (!res.ok) {
        setError(errorMessage(parseApiError(body)?.code, t.send.errors))
        return
      }
      // A 2xx whose body isn't a { data: array } is a fault (e.g. a gateway 200 +
      // HTML past the proxy), not the end of the list — surface it and KEEP the
      // cursor so "Load more" stays and can be retried, rather than silently
      // nulling the cursor and masquerading as the last page.
      if (!Array.isArray(body?.data)) {
        setError(errorMessage(parseApiError(body)?.code, t.send.errors))
        return
      }
      // Trust only well-shaped rows — a gateway 200 + HTML must not render as garbage.
      const rows: TrackedTransfer[] = body.data.filter(isTransferShape)
      setItems((prev) => [...prev, ...rows])
      setCursor(typeof body.nextCursor === 'string' ? body.nextCursor : null)
    } catch {
      setError(t.send.errors.generic)
    } finally {
      setLoading(false)
    }
  }


  const heading = (
    <h1 style={{ fontFamily: 'var(--font)', fontSize: 24, fontWeight: 700, margin: '0 0 16px', color: 'var(--ink)' }}>
      {s.title}
    </h1>
  )

  // A genuine first-page failure — never render it as an empty history. Retry is
  // a re-navigation, which re-runs the server fetch.
  if (loadFailed) {
    return (
      <div className="wl-card">
        {heading}
        <p role="alert" style={{ color: 'var(--color-error)', fontSize: 14, margin: '0 0 12px' }}>
          {s.loadError}
        </p>
        <Link href="/dashboard/transfers" className="btn btn--accent btn--sm" style={{ display: 'inline-block' }}>
          {s.retry}
        </Link>
        </div>
    )
  }

  if (items.length === 0) {
    return (
      <div className="wl-card">
        {heading}
        <p style={{ fontSize: 15, color: 'var(--muted)', margin: '0 0 16px', lineHeight: 1.6 }}>{s.empty}</p>
        <Link href="/dashboard/send" className="btn btn--accent btn--sm" style={{ display: 'inline-block' }}>
          {t.send.cta}
        </Link>
        </div>
    )
  }

  return (
    <div className="wl-card">
      {heading}

      <ul style={{ listStyle: 'none', margin: 0, padding: 0, display: 'flex', flexDirection: 'column', gap: 8 }}>
        {items.map((tr) => {
          const tone = badgeTone(tr.state)
          const outcome = outcomeFor(tr.state)
          const label = outcome
            ? t.send.track.outcomes[outcome].title
            : (t.send.track.steps[tr.state as keyof typeof t.send.track.steps] ?? tr.state)
          return (
            <li key={tr.id}>
              <Link
                href={`/dashboard/send/${tr.id}`}
                style={{
                  display: 'block',
                  textDecoration: 'none',
                  padding: '12px 14px',
                  borderRadius: 'var(--r-sm)',
                  background: 'var(--surface-2)',
                  border: '1px solid var(--line-2)',
                }}
              >
                <div
                  style={{
                    display: 'flex',
                    justifyContent: 'space-between',
                    alignItems: 'center',
                    gap: 10,
                    marginBottom: 8,
                  }}
                >
                  <span
                    style={{
                      fontSize: 12,
                      fontWeight: 600,
                      color: TONE_COLOR[tone],
                      border: `1px solid ${TONE_COLOR[tone]}`,
                      borderRadius: 999,
                      padding: '2px 9px',
                      whiteSpace: 'nowrap',
                    }}
                  >
                    {label}
                  </span>
                  <span style={{ fontSize: 12.5, color: 'var(--muted)' }}>{formatDate(tr.createdAt, lang)}</span>
                </div>
                <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 13.5, color: 'var(--ink)' }}>
                  <span style={{ color: 'var(--muted)' }}>{t.send.track.youSend}</span>
                  <b style={{ fontFamily: 'var(--mono)' }}>{formatUsd(tr.totalAmount.amountMinor)}</b>
                </div>
                <div
                  style={{
                    display: 'flex',
                    justifyContent: 'space-between',
                    fontSize: 13.5,
                    color: 'var(--ink)',
                    marginTop: 2,
                  }}
                >
                  <span style={{ color: 'var(--muted)' }}>{t.send.track.theyReceive}</span>
                  <b style={{ fontFamily: 'var(--mono)' }}>{formatMxn(tr.receiveAmount.amountMinor)}</b>
                </div>
              </Link>
            </li>
          )
        })}
      </ul>

      {cursor && (
        <button
          type="button"
          className="btn btn--ghost btn--sm"
          style={{ marginTop: 14 }}
          disabled={loading}
          onClick={loadMore}
        >
          {loading ? s.loading : s.loadMore}
        </button>
      )}

      {error && (
        <p role="alert" style={{ color: 'var(--color-error)', fontSize: 13, margin: '10px 0 0' }}>
          {error}
        </p>
      )}

    </div>
  )
}
