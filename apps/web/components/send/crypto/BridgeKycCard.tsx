'use client'

import { useLanguage } from '@/components/LanguageProvider'

export type BridgeKycVariant =
  /** ToS-first gate (K6 decision 1): the click-through before Link auth. */
  | 'tos'
  /** Bounded poll after the relay (and the rejection-detail fetch). */
  | 'waiting'
  /** Past the poll bound or on manual review: come back later. */
  | 'wait'
  /** Bridge rejected on something a document can cure: the hosted retry. */
  | 'persona'
  /** Bridge already holds this identity (decision 9): support only. */
  | 'duplicate'

// The Bridge leg of the pay step. One card, five moments; each promises only
// what the page actually does (the polling variants update in place, the
// wait variant keeps the draft, nothing claims a timeframe or a charge).
export default function BridgeKycCard({
  variant,
  busy,
  onContinue,
}: {
  variant: BridgeKycVariant
  busy: boolean
  onContinue?: () => void
}) {
  const { t } = useLanguage()
  const c = t.send.track.crypto.bridge

  const copy = {
    tos: { title: c.title, body: c.body, cta: c.tosCta },
    waiting: { title: c.waitingTitle, body: c.waitingBody, cta: null },
    wait: { title: c.waitTitle, body: c.waitBody, cta: c.recheckCta },
    persona: { title: c.personaTitle, body: c.personaBody, cta: c.personaCta },
    duplicate: { title: c.duplicateTitle, body: c.duplicateBody, cta: null },
  }[variant]

  return (
    <div>
      <p style={{ fontSize: 14.5, fontWeight: 600, color: 'var(--ink)', margin: '0 0 4px' }}>
        {copy.title}
      </p>
      <p
        role={variant === 'waiting' || variant === 'wait' ? 'status' : undefined}
        style={{ fontSize: 13, color: 'var(--muted)', margin: '0 0 12px', lineHeight: 1.5 }}
      >
        {copy.body}
      </p>
      {copy.cta && onContinue && (
        <button type="button" className="btn btn--accent btn--sm" disabled={busy} onClick={onContinue}>
          {copy.cta}
        </button>
      )}
    </div>
  )
}
