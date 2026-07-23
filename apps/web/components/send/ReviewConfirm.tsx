'use client'

import { useCallback, useEffect, useState } from 'react'
import posthog from 'posthog-js'
import { useLanguage } from '@/components/LanguageProvider'
import { parseApiError, errorMessage } from '@/lib/apiError'
import { useIdempotencyKey } from '@/lib/idempotency'
import type { CreatedTransfer } from './QuoteScreen'

// The server-authored Reg E disclosure rendering (one object per language). We
// render these strings VERBATIM — the API is the single source of truth for the
// disclosure copy; the web never re-derives it.
interface RenderedDisclosure {
  title: string
  amountLines: string[]
  fxRateLine: string
  cancellationRights: string
  errorResolutionRights: string
  wrongAccountWarning: string
  contact: string
}
type DisclosureContent = { en: RenderedDisclosure; es: RenderedDisclosure }

export default function ReviewConfirm({
  transfer,
  onBack,
  onConfirmed,
}: {
  transfer: CreatedTransfer
  onBack: () => void
  onConfirmed: () => void
}) {
  const { t, lang } = useLanguage()
  const s = t.send.review

  const [content, setContent] = useState<DisclosureContent | null>(null)
  const [loading, setLoading] = useState(true)
  const [loadFailed, setLoadFailed] = useState(false)
  const [accepted, setAccepted] = useState(false)
  const [confirming, setConfirming] = useState(false)
  const [confirmError, setConfirmError] = useState('')

  // One confirm per mounted transfer, so a plain mint-once holder is correct:
  // retries reuse the key, and the mount lifetime is exactly one transfer.
  const confirmKey = useIdempotencyKey()

  // Load the server-authored disclosure. Retryable (the Retry button re-invokes
  // it) so a transient fetch failure is never a dead-end. Stores BOTH renderings
  // and picks the locale in render, so a language change re-renders without a
  // refetch. (Post-unmount setState is a safe no-op in React 18 — no guard needed.)
  const loadDisclosure = useCallback(async () => {
    setLoading(true)
    setLoadFailed(false)
    try {
      const res = await fetch(`/api/transfers/${transfer.id}/disclosure`)
      const body = await res.json().catch(() => ({}))
      const c = body?.content
      if (!res.ok || !c?.en || !c?.es) {
        setLoadFailed(true)
        setLoading(false)
        return
      }
      setContent(c as DisclosureContent)
      setLoading(false)
      posthog.capture('send_disclosure_viewed', { transfer_id: transfer.id })
    } catch {
      setLoadFailed(true)
      setLoading(false)
    }
  }, [transfer.id])

  useEffect(() => {
    loadDisclosure()
  }, [loadDisclosure])

  const handleConfirm = async () => {
    if (!accepted || confirming) return
    setConfirming(true)
    setConfirmError('')
    try {
      const res = await fetch(`/api/transfers/${transfer.id}/confirm`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'idempotency-key': confirmKey.take() },
        body: JSON.stringify({ disclosureId: transfer.disclosureId, accepted: true }),
      })
      const body = await res.json().catch(() => ({}))
      if (!res.ok) {
        setConfirming(false)
        setConfirmError(errorMessage(parseApiError(body)?.code, t.send.errors))
        return
      }
      confirmKey.clear()
      posthog.capture('send_disclosure_accepted', { transfer_id: transfer.id })
      onConfirmed()
    } catch {
      setConfirming(false)
      setConfirmError(t.send.errors.generic)
    }
  }

  const d = content?.[lang] ?? null

  return (
    <div className="wl-card">
      <h1 style={{ fontFamily: 'var(--font)', fontSize: 24, fontWeight: 700, margin: '0 0 8px', color: 'var(--ink)' }}>
        {s.title}
      </h1>
      <p style={{ fontSize: 15, color: 'var(--muted)', margin: '0 0 16px', lineHeight: 1.6 }}>{s.sub}</p>

      {loading && !d && (
        <p style={{ fontSize: 14, color: 'var(--muted)', margin: 0 }}>{s.loading}</p>
      )}

      {loadFailed && (
        <div style={{ marginBottom: 8 }}>
          <p role="alert" style={{ color: 'var(--color-error)', fontSize: 14, margin: '0 0 10px' }}>
            {s.loadError}
          </p>
          <button type="button" className="btn btn--accent btn--sm" onClick={loadDisclosure}>
            {s.retry}
          </button>
        </div>
      )}

      {d && (
        <div>
          {/* Reg E prepayment disclosure — rendered from server-authored content */}
          <h2 style={{ fontFamily: 'var(--font)', fontSize: 17, fontWeight: 700, margin: '0 0 10px', color: 'var(--ink)' }}>
            {d.title}
          </h2>

          <ul
            style={{
              listStyle: 'none',
              margin: '0 0 12px',
              padding: '13px 15px',
              borderRadius: 'var(--r-sm)',
              background: 'var(--surface-2)',
              border: '1px solid var(--line-2)',
              display: 'flex',
              flexDirection: 'column',
              gap: 6,
            }}
          >
            {d.amountLines.map((line, i) => (
              <li key={i} style={{ fontFamily: 'var(--mono)', fontSize: 13, color: 'var(--ink)' }}>
                {line}
              </li>
            ))}
            <li style={{ fontFamily: 'var(--mono)', fontSize: 13, color: 'var(--ink)', marginTop: 4 }}>
              {d.fxRateLine}
            </li>
          </ul>

          {[d.cancellationRights, d.errorResolutionRights, d.wrongAccountWarning].map((para, i) => (
            <p key={i} style={{ fontSize: 13.5, color: 'var(--muted)', lineHeight: 1.55, margin: '0 0 10px' }}>
              {para}
            </p>
          ))}
          <p style={{ fontSize: 12.5, color: 'var(--muted)', margin: '0 0 4px' }}>{d.contact}</p>

          <label
            htmlFor="accept-disclosure"
            style={{ display: 'flex', gap: 10, alignItems: 'flex-start', margin: '16px 0 4px', fontSize: 14, color: 'var(--ink)', cursor: 'pointer' }}
          >
            <input
              id="accept-disclosure"
              type="checkbox"
              checked={accepted}
              onChange={(e) => setAccepted(e.target.checked)}
              style={{ marginTop: 3, width: 16, height: 16, flex: 'none', accentColor: 'var(--accent-2)' }}
            />
            <span>{s.accept}</span>
          </label>

          <button
            type="button"
            className="btn btn--accent"
            style={{ width: '100%', marginTop: 8, justifyContent: 'center' }}
            disabled={!accepted || confirming}
            onClick={handleConfirm}
          >
            {confirming ? s.confirming : s.confirm}
          </button>

          {confirmError && (
            <p role="alert" style={{ color: 'var(--color-error)', fontSize: 13, margin: '8px 0 0' }}>
              {confirmError}
            </p>
          )}
        </div>
      )}

      {/* Always available — never trap the user, even if the disclosure fails to
          load or is still loading. */}
      <button
        type="button"
        className="btn btn--ghost btn--sm"
        style={{ marginTop: 12 }}
        disabled={confirming}
        onClick={onBack}
      >
        {s.back}
      </button>
    </div>
  )
}
