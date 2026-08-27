'use client'

import { useEffect, useState } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import posthog from 'posthog-js'
import { REQUIRED_CONSENTS } from '@puente/shared'
import { useLanguage } from '@/components/LanguageProvider'

// Provider disclosure links (K-lane decision 5): Stripe/Bridge terms are
// disclosures here, not our checkboxes — assent to THEIR terms happens on
// their own surfaces at first send. URLs verified live 2026-08-27; the K7
// counsel pass reconfirms them.
const STRIPE_LEGAL_URL = 'https://stripe.com/legal/consumer'
const BRIDGE_LEGAL_URL = 'https://www.bridge.xyz/legal'

const checkboxRowStyle: React.CSSProperties = {
  display: 'flex',
  alignItems: 'flex-start',
  gap: 12,
  padding: '14px 16px',
  border: '1px solid var(--line)',
  borderRadius: 12,
  cursor: 'pointer',
}

export default function ConsentForm() {
  const { t, lang } = useLanguage()
  const s = t.onboarding.consent
  const router = useRouter()

  const [esignChecked, setEsignChecked] = useState(false)
  const [policiesChecked, setPoliciesChecked] = useState(false)
  const [status, setStatus] = useState<'idle' | 'loading' | 'error' | 'stale'>('idle')

  // First event of the K-lane onboarding funnel (decision 1's instrumentation
  // starts where the flow starts, not at the pay step).
  useEffect(() => {
    posthog.capture('consent_page_viewed')
  }, [])

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!esignChecked || !policiesChecked) return
    setStatus('loading')

    try {
      const res = await fetch('/api/users/me/consents', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          // The exact pairs this bundle rendered links for. A stale bundle
          // posts outdated versions and the API refuses — see `stale` below.
          consents: REQUIRED_CONSENTS.map(({ type, version }) => ({ type, version })),
          locale: lang,
        }),
      })
      if (!res.ok) {
        setStatus(res.status === 400 ? 'stale' : 'error')
        return
      }

      posthog.capture('consents_accepted', { locale: lang })
      router.push('/continue')
    } catch {
      setStatus('error')
    }
  }

  const linkStyle: React.CSSProperties = { color: 'var(--accent)', textDecoration: 'underline' }

  return (
    <div className="wl-card">
      <h1 style={{ fontFamily: 'var(--font)', fontSize: 24, fontWeight: 700, margin: '0 0 8px', color: 'var(--ink)' }}>
        {s.title}
      </h1>
      <p style={{ fontSize: 15, color: 'var(--muted)', margin: '0 0 20px' }}>{s.sub}</p>

      <form className="wl-form" onSubmit={handleSubmit}>
        <label htmlFor="consent-esign" style={checkboxRowStyle}>
          <input
            id="consent-esign"
            type="checkbox"
            required
            checked={esignChecked}
            onChange={(e) => setEsignChecked(e.target.checked)}
            style={{ marginTop: 3 }}
          />
          <span style={{ fontSize: 14, color: 'var(--ink)', lineHeight: 1.5 }}>
            {s.esign.pre}
            <Link href="/esign" target="_blank" style={linkStyle}>
              {s.esign.link}
            </Link>
            {s.esign.post}
          </span>
        </label>

        <label htmlFor="consent-policies" style={checkboxRowStyle}>
          <input
            id="consent-policies"
            type="checkbox"
            required
            checked={policiesChecked}
            onChange={(e) => setPoliciesChecked(e.target.checked)}
            style={{ marginTop: 3 }}
          />
          <span style={{ fontSize: 14, color: 'var(--ink)', lineHeight: 1.5 }}>
            {s.policies.pre}
            <Link href="/terms" target="_blank" style={linkStyle}>
              {s.policies.termsLink}
            </Link>
            {s.policies.and}
            <Link href="/privacy" target="_blank" style={linkStyle}>
              {s.policies.privacyLink}
            </Link>
            {s.policies.post}
          </span>
        </label>

        <p style={{ fontSize: 12.5, color: 'var(--muted)', lineHeight: 1.5, margin: '4px 0 0' }}>
          {s.providers.intro}{' '}
          <a href={STRIPE_LEGAL_URL} target="_blank" rel="noopener noreferrer" style={linkStyle}>
            {s.providers.stripeLink}
          </a>
          {' · '}
          <a href={BRIDGE_LEGAL_URL} target="_blank" rel="noopener noreferrer" style={linkStyle}>
            {s.providers.bridgeLink}
          </a>
        </p>

        <button
          className="btn btn--accent"
          type="submit"
          disabled={status === 'loading' || !esignChecked || !policiesChecked}
          style={{ fontSize: 17, padding: '17px 28px' }}
        >
          {status === 'loading' ? s.saving : s.cta}
        </button>

        {(status === 'error' || status === 'stale') && (
          <p role="alert" style={{ color: 'var(--color-error)', fontFamily: 'var(--mono)', fontSize: 12, textAlign: 'center', margin: '4px 0 0' }}>
            {status === 'stale' ? s.stale : s.error}
          </p>
        )}
      </form>
    </div>
  )
}
