'use client'

// O-B: release one payout hold from the detail page — the runbook's SQL as a
// button. Renders only when detailActions() offers 'holdRelease' (write gate
// live, row FUNDED, hold is one of the four human-actioned reasons).
//
// Ceremony: inline two-step confirm (TransferActions pattern) with the
// consequence stated, and a REQUIRED note — what the operator verified — that
// becomes the ops_actions row. The button stays disabled until the note meets
// the API's own bound, so a 400 is never the first feedback. The reason is
// taken from the row the operator is looking at; the API's compare-and-swap
// refuses if it changed underneath them (409 conflict → refresh).

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { useLanguage } from '@/components/LanguageProvider'
import { useIdempotencyKey } from '@/lib/idempotency'
import { resolveErrorKind, firstDetailIssue, type ResolveErrorKind } from '@/lib/opsOverview'
import {
  isOpsHoldReleaseSuccessShape,
  opsNoteValid,
  OPS_NOTE_MAX,
  type ReleasableHoldReason,
} from '@/lib/opsTransferDetail'
import { buttonStyle, inputStyle } from '@/components/ops/opsStyles'

type Phase =
  | { kind: 'idle' }
  | { kind: 'busy' }
  | { kind: 'success'; enqueued: boolean }
  | { kind: 'error'; error: ResolveErrorKind; detail: string | null }

export default function HoldReleaseAction({
  transferId,
  reason,
}: {
  transferId: string
  reason: ReleasableHoldReason
}) {
  const router = useRouter()
  const { t } = useLanguage()
  const a = t.ops.detail.actions
  const errs = t.ops.actions.errors

  const [open, setOpen] = useState(false)
  const [note, setNote] = useState('')
  const [phase, setPhase] = useState<Phase>({ kind: 'idle' })
  const keyHolder = useIdempotencyKey()

  const noteOk = opsNoteValid(note)

  const closeAndRefresh = () => {
    setOpen(false)
    router.refresh()
  }

  const submit = async () => {
    if (phase.kind === 'busy' || !noteOk) return
    setPhase({ kind: 'busy' })
    try {
      const res = await fetch('/api/ops/transfers/hold-release', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          // Held across retries of THIS attempt; cleared only on success.
          'Idempotency-Key': keyHolder.take(),
        },
        body: JSON.stringify({ transferId, reason, note: note.trim() }),
      })
      const body: unknown = await res.json().catch(() => null)
      if (res.ok && isOpsHoldReleaseSuccessShape(body)) {
        keyHolder.clear()
        setPhase({ kind: 'success', enqueued: body.enqueued })
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

  if (!open) {
    return (
      <div style={{ marginTop: 10 }}>
        <button
          type="button"
          onClick={() => {
            setOpen(true)
            setPhase({ kind: 'idle' })
            setNote('')
          }}
          style={buttonStyle('primary')}
        >
          {a.releaseHold}
        </button>
      </div>
    )
  }

  return (
    <div
      style={{
        marginTop: 10,
        border: '1px solid var(--line-2)',
        borderRadius: 'var(--r-sm)',
        padding: '10px 12px',
        background: 'var(--surface)',
      }}
    >
      <div style={{ fontSize: 13, fontWeight: 700, marginBottom: 6 }}>
        {a.confirmReleaseHold} · <span style={{ fontFamily: 'var(--mono)' }}>{reason}</span>
      </div>

      {phase.kind === 'success' ? (
        <>
          <p style={{ fontSize: 13, color: 'var(--hero)', fontWeight: 600, margin: '8px 0' }}>
            {phase.enqueued ? a.outcomes.released : a.outcomes.releasedNotEnqueued}
          </p>
          <button type="button" onClick={closeAndRefresh} style={buttonStyle('primary')}>
            {t.ops.actions.close}
          </button>
        </>
      ) : (
        <>
          <p style={{ fontSize: 12, color: 'var(--muted)', margin: '0 0 8px' }}>{a.releaseConsequence}</p>

          <label style={{ display: 'block', fontSize: 12, marginBottom: 4 }}>
            {a.noteLabel}
            <textarea
              value={note}
              onChange={(e) => setNote(e.target.value)}
              rows={3}
              maxLength={OPS_NOTE_MAX}
              disabled={phase.kind === 'busy'}
              style={{ ...inputStyle(note.length > 0 && !noteOk), fontFamily: 'inherit', resize: 'vertical' }}
            />
          </label>
          <p style={{ fontSize: 12, color: 'var(--muted)', margin: '0 0 8px' }}>
            {note.length > 0 && !noteOk ? a.noteTooShort : a.noteHint}
          </p>

          {phase.kind === 'error' && (
            <p style={{ fontSize: 12, color: 'var(--muted)', margin: '0 0 8px' }}>
              {errs[phase.error]}
              {phase.detail != null && <span style={{ fontFamily: 'var(--mono)' }}> {phase.detail}</span>}
            </p>
          )}

          <div style={{ display: 'flex', gap: 8 }}>
            <button
              type="button"
              onClick={submit}
              disabled={phase.kind === 'busy' || !noteOk}
              style={buttonStyle('primary', phase.kind === 'busy' || !noteOk)}
            >
              {phase.kind === 'busy' ? t.ops.actions.working : a.confirmReleaseHold}
            </button>
            <button
              type="button"
              onClick={() => setOpen(false)}
              disabled={phase.kind === 'busy'}
              style={buttonStyle('secondary', phase.kind === 'busy')}
            >
              {t.ops.actions.cancel}
            </button>
          </div>
        </>
      )}
    </div>
  )
}
