'use client'

// The 8.5 ops board (docs/runbooks/*: "see /dashboard/ops"). Props-fed by the
// server component — this view fetches nothing. v1.1 adds exactly one write
// surface: resolve-cancellation actions on the pending-cancellations panel,
// rendered ONLY when the API reports actionsEnabled (its double-control env
// gate — OPS_ADMIN_USER_IDS × OPS_WRITE_ENABLED — is live), so a read-only
// deployment shows no dead buttons and the page never probes the POST.
// Everything else stays read-only; trigger-refund for PAYOUT_FAILED is v1.2.
import { useLanguage } from '@/components/LanguageProvider'
import CancellationActions from '@/components/ops/CancellationActions'
import { badgeTone, type TransferState } from '@/lib/transferState'
import type { BadgeTone } from '@/lib/transferState'
import { formatUsd, formatDate } from '@/lib/sendFormat'
import {
  heldTransfers,
  agingReviews,
  latestRun,
  latestFindings,
  latestSkipped,
  formatBalance,
  workerHeartbeatAlarm,
  type OpsOverview,
  type OpsOpenTransfer,
} from '@/lib/opsOverview'

// Same tone → CSS-var map as TransferHistory's pill (kept local there too —
// lifting it is a broader refactor this admin page shouldn't drive).
const TONE_COLOR: Record<BadgeTone, string> = {
  success: 'var(--hero)',
  progress: 'var(--accent-2)',
  neutral: 'var(--muted)',
  error: 'var(--color-error)',
}

function Pill({ label, tone }: { label: string; tone: BadgeTone }) {
  return (
    <span
      style={{
        fontSize: 12,
        fontWeight: 600,
        color: TONE_COLOR[tone],
        border: `1px solid ${TONE_COLOR[tone]}`,
        borderRadius: 999,
        padding: '2px 10px',
        whiteSpace: 'nowrap',
      }}
    >
      {label}
    </span>
  )
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section style={{ marginBottom: 24 }}>
      <h2 style={{ fontSize: 15, fontWeight: 700, margin: '0 0 10px' }}>{title}</h2>
      {children}
    </section>
  )
}

function Card({ children }: { children: React.ReactNode }) {
  return (
    <div
      style={{
        background: 'var(--surface-2)',
        border: '1px solid var(--line-2)',
        borderRadius: 'var(--r-sm)',
        padding: '12px 14px',
        marginBottom: 8,
      }}
    >
      {children}
    </div>
  )
}

const shortId = (id: string) => id.slice(0, 8)

export default function OpsOverviewView({ overview }: { overview: OpsOverview }) {
  const { lang, t } = useLanguage()
  const s = t.ops

  const held = heldTransfers(overview)
  const aging = agingReviews(overview)
  const findings = latestFindings(overview)
  const skipped = latestSkipped(overview)
  const run = latestRun(overview)
  const attention = overview.openTransfers.filter((tr) => tr.overThreshold || tr.holdReason != null)
  const quiet = overview.openTransfers.filter((tr) => !tr.overThreshold && tr.holdReason == null)

  const waitAnnotations = (tr: OpsOpenTransfer): string[] => {
    const notes: string[] = []
    if (tr.holdReason != null) {
      const reasonLabel =
        s.holdReasons[tr.holdReason as keyof typeof s.holdReasons] ?? tr.holdReason
      notes.push(`${s.holdLabel}: ${reasonLabel}`)
    }
    if (tr.submitAttempted && tr.state === 'FUNDED') notes.push(s.waitClaimed)
    // Only a FUNDED row is WAITING on clearing — for later states the open
    // receivable is a fact, not a wait reason (review note).
    if (!tr.fundingCleared && tr.state === 'FUNDED') notes.push(s.waitUncleared)
    if (tr.cancellationRequested) notes.push(s.waitCancelRequested)
    return notes
  }

  const transferRow = (tr: OpsOpenTransfer) => (
    <Card key={`${tr.transferId}:${tr.state}`}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8 }}>
        <span style={{ fontFamily: 'var(--mono)', fontSize: 13 }}>{shortId(tr.transferId)}</span>
        <Pill label={tr.state} tone={badgeTone(tr.state as TransferState)} />
      </div>
      <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 6, fontSize: 13 }}>
        <span style={{ color: 'var(--muted)' }}>{formatUsd(tr.sendAmountMinor)}</span>
        <span
          style={{
            fontFamily: 'var(--mono)',
            color: tr.overThreshold ? 'var(--color-error)' : 'var(--muted)',
          }}
        >
          {s.dwell}: {tr.dwellMinutes}m / {s.threshold}: {tr.thresholdMinutes}m
        </span>
      </div>
      {waitAnnotations(tr).length > 0 && (
        <div style={{ marginTop: 6, fontSize: 12, color: 'var(--muted)' }}>
          {waitAnnotations(tr).join(' · ')}
        </div>
      )}
    </Card>
  )

  return (
    <div>
      <h1 style={{ fontSize: 20, fontWeight: 700, margin: '0 0 4px' }}>{s.title}</h1>
      <p style={{ fontSize: 12, color: 'var(--muted)', margin: '0 0 20px' }}>
        {s.generatedAt}: {formatDate(overview.generatedAt, lang)}
      </p>

      {/* === Needs you === */}
      <h2 style={{ fontSize: 13, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.06em', color: 'var(--muted)', margin: '0 0 12px' }}>
        {s.needsYou}
        {(held.length > 0 || aging.length > 0) && (
          <span style={{ fontWeight: 400, textTransform: 'none', letterSpacing: 0, marginLeft: 8 }}>
            {held.length > 0 && `${s.holdLabel} (${held.length})`}
            {held.length > 0 && aging.length > 0 && ' · '}
            {aging.length > 0 && `UNDER_REVIEW (${aging.length})`}
          </span>
        )}
      </h2>

      {/* A dead worker outranks every queue below it: nothing is being swept,
          submitted, or polled, so every other number on this page is frozen
          rather than calm. Rendered only when actually stale — absent (deploy
          skew) must not cry wolf. */}
      {workerHeartbeatAlarm(overview) && (
        <div
          style={{
            border: '1px solid var(--color-error)',
            borderRadius: 8,
            padding: '10px 12px',
            marginBottom: 12,
            fontSize: 13,
            fontWeight: 600,
            color: 'var(--color-error)',
          }}
        >
          {s.heartbeatDead}
        </div>
      )}

      {/* Always rendered: a healthy ceiling that showed NOTHING would be
          indistinguishable from a failed panel (review finding). */}
      <Section title={s.floatCeiling}>
        {!overview.floatCeiling.configured ? (
          <p style={{ fontSize: 13, color: 'var(--muted)' }}>{s.floatNotConfigured}</p>
        ) : (
          <Card>
            <span
              style={{
                color: overview.floatCeiling.tripped ? 'var(--color-error)' : 'var(--hero)',
                fontWeight: 600,
                fontSize: 13,
              }}
            >
              {overview.floatCeiling.tripped ? s.floatTripped : s.floatOk}
            </span>
            <div style={{ marginTop: 4, fontSize: 13, fontFamily: 'var(--mono)' }}>
              {s.floatBalance}: {formatUsd(overview.floatCeiling.balanceMinor)} · {s.floatCeilingValue}:{' '}
              {overview.floatCeiling.ceilingMinor != null ? formatUsd(overview.floatCeiling.ceilingMinor) : '—'}
            </div>
          </Card>
        )}
      </Section>

      <Section title={s.pendingCancellations}>
        {overview.pendingCancellations.length === 0 ? (
          <p style={{ fontSize: 13, color: 'var(--muted)' }}>{s.pendingCancellationsEmpty}</p>
        ) : (
          overview.pendingCancellations.map((req) => (
            <Card key={req.transferId}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8 }}>
                <span style={{ fontFamily: 'var(--mono)', fontSize: 13 }}>{shortId(req.transferId)}</span>
                <Pill label={req.state} tone={badgeTone(req.state as TransferState)} />
              </div>
              <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 6, fontSize: 13 }}>
                <span style={{ color: 'var(--muted)' }}>
                  {formatUsd(req.sendAmountMinor + req.feeAmountMinor)}
                </span>
                <span style={{ color: 'var(--muted)' }}>{formatDate(req.requestedAt, lang)}</span>
              </div>
              <div style={{ marginTop: 6, fontSize: 12, color: 'var(--muted)' }}>
                {req.withinWindow ? s.withinWindow : s.outOfWindow}
                {req.refundPaymentRef != null && ` · ${s.refundMoving}`}
              </div>
              {overview.actionsEnabled === true && <CancellationActions req={req} />}
            </Card>
          ))
        )}
      </Section>

      <Section title={s.latestFindings}>
        {run == null ? (
          <p style={{ fontSize: 13, color: 'var(--muted)' }}>{s.findingsEmpty}</p>
        ) : findings.length === 0 ? (
          <p style={{ fontSize: 13, color: 'var(--muted)' }}>{s.findingsNone}</p>
        ) : (
          findings.map((check) => (
            <Card key={check.name}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8 }}>
                <span style={{ fontFamily: 'var(--mono)', fontSize: 13 }}>{check.name}</span>
                <Pill label={check.status === 'error' ? s.checkError : `${check.findingsCount} ${s.findingsCount}`} tone="error" />
              </div>
              {check.error != null && (
                <div style={{ marginTop: 6, fontSize: 12, color: 'var(--muted)', fontFamily: 'var(--mono)' }}>
                  {check.error}
                </div>
              )}
            </Card>
          ))
        )}
        {/* Skipped ≠ clean: checks that never ran must not vanish into
            "latest run was clean" (review finding — the recon service's own
            rule is that skipped is never a fake pass). */}
        {skipped.length > 0 && (
          <p style={{ fontSize: 12, color: 'var(--muted)', marginTop: 4 }}>
            {skipped.length} {s.checksSkipped}: {skipped.map((c) => c.name).join(', ')}
          </p>
        )}
      </Section>

      <Section title={s.openTransfers}>
        {overview.openTransfers.length === 0 ? (
          <p style={{ fontSize: 13, color: 'var(--muted)' }}>{s.openTransfersEmpty}</p>
        ) : (
          <>
            <p style={{ fontSize: 12, color: 'var(--muted)', margin: '0 0 8px' }}>{s.openTransfersNote}</p>
            {attention.map(transferRow)}
            {quiet.map(transferRow)}
          </>
        )}
      </Section>

      {/* === State of the world === */}
      <h2 style={{ fontSize: 13, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.06em', color: 'var(--muted)', margin: '24px 0 12px' }}>
        {s.stateOfWorld}
      </h2>

      {/* First in this group: whether the worker is alive conditions how much
          every panel below it can be trusted. */}
      <Section title={s.workerHeartbeat}>
        {(overview.workerHeartbeats ?? []).length === 0 ? (
          <p style={{ fontSize: 13, color: 'var(--muted)' }}>{s.workerHeartbeatEmpty}</p>
        ) : (
          <Card>
            {(overview.workerHeartbeats ?? []).map((b) => (
              <div
                key={b.worker}
                style={{
                  display: 'flex',
                  justifyContent: 'space-between',
                  alignItems: 'center',
                  gap: 8,
                  fontSize: 13,
                  padding: '3px 0',
                }}
              >
                <span style={{ fontFamily: 'var(--mono)' }}>{b.worker}</span>
                <span style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <span style={{ color: 'var(--muted)' }}>{formatDate(b.beatAt, lang)}</span>
                  <Pill
                    label={b.stale ? s.heartbeatStale : s.heartbeatLive}
                    tone={b.stale ? 'error' : 'success'}
                  />
                </span>
              </div>
            ))}
          </Card>
        )}
      </Section>

      <Section title={s.transferCounts}>
        {overview.transferCounts.length === 0 ? (
          <p style={{ fontSize: 13, color: 'var(--muted)' }}>{s.transferCountsEmpty}</p>
        ) : (
          <Card>
            {overview.transferCounts.map((row) => (
              <div
                key={row.state}
                style={{ display: 'flex', justifyContent: 'space-between', fontSize: 13, padding: '2px 0' }}
              >
                <span style={{ fontFamily: 'var(--mono)' }}>{row.state}</span>
                <span style={{ fontFamily: 'var(--mono)' }}>{row.count}</span>
              </div>
            ))}
          </Card>
        )}
      </Section>

      <Section title={s.ledgerBalances}>
        {overview.ledgerBalances == null ? (
          <p style={{ fontSize: 13, color: 'var(--muted)' }}>{s.ledgerBalancesEmpty}</p>
        ) : (
          <>
            <p style={{ fontSize: 12, color: 'var(--muted)', margin: '0 0 8px' }}>
              {s.ledgerBalancesAsOf}: {formatDate(overview.ledgerBalances.asOf, lang)}
            </p>
            <Card>
              {overview.ledgerBalances.balances.map((bal) => (
                <div
                  key={bal.code}
                  style={{ display: 'flex', justifyContent: 'space-between', fontSize: 13, padding: '2px 0' }}
                >
                  <span style={{ fontFamily: 'var(--mono)' }}>{bal.code}</span>
                  <span style={{ fontFamily: 'var(--mono)' }}>{formatBalance(bal.amountMinor, bal.currency)}</span>
                </div>
              ))}
            </Card>
          </>
        )}
      </Section>

      <Section title={s.reconRuns}>
        {overview.reconciliationRuns.length === 0 ? (
          <p style={{ fontSize: 13, color: 'var(--muted)' }}>{s.reconRunsEmpty}</p>
        ) : (
          <Card>
            {overview.reconciliationRuns.map((r) => (
              <div
                key={r.createdAt}
                style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', fontSize: 13, padding: '3px 0', gap: 8 }}
              >
                <span style={{ color: 'var(--muted)' }}>{formatDate(r.createdAt, lang)}</span>
                <span style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  {r.findingsCount > 0 && (
                    <span style={{ fontFamily: 'var(--mono)', color: 'var(--muted)', fontSize: 12 }}>
                      {r.findingsCount} {s.findingsCount}
                    </span>
                  )}
                  <Pill
                    label={s.reconStatus[r.status as keyof typeof s.reconStatus] ?? r.status}
                    tone={r.status === 'pass' ? 'success' : r.status === 'findings' ? 'progress' : 'error'}
                  />
                </span>
              </div>
            ))}
          </Card>
        )}
      </Section>
    </div>
  )
}
