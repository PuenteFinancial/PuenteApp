'use client'

import { useState } from 'react'
import { useLanguage } from '@/components/LanguageProvider'
import { COUNTRIES } from '@/lib/countries'
import posthog from 'posthog-js'

type Status = 'idle' | 'loading' | 'success' | 'error'

export default function WaitlistForm() {
  const { t, lang } = useLanguage()
  const s = t.wl

  const [name, setName] = useState('')
  const [phone, setPhone] = useState('')
  const [email, setEmail] = useState('')
  const [country, setCountry] = useState('')
  const [amount, setAmount] = useState('')
  const [provider, setProvider] = useState('')
  const [knowsScore, setKnowsScore] = useState('')
  const [scoreRange, setScoreRange] = useState('')
  const [status, setStatus] = useState<Status>('idle')
  const [copied, setCopied] = useState(false)

  const slug = (name.trim().split(/\s+/)[0] || 'amigo').toLowerCase().replace(/[^a-z0-9]/g, '') || 'amigo'
  const refLink = 'puente.com/r/' + slug
  const waHref = 'https://wa.me/?text=' + encodeURIComponent(s.success.waText + ' https://' + refLink)

  const copyLink = () => {
    navigator.clipboard?.writeText('https://' + refLink).catch(() => {})
    setCopied(true)
    setTimeout(() => setCopied(false), 1600)
  }

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
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
          email,
          monthly_send_amount: amount,
          destination_country: country,
          remittance_provider: provider,
          knows_credit_score: knowsScore || null,
          credit_score_range: scoreRange || null,
          lang,
        }),
      })

      if (!res.ok) throw new Error('Failed')

      posthog.identify(phone, { first_name: name, email, language_preference: lang })
      posthog.capture('waitlist_form_submitted', {
        destination_country: country,
        monthly_send_amount: amount,
        remittance_provider: provider,
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

  return (
    <div className="wl-card">
      <form className="wl-form" onSubmit={handleSubmit}>
        <div className="field">
          <label>{s.f.name}</label>
          <input
            required
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder={s.ph.name}
            disabled={status === 'loading'}
          />
        </div>
        <div className="field-row">
          <div className="field">
            <label>{s.f.phone}</label>
            <input
              required
              type="tel"
              value={phone}
              onChange={(e) => setPhone(e.target.value)}
              placeholder={s.ph.phone}
              disabled={status === 'loading'}
            />
          </div>
          <div className="field">
            <label>{s.f.email}</label>
            <input
              required
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder={s.ph.email}
              disabled={status === 'loading'}
            />
          </div>
        </div>
        <div className="field-row">
          <div className="field">
            <label>{s.f.country}</label>
            <select
              required
              value={country}
              onChange={(e) => setCountry(e.target.value)}
              disabled={status === 'loading'}
            >
              <option value="" disabled>{s.select}</option>
              {COUNTRIES.map((c) => (
                <option key={c.name.en} value={c.name.en}>
                  {lang === 'es' ? c.name.es : c.name.en}
                </option>
              ))}
            </select>
          </div>
          <div className="field">
            <label>{s.f.amount}</label>
            <select
              required
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
              disabled={status === 'loading'}
            >
              <option value="" disabled>{s.select}</option>
              {s.amounts.map((o) => <option key={o} value={o}>{o}</option>)}
            </select>
          </div>
        </div>
        <div className="field">
          <label>{s.f.provider}</label>
          <select
            required
            value={provider}
            onChange={(e) => setProvider(e.target.value)}
            disabled={status === 'loading'}
          >
            <option value="" disabled>{s.select}</option>
            {s.providers.map((o) => <option key={o} value={o}>{o}</option>)}
          </select>
        </div>
        <div className="field">
          <label>{s.f.knowsScore}</label>
          <select
            value={knowsScore}
            onChange={(e) => { setKnowsScore(e.target.value); if (e.target.value !== 'yes') setScoreRange('') }}
            disabled={status === 'loading'}
          >
            <option value="" disabled>{s.select}</option>
            <option value="yes">{lang === 'es' ? 'Sí' : 'Yes'}</option>
            <option value="no">No</option>
          </select>
        </div>
        {knowsScore === 'yes' && (
          <div className="field">
            <label>{s.f.scoreRange}</label>
            <select
              value={scoreRange}
              onChange={(e) => setScoreRange(e.target.value)}
              disabled={status === 'loading'}
            >
              <option value="" disabled>{s.select}</option>
              {s.scoreOptions.map((o) => <option key={o} value={o}>{o}</option>)}
            </select>
          </div>
        )}
        <button className="btn btn--sol" type="submit" disabled={status === 'loading'}>
          {status === 'loading' ? '…' : s.submit}
        </button>
        {status === 'error' && (
          <p style={{ color: 'var(--coral)', fontFamily: 'var(--mono)', fontSize: 12, textAlign: 'center', margin: '4px 0 0' }}>
            Something went wrong. Please try again.
          </p>
        )}
      </form>
    </div>
  )
}
