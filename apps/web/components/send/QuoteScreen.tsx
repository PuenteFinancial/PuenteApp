'use client'

import { useEffect, useMemo, useRef, useState } from 'react'
import Link from 'next/link'
import posthog from 'posthog-js'
import { useLanguage } from '@/components/LanguageProvider'
import { parseApiError, errorMessage } from '@/lib/apiError'
import { formatUsd, formatMxn, mmss, secondsUntil, isQuoteShape, type Quote } from '@/lib/sendFormat'

export interface SendDestination {
  id: string
  method: string
  currency: string
  status: string
  label: string | null
  details: { clabeLast4?: string }
}

export interface SendRecipient {
  id: string
  firstName: string
  lastName: string
  status: string
  destinations: SendDestination[]
}

export default function QuoteScreen({ recipients }: { recipients: SendRecipient[] }) {
  const { t } = useLanguage()
  const s = t.send

  // Only recipients with at least one active payout account can be quoted.
  const usable = useMemo(
    () =>
      recipients
        .filter((r) => r.status === 'active')
        .map((r) => ({ ...r, destinations: r.destinations.filter((d) => d.status === 'active') }))
        .filter((r) => r.destinations.length > 0),
    [recipients],
  )

  const [recipientId, setRecipientId] = useState(usable[0]?.id ?? '')
  const selectedRecipient = usable.find((r) => r.id === recipientId)
  const [destinationId, setDestinationId] = useState(usable[0]?.destinations[0]?.id ?? '')
  const [amount, setAmount] = useState('')
  const [status, setStatus] = useState<'idle' | 'loading' | 'error'>('idle')
  const [errorMsg, setErrorMsg] = useState('')
  const [quote, setQuote] = useState<Quote | null>(null)
  const [secondsLeft, setSecondsLeft] = useState(0)

  // Monotonic id for the latest committed action. Bumped on submit AND on any
  // who/where change, so a superseded in-flight response can't repaint.
  const requestKeyRef = useRef(0)

  // Countdown on the active quote. secondsLeft is seeded synchronously when the
  // quote is set (in handleSubmit), so the first paint already shows the real
  // time remaining — this effect only keeps it ticking and never flashes a
  // stale "expired".
  useEffect(() => {
    if (!quote) return
    const id = setInterval(() => setSecondsLeft(secondsUntil(quote.expiresAt, Date.now())), 1000)
    return () => clearInterval(id)
  }, [quote])

  const expired = quote !== null && secondsLeft <= 0

  // Any change to who/where invalidates a shown or in-flight quote: bump the
  // request key so an older in-flight response can't repaint, and drop the stale
  // quote so the panel never shows numbers for a no-longer-selected account.
  const invalidateQuote = () => {
    requestKeyRef.current++
    setQuote(null)
    setStatus('idle')
  }

  const onRecipientChange = (id: string) => {
    setRecipientId(id)
    const next = usable.find((r) => r.id === id)
    setDestinationId(next?.destinations[0]?.id ?? '')
    invalidateQuote()
  }

  const onDestinationChange = (id: string) => {
    setDestinationId(id)
    invalidateQuote()
  }

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    const dollars = Number(amount)
    if (!destinationId || !Number.isFinite(dollars) || dollars <= 0) {
      setStatus('error')
      setErrorMsg(s.errors.validation_error)
      return
    }
    const amountMinor = Math.round(dollars * 100)

    setStatus('loading')
    setErrorMsg('')
    const reqId = ++requestKeyRef.current
    posthog.capture('send_quote_requested', { amount_minor: amountMinor, currency: 'USD' })

    try {
      const res = await fetch('/api/quotes', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          payoutDestinationId: destinationId,
          totalAmount: { amountMinor, currency: 'USD' },
        }),
      })
      const body = await res.json().catch(() => ({}))
      if (reqId !== requestKeyRef.current) return // superseded by a newer action
      if (!res.ok) {
        setStatus('error')
        setErrorMsg(errorMessage(parseApiError(body)?.code, s.errors))
        return
      }
      if (!isQuoteShape(body)) {
        // 2xx but not a quote (contract break upstream) — don't trust it.
        setStatus('error')
        setErrorMsg(s.errors.generic)
        return
      }
      setQuote(body)
      setSecondsLeft(secondsUntil(body.expiresAt, Date.now()))
      setStatus('idle')
      posthog.capture('send_quote_received', {
        amount_minor: body.totalAmount.amountMinor,
        receive_amount_minor: body.receiveAmount.amountMinor,
        fx_rate: body.fxRate,
      })
    } catch {
      if (reqId !== requestKeyRef.current) return
      setStatus('error')
      setErrorMsg(s.errors.generic)
    }
  }

  if (usable.length === 0) {
    return (
      <div className="wl-card">
        <h1 style={{ fontFamily: 'var(--font)', fontSize: 24, fontWeight: 700, margin: '0 0 8px', color: 'var(--ink)' }}>
          {s.title}
        </h1>
        <p style={{ fontSize: 15, color: 'var(--muted)', margin: '0 0 16px', lineHeight: 1.6 }}>{s.noRecipients}</p>
        <Link href="/dashboard/recipients" className="btn btn--accent" style={{ display: 'inline-block' }}>
          {s.manageRecipients}
        </Link>
      </div>
    )
  }

  return (
    <div className="wl-card">
      <h1 style={{ fontFamily: 'var(--font)', fontSize: 24, fontWeight: 700, margin: '0 0 8px', color: 'var(--ink)' }}>
        {s.title}
      </h1>
      <p style={{ fontSize: 15, color: 'var(--muted)', margin: '0 0 16px', lineHeight: 1.6 }}>{s.sub}</p>

      <form className="wl-form" onSubmit={handleSubmit}>
        <div className="field">
          <label htmlFor="send-recipient">{s.recipient}</label>
          <select id="send-recipient" value={recipientId} onChange={(e) => onRecipientChange(e.target.value)}>
            {usable.map((r) => (
              <option key={r.id} value={r.id}>
                {r.firstName} {r.lastName}
              </option>
            ))}
          </select>
        </div>

        <div className="field">
          <label htmlFor="send-account">{s.account}</label>
          <select id="send-account" value={destinationId} onChange={(e) => onDestinationChange(e.target.value)}>
            {(selectedRecipient?.destinations ?? []).map((d) => (
              <option key={d.id} value={d.id}>
                {(d.label ? `${d.label} · ` : '') + `····${d.details.clabeLast4 ?? ''}`}
              </option>
            ))}
          </select>
        </div>

        <div className="field">
          <label htmlFor="send-amount">{s.amount}</label>
          <input
            id="send-amount"
            inputMode="decimal"
            autoComplete="off"
            placeholder={s.amountPh}
            value={amount}
            onChange={(e) => setAmount(e.target.value.replace(/[^0-9.]/g, ''))}
          />
        </div>

        <button className="btn btn--accent" type="submit" disabled={status === 'loading'}>
          {status === 'loading' ? s.quoting : s.getQuote}
        </button>

        {status === 'error' && (
          <p role="alert" style={{ color: 'var(--color-error)', fontSize: 13, margin: 0 }}>
            {errorMsg}
          </p>
        )}
      </form>

      {quote && (
        <div style={{ marginTop: 20, display: 'flex', flexDirection: 'column', gap: 10 }}>
          <div className="calc-amt">
            <span className="lab">{s.youPay}</span>
            <span style={{ fontFamily: 'var(--mono)', fontWeight: 700, fontSize: 18, color: 'var(--ink)' }}>
              {formatUsd(quote.totalAmount.amountMinor)}
            </span>
          </div>
          <div className="calc-amt calc-amt--rcv">
            <span className="lab">{s.theyReceive}</span>
            <span style={{ fontFamily: 'var(--mono)', fontWeight: 700, fontSize: 18, color: 'var(--ink)' }}>
              {formatMxn(quote.receiveAmount.amountMinor)}
            </span>
          </div>
          <div className="calc-foot">
            <span>{s.fee}</span>
            <b>{formatUsd(quote.feeAmount.amountMinor)}</b>
          </div>
          <div className="calc-foot">
            <span>{s.rate}</span>
            <b>{s.rateValue.replace('{rate}', Number(quote.fxRate).toFixed(2))}</b>
          </div>

          {expired ? (
            <p role="alert" style={{ color: 'var(--color-error)', fontFamily: 'var(--mono)', fontSize: 12.5, margin: '4px 2px 0' }}>
              {s.expiredNotice}
            </p>
          ) : (
            <p style={{ color: 'var(--muted)', fontFamily: 'var(--mono)', fontSize: 12.5, margin: '4px 2px 0' }}>
              {s.expiresIn.replace('{time}', mmss(secondsLeft))}
            </p>
          )}

          <button
            type="button"
            className="btn btn--ghost btn--sm"
            style={{ alignSelf: 'flex-start', marginTop: 4 }}
            onClick={invalidateQuote}
          >
            {s.newQuote}
          </button>
        </div>
      )}
    </div>
  )
}
