'use client'

// funding-ops-automation slice 1: per-row transfer actions on the ops board —
// Attach instructions / Release payout / Deposit landed. Renders only when the
// overview reports actionsEnabled (see OpsOverviewView) and the row supports
// an action (transferActions — deploy skew renders read-only).
//
// Ceremony mirrors CancellationActions: inline two-step confirm restating the
// amount, Phase machine, refresh-on-close. Release is the money-mover and the
// human judgment call (release policy: evidence the sender's ACH was
// INITIATED — runbooks/manual-funding-run.md §4), so its confirm restates the
// policy line, and it holds a browser-minted Idempotency-Key across retries.
// Attach and deposit-landed are naturally idempotent on the server and take no
// key; re-running either heals rather than duplicates.

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { useLanguage } from '@/components/LanguageProvider'
import { useIdempotencyKey } from '@/lib/idempotency'
import { formatUsd } from '@/lib/sendFormat'
import {
  resolveErrorKind,
  firstDetailIssue,
  isOpsTransferFundingSuccessShape,
  isOpsAttachSuccessShape,
  transferActions,
  type OpsOpenTransfer,
  type OpsTransferAction,
  type ResolveErrorKind,
} from '@/lib/opsOverview'

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

type Phase =
  | { kind: 'idle' }
  | { kind: 'busy' }
  | { kind: 'success'; text: string; detail: string | null }
  | { kind: 'error'; error: ResolveErrorKind; detail: string | null }

export default function TransferActions({ tr }: { tr: OpsOpenTransfer }) {
  const router = useRouter()
  const { t } = useLanguage()
  const s = t.ops.actions
  const a = s.transfer

  const [mode, setMode] = useState<OpsTransferAction | null>(null)
  const [phase, setPhase] = useState<Phase>({ kind: 'idle' })
  const [refValue, setRefValue] = useState('')
  const [refInvalid, setRefInvalid] = useState(false)
  const keyHolder = useIdempotencyKey()

  const actions = transferActions(tr)
  if (actions.length === 0) return null

  // transferActions returned non-empty, so the action fields are present.
  const totalMinor = tr.sendAmountMinor + (tr.feeAmountMinor ?? 0)

  const open = (m: OpsTransferAction) => {
    setMode(m)
    setPhase({ kind: 'idle' })
    // The onramp id doubles as the deposit ref — prefill from the attached
    // instructions so the operator confirms rather than transcribes.
    setRefValue(tr.onrampRef ?? '')
    setRefInvalid(false)
  }

  const closeAndRefresh = () => {
    setMode(null)
    router.refresh()
  }

  const submit = async () => {
    if (mode == null || phase.kind === 'busy') return

    const ref = refValue.trim()
    if (mode === 'attach' ? !UUID_RE.test(ref) : ref.length === 0) {
      setRefInvalid(true)
      return
    }

    setRefInvalid(false)
    setPhase({ kind: 'busy' })
    try {
      let res: Response
      if (mode === 'attach') {
        res = await fetch('/api/ops/transfers/deposit-instructions', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ transferId: tr.transferId, bridgeTransferId: ref }),
        })
      } else if (mode === 'release') {
        res = await fetch('/api/ops/transfers/funding', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            // Held across retries of THIS attempt; cleared only on success —
            // a non-2xx released the server-side claim, so a corrected body
            // may reuse the key.
            'Idempotency-Key': keyHolder.take(),
          },
          body: JSON.stringify({
            transferId: tr.transferId,
            kind: 'funded',
            externalRef: ref,
            amountMinor: totalMinor,
            currency: 'USD',
          }),
        })
      } else {
        res = await fetch('/api/ops/transfers/deposit-landed', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            transferId: tr.transferId,
            externalRef: ref,
            amountMinor: totalMinor,
            currency: 'USD',
          }),
        })
      }

      const body: unknown = await res.json().catch(() => null)
      if (res.ok && mode === 'attach' && isOpsAttachSuccessShape(body)) {
        setPhase({ kind: 'success', text: a.outcomes.attached, detail: body.depositMessage })
        return
      }
      if (res.ok && mode !== 'attach' && isOpsTransferFundingSuccessShape(body)) {
        keyHolder.clear()
        setPhase({ kind: 'success', text: a.outcomes[body.outcome], detail: null })
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

  const triggerLabel: Record<OpsTransferAction, string> = {
    attach: a.attach,
    release: a.release,
    depositLanded: a.depositLanded,
  }
  const confirmLabel: Record<OpsTransferAction, string> = {
    attach: a.confirmAttach,
    release: a.confirmRelease,
    depositLanded: a.confirmDepositLanded,
  }
  const consequence: Record<OpsTransferAction, string> = {
    attach: a.attachNote,
    release: a.releaseConsequence,
    depositLanded: a.depositLandedConsequence,
  }

  if (mode == null) {
    return (
      <div style={{ display: 'flex', gap: 8, marginTop: 8, flexWrap: 'wrap' }}>
        {actions.map((action) => (
          <button
            key={action}
            type="button"
            onClick={() => open(action)}
            // Release moves money — it is the only primary trigger.
            style={buttonStyle(action === 'release' ? 'primary' : 'secondary')}
          >
            {triggerLabel[action]}
          </button>
        ))}
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
      <div style={{ fontSize: 13, fontWeight: 700, marginBottom: 6 }}>{confirmLabel[mode]}</div>

      <div style={{ fontSize: 13, marginBottom: 6 }}>
        {a.totalLabel}:{' '}
        <span style={{ fontFamily: 'var(--mono)' }}>{formatUsd(totalMinor)}</span>
      </div>

      {phase.kind === 'success' ? (
        <>
          <p style={{ fontSize: 13, color: 'var(--hero)', fontWeight: 600, margin: '8px 0' }}>
            {phase.text}
          </p>
          {phase.detail != null && (
            <p style={{ fontSize: 12, fontFamily: 'var(--mono)', color: 'var(--muted)', margin: '0 0 8px' }}>
              {phase.detail}
            </p>
          )}
          <button type="button" onClick={closeAndRefresh} style={buttonStyle('primary')}>
            {s.close}
          </button>
        </>
      ) : (
        <>
          <div style={{ margin: '0 0 8px' }}>
            <label style={{ display: 'block', fontSize: 12, marginBottom: 4 }}>
              {mode === 'attach' ? a.onrampIdLabel : a.refLabel}
              <input
                type="text"
                value={refValue}
                onChange={(e) => setRefValue(e.target.value)}
                style={{
                  display: 'block',
                  width: '100%',
                  marginTop: 4,
                  padding: '6px 8px',
                  fontFamily: 'var(--mono)',
                  fontSize: 13,
                  border: `1px solid ${refInvalid ? 'var(--color-error)' : 'var(--line-2)'}`,
                  borderRadius: 'var(--r-sm)',
                  background: 'var(--surface-2)',
                  color: 'inherit',
                }}
              />
            </label>
            {refInvalid && (
              <p style={{ fontSize: 12, color: 'var(--color-error)', margin: '0 0 4px' }}>
                {mode === 'attach' ? a.onrampIdInvalid : a.refRequired}
              </p>
            )}
            <p style={{ fontSize: 12, color: 'var(--muted)', margin: 0 }}>{consequence[mode]}</p>
          </div>

          {phase.kind === 'error' && (
            <p style={{ fontSize: 12, color: 'var(--muted)', margin: '0 0 8px' }}>
              {s.errors[phase.error]}
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
              {phase.kind === 'busy' ? s.working : confirmLabel[mode]}
            </button>
            <button
              type="button"
              onClick={() => setMode(null)}
              disabled={phase.kind === 'busy'}
              style={buttonStyle('secondary', phase.kind === 'busy')}
            >
              {s.cancel}
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
