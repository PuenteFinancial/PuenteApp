'use client'

// v1.1 resolve-cancellation actions (Refund / Deny) for one pending-
// cancellation row. Renders only when the overview reports actionsEnabled
// (the API's double-control write gate is live) — see OpsOverviewView.
//
// Ceremony mirrors the CLI: the confirm modal IS `--confirm` (explicit amount
// + consequence copy; no typed re-entry — typing adds error surface without
// adding evidence), and for deny the REQUIRED depositedAt evidence input is
// the typed confirmation. The request time renders beside the input (the CLI
// dry-run courtesy) with the typo-direction warning: an EARLIER value makes a
// wrongful denial MORE likely (runbooks/pending-cancellation.md).
//
// Refusals arrive as non-2xx with per-code UI branches (resolveErrorKind):
// claim_abandoned is a danger state pointing at the manual-refund runbook and
// deliberately renders NO retry affordance.

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { useLanguage } from '@/components/LanguageProvider'
import { useIdempotencyKey } from '@/lib/idempotency'
import { formatUsd, formatDate } from '@/lib/sendFormat'
import {
  resolveErrorKind,
  firstDetailIssue,
  isOpsResolveSuccessShape,
  type OpsPendingCancellation,
  type OpsResolveDecision,
  type OpsResolveOutcome,
  type ResolveErrorKind,
} from '@/lib/opsOverview'

// Explicit-timezone requirement: Date.parse alone would read a bare
// '2026-08-01T15:04:05' as LOCAL time — a silent hours-sized evidence shift.
const HAS_TZ = /([zZ]|[+-]\d{2}:?\d{2})$/

function parseEvidence(input: string): string | null {
  const trimmed = input.trim()
  if (!trimmed || !HAS_TZ.test(trimmed)) return null
  const ms = Date.parse(trimmed)
  if (Number.isNaN(ms)) return null
  return new Date(ms).toISOString()
}

type Phase =
  | { kind: 'idle' }
  | { kind: 'busy' }
  | { kind: 'success'; outcome: OpsResolveOutcome }
  | { kind: 'error'; error: ResolveErrorKind; detail: string | null }

export default function CancellationActions({ req }: { req: OpsPendingCancellation }) {
  const router = useRouter()
  const { lang, t } = useLanguage()
  const s = t.ops.actions

  const [mode, setMode] = useState<OpsResolveDecision | null>(null)
  const [phase, setPhase] = useState<Phase>({ kind: 'idle' })
  const [evidence, setEvidence] = useState('')
  const [evidenceInvalid, setEvidenceInvalid] = useState(false)
  const keyHolder = useIdempotencyKey()

  const alreadyDisbursed = req.refundPaymentRef != null

  const open = (m: OpsResolveDecision) => {
    setMode(m)
    setPhase({ kind: 'idle' })
    setEvidence('')
    setEvidenceInvalid(false)
  }

  const closeAndRefresh = () => {
    setMode(null)
    router.refresh()
  }

  const submit = async () => {
    if (mode == null || phase.kind === 'busy') return

    let depositedAt: string | undefined
    if (mode === 'deny') {
      const parsed = parseEvidence(evidence)
      if (parsed == null) {
        setEvidenceInvalid(true)
        return
      }
      depositedAt = parsed
    }

    setEvidenceInvalid(false)
    setPhase({ kind: 'busy' })
    try {
      const res = await fetch('/api/ops/cancellations/resolve', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          // Held across retries of THIS attempt; cleared only on success —
          // a non-2xx released the server-side claim, so a corrected body may
          // reuse the key.
          'Idempotency-Key': keyHolder.take(),
        },
        body: JSON.stringify({
          transferId: req.transferId,
          decision: mode,
          ...(depositedAt !== undefined && { depositedAt }),
        }),
      })
      const body: unknown = await res.json().catch(() => null)
      if (res.ok && isOpsResolveSuccessShape(body)) {
        keyHolder.clear()
        setPhase({ kind: 'success', outcome: body.outcome })
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

  if (mode == null) {
    return (
      <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
        <button type="button" onClick={() => open('refund')} style={buttonStyle('primary')}>
          {alreadyDisbursed ? s.settleRefund : s.refund}
        </button>
        <button type="button" onClick={() => open('deny')} style={buttonStyle('secondary')}>
          {s.deny}
        </button>
      </div>
    )
  }

  const danger = phase.kind === 'error' && phase.error === 'claim_abandoned'

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
      <div style={{ fontSize: 13, fontWeight: 700, marginBottom: 6 }}>
        {mode === 'refund' ? s.confirmRefund : s.confirmDeny}
      </div>

      <div style={{ fontSize: 13, marginBottom: 2 }}>
        {s.amountLabel}:{' '}
        <span style={{ fontFamily: 'var(--mono)' }}>
          {formatUsd(req.sendAmountMinor + req.feeAmountMinor)}
        </span>
      </div>
      <div style={{ fontSize: 13, marginBottom: 6 }}>
        {s.requestedAtLabel}:{' '}
        <span style={{ fontFamily: 'var(--mono)' }}>{formatDate(req.requestedAt, lang)}</span>
        <span style={{ fontFamily: 'var(--mono)', color: 'var(--muted)' }}> · {req.requestedAt}</span>
      </div>

      {phase.kind === 'success' ? (
        <>
          <p style={{ fontSize: 13, color: 'var(--hero)', fontWeight: 600, margin: '8px 0' }}>
            {s.outcomes[phase.outcome]}
          </p>
          <button type="button" onClick={closeAndRefresh} style={buttonStyle('primary')}>
            {s.close}
          </button>
        </>
      ) : (
        <>
          {mode === 'refund' ? (
            <p style={{ fontSize: 12, color: 'var(--muted)', margin: '0 0 8px' }}>
              {alreadyDisbursed ? s.settleNote : s.refundConsequence}
            </p>
          ) : (
            <div style={{ margin: '0 0 8px' }}>
              <label style={{ display: 'block', fontSize: 12, marginBottom: 4 }}>
                {s.denyEvidenceLabel}
                <input
                  type="text"
                  value={evidence}
                  onChange={(e) => setEvidence(e.target.value)}
                  placeholder="2026-08-01T15:04:05Z"
                  style={{
                    display: 'block',
                    width: '100%',
                    marginTop: 4,
                    padding: '6px 8px',
                    fontFamily: 'var(--mono)',
                    fontSize: 13,
                    border: `1px solid ${evidenceInvalid ? 'var(--color-error)' : 'var(--line-2)'}`,
                    borderRadius: 'var(--r-sm)',
                    background: 'var(--surface-2)',
                    color: 'inherit',
                  }}
                />
              </label>
              {evidenceInvalid && (
                <p style={{ fontSize: 12, color: 'var(--color-error)', margin: '0 0 4px' }}>
                  {s.denyInvalidTimestamp}
                </p>
              )}
              <p style={{ fontSize: 12, color: 'var(--muted)', margin: '0 0 4px' }}>
                {s.denyEvidenceHint} {s.denyComparedNote}
              </p>
              <p style={{ fontSize: 12, color: 'var(--color-error)', margin: 0 }}>
                {s.denyTypoWarning}
              </p>
            </div>
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
              {s.errors[phase.error]}
              {phase.detail != null && (
                <span style={{ fontFamily: 'var(--mono)' }}> {phase.detail}</span>
              )}
            </p>
          )}

          <div style={{ display: 'flex', gap: 8 }}>
            {/* claim_abandoned: no retry affordance — runbook only. */}
            {!danger && (
              <button
                type="button"
                onClick={submit}
                disabled={phase.kind === 'busy'}
                style={buttonStyle('primary', phase.kind === 'busy')}
              >
                {phase.kind === 'busy'
                  ? s.working
                  : mode === 'refund'
                    ? s.confirmRefund
                    : s.confirmDeny}
              </button>
            )}
            <button
              type="button"
              onClick={danger ? closeAndRefresh : () => setMode(null)}
              disabled={phase.kind === 'busy'}
              style={buttonStyle('secondary', phase.kind === 'busy')}
            >
              {danger ? s.close : s.cancel}
            </button>
          </div>
        </>
      )}
    </div>
  )
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
