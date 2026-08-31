'use client'

import { useLanguage } from '@/components/LanguageProvider'

// The Persona/Bridge fallback branch (decision 2 — BEFORE payment). `waiting`
// renders the polling copy after the return leg; both states keep the CTA so
// a user who bailed mid-Persona always has a way back into the hosted flow.
export default function BridgeKycCard({
  waiting,
  busy,
  onContinue,
}: {
  waiting: boolean
  busy: boolean
  onContinue: () => void
}) {
  const { t } = useLanguage()
  const c = t.send.track.crypto.bridge

  return (
    <div>
      <p style={{ fontSize: 14.5, fontWeight: 600, color: 'var(--ink)', margin: '0 0 4px' }}>
        {waiting ? c.waitingTitle : c.title}
      </p>
      <p
        role="status"
        style={{ fontSize: 13, color: 'var(--muted)', margin: '0 0 12px', lineHeight: 1.5 }}
      >
        {waiting ? c.waitingBody : c.body}
      </p>
      <button type="button" className="btn btn--accent btn--sm" disabled={busy} onClick={onContinue}>
        {c.tosCta}
      </button>
    </div>
  )
}
