'use client'

// funding-ops-automation slice 2: the ad-hoc treasury top-up — "I sent 100
// into the wallet; the ledger should know." Renders only when the overview
// reports actionsEnabled (see OpsOverviewView). Amount-first: type dollars,
// confirm, done. The optional reference dedupes against the break-glass CLI
// and future automated bookings on the same deposit (ledger key
// float_topup:<ref>); left blank the API derives a one-off ref from the
// Idempotency-Key, so a double-tap is one booking, and two deliberate blank
// submissions are two.
//
// Ceremony mirrors CancellationActions: two-step confirm restating the parsed
// amount, Phase machine, browser-minted Idempotency-Key held across retries,
// router.refresh() on close.

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { useLanguage } from '@/components/LanguageProvider'
import { useIdempotencyKey } from '@/lib/idempotency'
import { formatUsd } from '@/lib/sendFormat'
import { parseUsdToMinor } from '@/lib/money'
import {
  resolveErrorKind,
  firstDetailIssue,
  isOpsFloatTopUpSuccessShape,
  type ResolveErrorKind,
} from '@/lib/opsOverview'

type Phase =
  | { kind: 'idle' }
  | { kind: 'confirm' }
  | { kind: 'busy' }
  | { kind: 'success'; text: string }
  | { kind: 'error'; error: ResolveErrorKind; detail: string | null }

export default function FloatTopUpCard() {
  const router = useRouter()
  const { t } = useLanguage()
  const s = t.ops
  const keyHolder = useIdempotencyKey()

  const [amount, setAmount] = useState('')
  const [reference, setReference] = useState('')
  const [amountInvalid, setAmountInvalid] = useState(false)
  const [phase, setPhase] = useState<Phase>({ kind: 'idle' })

  const parsedMinor = parseUsdToMinor(amount)

  const toConfirm = () => {
    if (parsedMinor == null) {
      setAmountInvalid(true)
      return
    }
    setAmountInvalid(false)
    setPhase({ kind: 'confirm' })
  }

  const closeAndRefresh = () => {
    setAmount('')
    setReference('')
    setPhase({ kind: 'idle' })
    router.refresh()
  }

  const submit = async () => {
    if (parsedMinor == null || phase.kind === 'busy') return
    setPhase({ kind: 'busy' })
    try {
      const ref = reference.trim()
      const res = await fetch('/api/ops/treasury/float-topup', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          // Held across retries of THIS attempt; cleared only on success. With
          // a blank reference this key IS the booking's ledger identity.
          'Idempotency-Key': keyHolder.take(),
        },
        body: JSON.stringify({
          amountMinor: parsedMinor,
          currency: 'USD',
          ...(ref.length > 0 && { externalRef: ref }),
        }),
      })
      const body: unknown = await res.json().catch(() => null)
      if (res.ok && isOpsFloatTopUpSuccessShape(body)) {
        keyHolder.clear()
        setPhase({ kind: 'success', text: s.topUp.booked(formatUsd(body.floatBalanceMinor)) })
        return
      }
      setPhase({
        kind: 'error',
        error: res.ok ? 'generic' : resolveErrorKind(res.status, body),
        detail: firstDetailIssue(body),
      })
    } catch {
      setPhase({ kind: 'error', error: 'generic', detail: null })
    }
  }

  if (phase.kind === 'success') {
    return (
      <div style={cardStyle()}>
        <p style={{ fontSize: 13, color: 'var(--hero)', fontWeight: 600, margin: '0 0 8px' }}>
          {phase.text}
        </p>
        <button type="button" onClick={closeAndRefresh} style={buttonStyle('primary')}>
          {s.actions.close}
        </button>
      </div>
    )
  }

  const confirming = phase.kind === 'confirm' || phase.kind === 'busy' || phase.kind === 'error'

  return (
    <div style={cardStyle()}>
      <div style={{ fontSize: 13, fontWeight: 700, marginBottom: 6 }}>{s.topUp.title}</div>

      {!confirming ? (
        <>
          <label style={{ display: 'block', fontSize: 12, marginBottom: 6 }}>
            {s.topUp.amountLabel}
            <input
              type="text"
              inputMode="decimal"
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
              placeholder="100.00"
              style={inputStyle(amountInvalid)}
            />
          </label>
          {amountInvalid && (
            <p style={{ fontSize: 12, color: 'var(--color-error)', margin: '0 0 4px' }}>
              {s.topUp.amountInvalid}
            </p>
          )}
          <label style={{ display: 'block', fontSize: 12, marginBottom: 4 }}>
            {s.topUp.refLabel}
            <input
              type="text"
              value={reference}
              onChange={(e) => setReference(e.target.value)}
              style={inputStyle(false)}
            />
          </label>
          <p style={{ fontSize: 12, color: 'var(--muted)', margin: '0 0 8px' }}>{s.topUp.refHint}</p>
          <button type="button" onClick={toConfirm} style={buttonStyle('secondary')}>
            {s.topUp.title}
          </button>
        </>
      ) : (
        <>
          <div style={{ fontSize: 13, marginBottom: 6 }}>
            {s.topUp.amountLabel}:{' '}
            <span style={{ fontFamily: 'var(--mono)' }}>
              {parsedMinor != null ? formatUsd(parsedMinor) : '—'}
            </span>
            {reference.trim().length > 0 && (
              <span style={{ fontFamily: 'var(--mono)', color: 'var(--muted)' }}>
                {' '}
                · {reference.trim()}
              </span>
            )}
          </div>
          <p style={{ fontSize: 12, color: 'var(--muted)', margin: '0 0 8px' }}>
            {s.topUp.prefundNote}
          </p>

          {phase.kind === 'error' && (
            <p style={{ fontSize: 12, color: 'var(--muted)', margin: '0 0 8px' }}>
              {s.actions.errors[phase.error]}
              {phase.detail != null && (
                <span style={{ fontFamily: 'var(--mono)' }}> {phase.detail}</span>
              )}
            </p>
          )}

          <div style={{ display: 'flex', gap: 8 }}>
            <button
              type="button"
              onClick={submit}
              disabled={phase.kind === 'busy'}
              style={buttonStyle('primary', phase.kind === 'busy')}
            >
              {phase.kind === 'busy' ? s.actions.working : s.topUp.confirm}
            </button>
            <button
              type="button"
              onClick={() => setPhase({ kind: 'idle' })}
              disabled={phase.kind === 'busy'}
              style={buttonStyle('secondary', phase.kind === 'busy')}
            >
              {s.actions.cancel}
            </button>
          </div>
        </>
      )}
    </div>
  )
}

function cardStyle(): React.CSSProperties {
  return {
    background: 'var(--surface-2)',
    border: '1px solid var(--line-2)',
    borderRadius: 'var(--r-sm)',
    padding: '12px 14px',
    marginTop: 8,
  }
}

function inputStyle(invalid: boolean): React.CSSProperties {
  return {
    display: 'block',
    width: '100%',
    marginTop: 4,
    padding: '6px 8px',
    fontFamily: 'var(--mono)',
    fontSize: 13,
    border: `1px solid ${invalid ? 'var(--color-error)' : 'var(--line-2)'}`,
    borderRadius: 'var(--r-sm)',
    background: 'var(--surface)',
    color: 'inherit',
  }
}

function buttonStyle(variant: 'primary' | 'secondary', disabled = false): React.CSSProperties {
  return {
    fontSize: 13,
    fontWeight: 600,
    padding: '6px 14px',
    borderRadius: 'var(--r-sm)',
    cursor: disabled ? 'not-allowed' : 'pointer',
    opacity: disabled ? 0.6 : 1,
    border: variant === 'primary' ? '1px solid var(--hero)' : '1px solid var(--line-2)',
    background: variant === 'primary' ? 'var(--hero)' : 'transparent',
    color: variant === 'primary' ? 'var(--surface)' : 'inherit',
  }
}
