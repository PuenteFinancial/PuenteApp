'use client'

// O-B: trigger the refund of a failed payout from the detail page —
// scripts/trigger-refund.ts as a button. Renders only when detailActions()
// offers 'refund' (write gate live, PAYOUT_FAILED, claim free, recorded
// return event present or pre-submit).
//
// Ceremony: inline two-step confirm restating the amount (send + fee) and the
// irreversibility, plus the REQUIRED note. The API runs the CLI's live Bridge
// interlock inside the request, so the busy state can last up to the Bridge
// timeout. Two refusals are STOP states and render the danger branch with NO
// retry affordance (CancellationActions precedent): claim_abandoned (a prior
// run may have paid without recording) and principal_not_returned (Bridge
// and the recorded event disagree — the money may be stuck at Bridge).
// Success shows the outcome and the ledger batches; an incomplete ledger is
// shown in error color even though the API answered 200.

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { useLanguage } from '@/components/LanguageProvider'
import { useIdempotencyKey } from '@/lib/idempotency'
import { formatUsd } from '@/lib/sendFormat'
import { resolveErrorKind, firstDetailIssue, type ResolveErrorKind } from '@/lib/opsOverview'
import {
  isOpsRefundSuccessShape,
  opsNoteValid,
  OPS_NOTE_MAX,
  type OpsRefundSuccess,
} from '@/lib/opsTransferDetail'
import { buttonStyle, inputStyle } from '@/components/ops/opsStyles'

type Phase =
  | { kind: 'idle' }
  | { kind: 'busy' }
  | { kind: 'success'; result: OpsRefundSuccess }
  | { kind: 'error'; error: ResolveErrorKind; detail: string | null }

const DANGER: ReadonlySet<ResolveErrorKind> = new Set(['claim_abandoned', 'principal_not_returned'])

export default function RefundAction({ transferId, totalMinor }: { transferId: string; totalMinor: number }) {
  const router = useRouter()
  const { t } = useLanguage()
  const a = t.ops.detail.actions
  const errs = t.ops.actions.errors

  const [open, setOpen] = useState(false)
  const [note, setNote] = useState('')
  const [phase, setPhase] = useState<Phase>({ kind: 'idle' })
  const keyHolder = useIdempotencyKey()

  const noteOk = opsNoteValid(note)
  const danger = phase.kind === 'error' && DANGER.has(phase.error)

  const closeAndRefresh = () => {
    setOpen(false)
    router.refresh()
  }

  const submit = async () => {
    if (phase.kind === 'busy' || !noteOk) return
    setPhase({ kind: 'busy' })
    try {
      const res = await fetch('/api/ops/transfers/refund', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          // Held across retries of THIS attempt; cleared only on success — a
          // non-2xx released the server-side claim, so a retry may reuse it.
          'Idempotency-Key': keyHolder.take(),
        },
        body: JSON.stringify({ transferId, note: note.trim() }),
      })
      const body: unknown = await res.json().catch(() => null)
      if (res.ok && isOpsRefundSuccessShape(body)) {
        keyHolder.clear()
        setPhase({ kind: 'success', result: body })
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
          {a.refund}
        </button>
      </div>
    )
  }

  return (
    <div
      style={{
        marginTop: 10,
        border: `1px solid ${danger ? 'var(--color-error)' : 'var(--line-2)'}`,
        borderRadius: 'var(--r-sm)',
        padding: '10px 12px',
        background: 'var(--surface)',
      }}
    >
      <div style={{ fontSize: 13, fontWeight: 700, marginBottom: 6 }}>{a.confirmRefund}</div>
      <div style={{ fontSize: 13, marginBottom: 6 }}>
        {t.ops.actions.amountLabel}: <span style={{ fontFamily: 'var(--mono)' }}>{formatUsd(totalMinor)}</span>
      </div>

      {phase.kind === 'success' ? (
        <>
          <p style={{ fontSize: 13, color: 'var(--hero)', fontWeight: 600, margin: '8px 0' }}>
            {a.outcomes[phase.result.outcome]}
          </p>
          <div style={{ fontSize: 12, margin: '0 0 8px' }}>
            <div style={{ color: 'var(--muted)', marginBottom: 2 }}>{a.ledgerKeys}</div>
            {phase.result.ledgerKeys.map((key) => (
              <div key={key} style={{ fontFamily: 'var(--mono)', wordBreak: 'break-all' }}>
                {key}
              </div>
            ))}
          </div>
          {!phase.result.ledgerComplete && (
            <p style={{ fontSize: 12, color: 'var(--color-error)', fontWeight: 700, margin: '0 0 8px' }}>
              {a.ledgerIncomplete}
            </p>
          )}
          <button type="button" onClick={closeAndRefresh} style={buttonStyle('primary')}>
            {t.ops.actions.close}
          </button>
        </>
      ) : (
        <>
          <p style={{ fontSize: 12, color: 'var(--muted)', margin: '0 0 8px' }}>{a.refundConsequence}</p>

          {!danger && (
            <>
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
            </>
          )}

          {phase.kind === 'error' && (
            <p
              style={{
                fontSize: 12,
                color: danger ? 'var(--color-error)' : 'var(--muted)',
                fontWeight: danger ? 700 : 400,
                margin: '0 0 8px',
              }}
            >
              {errs[phase.error]}
              {phase.detail != null && <span style={{ fontFamily: 'var(--mono)' }}> {phase.detail}</span>}
            </p>
          )}

          <div style={{ display: 'flex', gap: 8 }}>
            {/* STOP states: no retry affordance — runbook only. */}
            {!danger && (
              <button
                type="button"
                onClick={submit}
                disabled={phase.kind === 'busy' || !noteOk}
                style={buttonStyle('primary', phase.kind === 'busy' || !noteOk)}
              >
                {phase.kind === 'busy' ? t.ops.actions.working : a.confirmRefund}
              </button>
            )}
            <button
              type="button"
              onClick={danger ? closeAndRefresh : () => setOpen(false)}
              disabled={phase.kind === 'busy'}
              style={buttonStyle('secondary', phase.kind === 'busy')}
            >
              {danger ? t.ops.actions.close : t.ops.actions.cancel}
            </button>
          </div>
        </>
      )}
    </div>
  )
}
