'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { useLanguage } from '@/components/LanguageProvider'

export interface RecipientWithDestinations {
  id: string
  firstName: string
  lastName: string
  relationship: string
  country: string
  status: string
  destinations: {
    id: string
    method: string
    currency: string
    details: { clabeLast4?: string }
    label: string | null
    status: string
  }[]
}

// Maps API failures to translated copy — API error strings are English-only
// and never shown raw.
function errorKeyFor(status: number): 'invalidClabe' | 'bankRejected' | 'providerDown' | 'generic' {
  if (status === 400) return 'invalidClabe'
  if (status === 422) return 'bankRejected'
  if (status === 502) return 'providerDown'
  return 'generic'
}

function AddRecipientForm({ onDone }: { onDone: () => void }) {
  const { t } = useLanguage()
  const s = t.recipients
  const [firstName, setFirstName] = useState('')
  const [lastName, setLastName] = useState('')
  const [relationship, setRelationship] = useState('')
  const [status, setStatus] = useState<'idle' | 'loading' | 'error'>('idle')

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    setStatus('loading')
    try {
      const res = await fetch('/api/recipients', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ firstName, lastName, relationship, country: 'MX' }),
      })
      if (!res.ok) throw new Error('failed')
      onDone()
    } catch {
      setStatus('error')
    }
  }

  return (
    <form className="wl-form" onSubmit={handleSubmit} style={{ marginTop: 16 }}>
      <div className="field-row">
        <div className="field">
          <label htmlFor="recipient-first-name">{s.firstName}</label>
          <input
            id="recipient-first-name"
            required
            value={firstName}
            onChange={(e) => setFirstName(e.target.value)}
          />
        </div>
        <div className="field">
          <label htmlFor="recipient-last-name">{s.lastName}</label>
          <input
            id="recipient-last-name"
            required
            value={lastName}
            onChange={(e) => setLastName(e.target.value)}
          />
        </div>
      </div>
      <p style={{ fontSize: 13, color: 'var(--muted)', margin: 0 }}>{s.lastNameNote}</p>
      <div className="field-row">
        <div className="field">
          <label htmlFor="recipient-relationship">{s.relationship}</label>
          <input
            id="recipient-relationship"
            required
            placeholder={s.relationshipPh}
            value={relationship}
            onChange={(e) => setRelationship(e.target.value)}
          />
        </div>
        <div className="field">
          <label htmlFor="recipient-country">{s.country}</label>
          <select id="recipient-country" value="MX" disabled>
            <option value="MX">{s.countryMx}</option>
          </select>
        </div>
      </div>
      <button className="btn btn--accent" type="submit" disabled={status === 'loading'}>
        {status === 'loading' ? s.saving : s.save}
      </button>
      {status === 'error' && (
        <p role="alert" style={{ color: 'var(--color-error)', fontSize: 13, margin: 0 }}>
          {s.errors.generic}
        </p>
      )}
    </form>
  )
}

function AddClabeForm({ recipientId, onDone }: { recipientId: string; onDone: () => void }) {
  const { t } = useLanguage()
  const s = t.recipients
  const [label, setLabel] = useState('')
  const [clabe, setClabe] = useState('')
  const [clabeConfirm, setClabeConfirm] = useState('')
  const [status, setStatus] = useState<'idle' | 'loading' | 'error'>('idle')
  const [errorText, setErrorText] = useState('')

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (clabe !== clabeConfirm) {
      setStatus('error')
      setErrorText(s.clabeMismatch)
      return
    }
    setStatus('loading')
    try {
      const res = await fetch(`/api/recipients/${recipientId}/destinations`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          method: 'bank_account',
          currency: 'MXN',
          details: { clabe },
          ...(label.trim() && { label: label.trim() }),
        }),
      })
      if (!res.ok) {
        setStatus('error')
        setErrorText(s.errors[errorKeyFor(res.status)])
        return
      }
      onDone()
    } catch {
      setStatus('error')
      setErrorText(s.errors.generic)
    }
  }

  return (
    <form className="wl-form" onSubmit={handleSubmit} style={{ marginTop: 16 }}>
      <div className="field">
        <label htmlFor={`label-${recipientId}`}>{s.label}</label>
        <input
          id={`label-${recipientId}`}
          placeholder={s.labelPh}
          value={label}
          onChange={(e) => setLabel(e.target.value)}
        />
      </div>
      <div className="field">
        <label htmlFor={`clabe-${recipientId}`}>{s.clabe}</label>
        <input
          id={`clabe-${recipientId}`}
          required
          inputMode="numeric"
          pattern="[0-9]{18}"
          minLength={18}
          maxLength={18}
          autoComplete="off"
          value={clabe}
          onChange={(e) => setClabe(e.target.value.replace(/\D/g, ''))}
        />
      </div>
      <div className="field">
        <label htmlFor={`clabe-confirm-${recipientId}`}>{s.clabeConfirm}</label>
        <input
          id={`clabe-confirm-${recipientId}`}
          required
          inputMode="numeric"
          pattern="[0-9]{18}"
          minLength={18}
          maxLength={18}
          autoComplete="off"
          value={clabeConfirm}
          onChange={(e) => setClabeConfirm(e.target.value.replace(/\D/g, ''))}
        />
      </div>
      <p style={{ fontSize: 13, color: 'var(--muted)', margin: 0 }}>{s.clabeNote}</p>
      <button className="btn btn--accent" type="submit" disabled={status === 'loading'}>
        {status === 'loading' ? s.saving : s.save}
      </button>
      {status === 'error' && (
        <p role="alert" style={{ color: 'var(--color-error)', fontSize: 13, margin: 0 }}>
          {errorText}
        </p>
      )}
    </form>
  )
}

// Archive needs a second click to confirm — no modal primitive exists in the
// app, and click-twice matches its inline-form conventions.
function ArchiveButton({ onArchive }: { onArchive: () => Promise<void> }) {
  const { t } = useLanguage()
  const s = t.recipients
  const [armed, setArmed] = useState(false)
  const [busy, setBusy] = useState(false)

  const handleClick = async () => {
    if (!armed) {
      setArmed(true)
      return
    }
    setBusy(true)
    await onArchive()
  }

  return (
    <button
      type="button"
      className="btn btn--ghost btn--sm"
      disabled={busy}
      onClick={handleClick}
      onBlur={() => setArmed(false)}
    >
      {armed ? s.confirmArchive : s.archive}
    </button>
  )
}

export default function RecipientsManager({
  initialRecipients,
}: {
  initialRecipients: RecipientWithDestinations[]
}) {
  const { t } = useLanguage()
  const s = t.recipients
  const router = useRouter()
  // which inline form is open: 'recipient' | recipient id | null
  const [openForm, setOpenForm] = useState<string | null>(null)

  const refresh = () => {
    setOpenForm(null)
    router.refresh()
  }

  const archiveRecipient = async (id: string) => {
    await fetch(`/api/recipients/${id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: 'archived' }),
    })
    router.refresh()
  }

  const archiveDestination = async (id: string) => {
    await fetch(`/api/destinations/${id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: 'archived' }),
    })
    router.refresh()
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      <div className="wl-card">
        <h1 style={{ fontFamily: 'var(--font)', fontSize: 24, fontWeight: 700, margin: '0 0 8px', color: 'var(--ink)' }}>
          {s.title}
        </h1>
        <p style={{ fontSize: 15, color: 'var(--muted)', margin: 0, lineHeight: 1.6 }}>{s.sub}</p>
        {initialRecipients.length === 0 && (
          <p style={{ fontSize: 15, color: 'var(--muted)', margin: '16px 0 0', lineHeight: 1.6 }}>
            {s.empty}
          </p>
        )}
        {openForm === 'recipient' ? (
          <>
            <AddRecipientForm onDone={refresh} />
            <button
              type="button"
              className="btn btn--ghost btn--sm"
              style={{ marginTop: 8 }}
              onClick={() => setOpenForm(null)}
            >
              {s.cancel}
            </button>
          </>
        ) : (
          <button
            type="button"
            className="btn btn--accent"
            style={{ marginTop: 16 }}
            onClick={() => setOpenForm('recipient')}
          >
            {s.addRecipient}
          </button>
        )}
      </div>

      {initialRecipients.map((recipient) => (
        <div key={recipient.id} className="wl-card">
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: 12 }}>
            <h2 style={{ fontFamily: 'var(--font)', fontSize: 18, fontWeight: 700, margin: 0, color: 'var(--ink)' }}>
              {recipient.firstName} {recipient.lastName}
              <span style={{ fontSize: 14, fontWeight: 400, color: 'var(--muted)' }}>
                {' '}
                · {recipient.relationship}
              </span>
            </h2>
            <ArchiveButton onArchive={() => archiveRecipient(recipient.id)} />
          </div>

          {recipient.destinations.length > 0 && (
            <ul style={{ listStyle: 'none', padding: 0, margin: '12px 0 0', display: 'flex', flexDirection: 'column', gap: 8 }}>
              {recipient.destinations.map((destination) => (
                <li
                  key={destination.id}
                  style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12, fontSize: 15, color: 'var(--ink)' }}
                >
                  <span>
                    {destination.label || s.bankAccount}{' '}
                    <span style={{ fontFamily: 'var(--mono)', color: 'var(--muted)' }}>
                      {s.accountEnding.replace('{last4}', destination.details.clabeLast4 ?? '')}
                    </span>
                  </span>
                  <ArchiveButton onArchive={() => archiveDestination(destination.id)} />
                </li>
              ))}
            </ul>
          )}

          {openForm === recipient.id ? (
            <>
              <AddClabeForm recipientId={recipient.id} onDone={refresh} />
              <button
                type="button"
                className="btn btn--ghost btn--sm"
                style={{ marginTop: 8 }}
                onClick={() => setOpenForm(null)}
              >
                {s.cancel}
              </button>
            </>
          ) : (
            <button
              type="button"
              className="btn btn--ghost btn--sm"
              style={{ marginTop: 12 }}
              onClick={() => setOpenForm(recipient.id)}
            >
              {s.addAccount}
            </button>
          )}
        </div>
      ))}
    </div>
  )
}
