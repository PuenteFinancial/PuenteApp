'use client'

import { useLanguage } from '@/components/LanguageProvider'

// First screen of the crypto pay step: the decision-7 expectation sentence
// (names Stripe/Link emails and USDC — de-emphasize, never deny) and the
// debit-forward methods note, ahead of any Link/KYC surface.
export default function PayIntro({ onContinue }: { onContinue: () => void }) {
  const { t } = useLanguage()
  const c = t.send.track.crypto.intro

  return (
    <div>
      <p style={{ fontSize: 14.5, fontWeight: 600, color: 'var(--ink)', margin: '0 0 4px' }}>
        {c.title}
      </p>
      <p style={{ fontSize: 13, color: 'var(--muted)', margin: '0 0 8px', lineHeight: 1.5 }}>
        {c.expectation}
      </p>
      <p style={{ fontSize: 13, color: 'var(--muted)', margin: '0 0 12px', lineHeight: 1.5 }}>
        {c.methodsNote}
      </p>
      <button type="button" className="btn btn--accent btn--sm" onClick={onContinue}>
        {c.continueCta}
      </button>
    </div>
  )
}
