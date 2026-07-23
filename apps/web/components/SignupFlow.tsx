'use client'

import { useState } from 'react'
import { useLanguage } from '@/components/LanguageProvider'
import { COUNTRIES } from '@/lib/countries'
import { translations } from '@/lib/translations'
import posthog from 'posthog-js'

// Canonical English values for the referral-source dropdown — stored/compared
// in English regardless of UI language, so "Other" detection and DB values
// stay consistent no matter which language the signup happened in.
const REFERRAL_SOURCE_VALUES = translations.en.wl.referralSourceOptions

type Status = 'idle' | 'loading' | 'success' | 'error'

const TOTAL = 2

export default function SignupFlow() {
  const { t, lang } = useLanguage()
  const s = t.wl

  const [step, setStep] = useState(1)
  const [name, setName] = useState('')
  const [phone, setPhone] = useState('')
  const [country, setCountry] = useState('')
  const [referralSource, setReferralSource] = useState('')
  const [referralSourceOther, setReferralSourceOther] = useState('')
  const [status, setStatus] = useState<Status>('idle')
  const [copied, setCopied] = useState(false)

  const refLink = 'puentefinancial.com'
  const waHref = 'https://wa.me/?text=' + encodeURIComponent(s.success.waText + ' https://' + refLink)

  const copyLink = () => {
    navigator.clipboard?.writeText('https://' + refLink).catch(() => {})
    setCopied(true)
    setTimeout(() => setCopied(false), 1600)
  }

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (step < TOTAL) {
      setStep(step + 1)
      return
    }

    setStatus('loading')
    const distinctId = posthog.get_distinct_id()
    const sessionId = posthog.get_session_id()

    try {
      const res = await fetch('/api/waitlist', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-POSTHOG-DISTINCT-ID': distinctId ?? '',
          'X-POSTHOG-SESSION-ID': sessionId ?? '',
        },
        body: JSON.stringify({
          first_name: name,
          phone,
          destination_country: country,
          referral_source: referralSource,
          ...(referralSource === 'Other' && { referral_source_other: referralSourceOther }),
          lang,
        }),
      })

      if (!res.ok) throw new Error('Failed')

      posthog.identify(phone, { first_name: name, language_preference: lang })
      posthog.capture('waitlist_form_submitted', {
        destination_country: country,
        referral_source: referralSource,
        language: lang,
      })

      setStatus('success')
    } catch {
      posthog.captureException(new Error('Waitlist form submission failed'))
      setStatus('error')
    }
  }

  if (status === 'success') {
    return (
      <div className="wl-card">
        <div className="wl-success">
          <div className="wl-check">
            <svg width="30" height="30" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
              <path d="M5 13l4 4L19 7" />
            </svg>
          </div>
          <h3>{s.success.title}</h3>
          <p>{s.success.body}</p>
          <div className="wl-ref">
            <span className="rl">{s.success.refLabel}</span>
            <div className="wl-reflink">
              <input readOnly value={refLink} onFocus={(e) => e.target.select()} />
              <button className="btn btn--ink btn--sm" onClick={copyLink}>
                {copied ? s.success.copied : s.success.copy}
              </button>
            </div>
            <div className="wl-share">
              <a className="btn btn--sm wl-wa" href={waHref} target="_blank" rel="noopener noreferrer">
                <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
                  <path d="M12 2a10 10 0 0 0-8.6 15l-1.3 4.7 4.8-1.3A10 10 0 1 0 12 2Zm5.6 14.2c-.2.6-1.2 1.2-1.7 1.2-.5.1-1 .1-1.7-.1-.4-.1-.9-.3-1.6-.6-2.8-1.2-4.6-4-4.7-4.2-.1-.2-1.1-1.5-1.1-2.8s.7-2 .9-2.2c.2-.3.5-.3.7-.3h.5c.2 0 .4 0 .6.5l.8 2c.1.2.1.3 0 .5l-.4.5c-.2.2-.3.3-.1.6.2.3.8 1.3 1.7 2.1 1.2 1 2.1 1.4 2.4 1.5.2.1.4.1.5-.1l.7-.9c.2-.2.4-.2.6-.1l1.9.9c.3.2.5.2.5.4.1.2.1.8-.2 1.5Z" />
                </svg>
                {s.success.wa}
              </a>
            </div>
          </div>
        </div>
      </div>
    )
  }

  const stepInfo = s.steps[step - 1]

  return (
    <div className="wl-card">
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 20 }}>
        <span style={{ fontFamily: 'var(--mono)', fontSize: 12, color: 'var(--muted)', letterSpacing: '0.05em' }}>
          {step} / {TOTAL}
        </span>
        <div style={{ display: 'flex', gap: 6 }}>
          {Array.from({ length: TOTAL }).map((_, i) => (
            <span
              key={i}
              style={{
                width: 8,
                height: 8,
                borderRadius: '50%',
                background: i + 1 <= step ? 'var(--accent)' : 'var(--line)',
                transition: 'background 0.2s',
              }}
            />
          ))}
        </div>
      </div>

      <p style={{ fontFamily: 'var(--font)', fontSize: 18, fontWeight: 700, margin: '0 0 20px', color: 'var(--ink)' }}>
        {stepInfo.h}
      </p>

      <form className="wl-form" onSubmit={handleSubmit}>
        {step === 1 && (
          <>
            <div className="field">
              <label>{s.f.name}</label>
              <input
                required
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder={s.ph.name}
              />
            </div>
            <div className="field">
              <label>{s.f.phone}</label>
              <input
                required
                type="tel"
                value={phone}
                onChange={(e) => setPhone(e.target.value)}
                placeholder={s.ph.phone}
              />
            </div>
          </>
        )}

        {step === 2 && (
          <>
            <div className="field">
              <label>{s.f.country}</label>
              <select required value={country} onChange={(e) => setCountry(e.target.value)}>
                <option value="" disabled>{s.select}</option>
                {COUNTRIES.map((c) => (
                  <option key={c.name.en} value={c.name.en}>
                    {lang === 'es' ? c.name.es : c.name.en}
                  </option>
                ))}
              </select>
            </div>
            <div className="field">
              <label>{s.f.referralSource}</label>
              <select
                required
                value={referralSource}
                onChange={(e) => {
                  setReferralSource(e.target.value)
                  if (e.target.value !== 'Other') setReferralSourceOther('')
                }}
              >
                <option value="" disabled>{s.select}</option>
                {s.referralSourceOptions.map((o, i) => (
                  <option key={o} value={REFERRAL_SOURCE_VALUES[i]}>{o}</option>
                ))}
              </select>
            </div>
            {referralSource === 'Other' && (
              <div className="field">
                <label>{s.f.referralSourceOther}</label>
                <input
                  required
                  value={referralSourceOther}
                  onChange={(e) => setReferralSourceOther(e.target.value)}
                  placeholder={s.ph.referralSourceOther}
                />
              </div>
            )}
          </>
        )}

        <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
          {step > 1 && (
            <button
              type="button"
              className="btn btn--ghost btn--sm"
              onClick={() => setStep(step - 1)}
            >
              {s.back}
            </button>
          )}
          <button
            className="btn btn--accent"
            type="submit"
            disabled={status === 'loading'}
            style={{ flex: 1, fontSize: 17, padding: '17px 28px' }}
          >
            {step < TOTAL ? s.next : (status === 'loading' ? '…' : s.submit)}
          </button>
        </div>

        {status === 'error' && (
          <p style={{ color: 'var(--color-error)', fontFamily: 'var(--mono)', fontSize: 12, textAlign: 'center', margin: '4px 0 0' }}>
            Something went wrong. Please try again.
          </p>
        )}
      </form>
    </div>
  )
}
