'use client'

// The per-transfer ops page (ops board slice 1, /dashboard/ops/transfers/[id]).
// Props-fed by the server component — this view fetches nothing. The
// hold-release and refund actions (O-B) mount into the Hold and Refund
// sections, gated on detailActions() — which is [] unless the API reports the
// write capability live, and never offers refund on an abandoned claim.
//
// Section order is the operator's reading order: what is blocking it (hold /
// refund preflight), then what happened (timeline, ledger, events), then the
// context (cancellations, deposit instructions, quote, destination statuses,
// disclosures). PII posture is the API's; nothing here shows a person.
import Link from 'next/link'
import { useLanguage } from '@/components/LanguageProvider'
import { badgeTone, type TransferState } from '@/lib/transferState'
import { formatUsd, formatMxn } from '@/lib/sendFormat'
import { formatBalance } from '@/lib/opsOverview'
import {
  ledgerBalanced,
  releasableHoldReason,
  refundPreflight,
  detailActions,
  activityRows,
  formatOpsTimestamp,
  type OpsTransferDetail,
} from '@/lib/opsTransferDetail'
import { actorShort, activityTone, isKnownActionKind, formatChange } from '@/lib/opsActivity'
import { Pill, Section, Card, Row, Muted, shortId } from '@/components/ops/OpsPrimitives'
import HoldReleaseAction from '@/components/ops/HoldReleaseAction'
import RefundAction from '@/components/ops/RefundAction'

const formatMinor = (minor: number, currency: string) => formatBalance(minor, currency)

export default function OpsTransferDetailView({ detail }: { detail: OpsTransferDetail }) {
  const { lang, t } = useLanguage()
  const s = t.ops
  const d = s.detail
  const L = d.labels
  const tr = detail.transfer
  const ts = (iso: string | null) => (iso == null ? '—' : formatOpsTimestamp(iso, lang))
  const yesNo = (v: boolean) => (v ? L.yes : L.no)

  const releasable = releasableHoldReason(detail)
  const preflight = refundPreflight(detail)
  const actions = detailActions(detail)
  const activity = activityRows(detail)
  const balanced = ledgerBalanced(detail)
  const totalMinor = tr.sendAmountMinor + tr.feeAmountMinor

  return (
    <div>
      <p style={{ fontSize: 12, margin: '0 0 12px' }}>
        <Link href="/dashboard/ops" style={{ color: 'var(--muted)' }}>
          ← {d.backToBoard}
        </Link>
      </p>

      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
        <h1 style={{ fontSize: 20, fontWeight: 700, margin: 0 }}>
          {d.title} <span style={{ fontFamily: 'var(--mono)', fontSize: 16 }}>{shortId(tr.transferId)}</span>
        </h1>
        <Pill label={tr.state} tone={badgeTone(tr.state as TransferState)} />
      </div>
      <p style={{ fontSize: 12, fontFamily: 'var(--mono)', color: 'var(--muted)', margin: '4px 0 0', wordBreak: 'break-all' }}>
        {tr.transferId}
      </p>
      <p style={{ fontSize: 12, color: 'var(--muted)', margin: '4px 0 20px' }}>
        {s.generatedAt}: {formatOpsTimestamp(detail.generatedAt, lang)}
      </p>

      {/* Money + dwell at a glance */}
      <Card>
        <Row label={L.total} mono>
          {formatMinor(totalMinor, tr.sendCurrency)}
        </Row>
        <Row label={L.send} mono>
          {formatMinor(tr.sendAmountMinor, tr.sendCurrency)}
        </Row>
        <Row label={L.fee} mono>
          {formatMinor(tr.feeAmountMinor, tr.sendCurrency)}
        </Row>
        <Row label={L.margin} mono>
          {formatMinor(tr.marginMinor, tr.sendCurrency)}
        </Row>
        <Row label={L.receive} mono>
          {formatMinor(tr.receiveAmountMinor, tr.receiveCurrency)}
        </Row>
        <Row label={L.fxRate} mono>
          {tr.fxRate}
        </Row>
        <Row label={L.fundingProcessor} mono>
          {tr.fundingProcessor}
        </Row>
        {tr.dwell != null && (
          <Row label={L.dwell} mono>
            <span style={{ color: tr.dwell.overThreshold ? 'var(--color-error)' : undefined }}>
              {tr.dwell.dwellMinutes}m / {s.threshold}: {tr.dwell.thresholdMinutes}m
            </span>
          </Row>
        )}
      </Card>

      {/* === Hold === */}
      <Section title={d.sections.hold}>
        {tr.payoutHoldReason == null ? (
          <Muted>{d.holdNone}</Muted>
        ) : (
          <Card>
            <Row label={L.holdReason}>
              <Pill
                label={s.holdReasons[tr.payoutHoldReason as keyof typeof s.holdReasons] ?? tr.payoutHoldReason}
                tone="error"
              />
            </Row>
            <Row label={L.heldAt} mono>
              {ts(tr.payoutHeldAt)}
            </Row>
            <div style={{ marginTop: 10, fontSize: 13 }}>
              <div style={{ fontWeight: 700, marginBottom: 4 }}>{d.holdGuidanceTitle}</div>
              <p style={{ margin: 0, color: 'var(--muted)' }}>
                {releasable != null ? d.holdGuidance[releasable] : d.releaseNotAvailableKyc}
              </p>
            </div>
            {actions.includes('holdRelease') && releasable != null && (
              <HoldReleaseAction transferId={tr.transferId} reason={releasable} />
            )}
          </Card>
        )}
      </Section>

      {/* === Refund === */}
      <Section title={d.sections.refund}>
        <Card>
          <Row label={L.claimStatus}>
            <Pill
              label={s.claimStatus[detail.refund.claimStatus]}
              tone={
                detail.refund.claimStatus === 'abandoned'
                  ? 'error'
                  : detail.refund.claimStatus === 'claimed'
                    ? 'progress'
                    : 'neutral'
              }
            />
          </Row>
          {detail.refund.claimedAt != null && (
            <Row label={L.claimedAt} mono>
              {ts(detail.refund.claimedAt)}
            </Row>
          )}
          {detail.refund.claimedBy != null && (
            <Row label={L.claimedBy} mono>
              {detail.refund.claimedBy}
            </Row>
          )}
          <Row label={L.returnEvent} mono>
            {detail.refund.returnEventType ?? L.returnEventNone}
          </Row>
          <Row label={L.refundRef} mono>
            {tr.refundPaymentRef ?? '—'}
          </Row>
          <Row label={L.refundedAt} mono>
            {ts(tr.refundedAt)}
          </Row>
          <Row label={L.ledgerKeys} mono>
            bridge_return: {yesNo(detail.refund.ledgerKeys.bridgeReturn)} · REFUNDED:{' '}
            {yesNo(detail.refund.ledgerKeys.refunded)}
          </Row>
          {tr.state === 'PAYOUT_FAILED' && (
            <div style={{ marginTop: 10, fontSize: 13 }}>
              <div style={{ fontWeight: 700, marginBottom: 4 }}>{d.refundPreflightTitle}</div>
              {preflight.blockers.length === 0 ? (
                <p style={{ margin: 0, color: 'var(--hero)' }}>{d.refundReady}</p>
              ) : (
                preflight.blockers.map((b) => (
                  <p
                    key={b}
                    style={{
                      margin: '0 0 4px',
                      color: b === 'claim_abandoned' ? 'var(--color-error)' : 'var(--muted)',
                      fontWeight: b === 'claim_abandoned' ? 700 : 400,
                    }}
                  >
                    {d.refundBlocked[b]}
                  </p>
                ))
              )}
            </div>
          )}
          {actions.includes('refund') && <RefundAction transferId={tr.transferId} totalMinor={totalMinor} />}
        </Card>
      </Section>

      {/* === Activity (slice 2) — what humans did to this transfer, between what
          is blocking it and what happened. The note and the derived changes
          live here and only here. Absent = not reported (deploy skew). === */}
      {detail.activity !== undefined && (
        <Section title={s.activity.historyTitle}>
          {activity.length === 0 ? (
            <Muted>{s.activity.historyEmpty}</Muted>
          ) : (
            <Card>
              {activity.map((row, i) => (
                <div
                  key={row.id}
                  style={{
                    marginTop: i === 0 ? 0 : 10,
                    paddingTop: i === 0 ? 0 : 10,
                    borderTop: i === 0 ? 'none' : '1px solid var(--line-2)',
                    fontSize: 13,
                  }}
                >
                  <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 8 }}>
                    <Pill
                      label={isKnownActionKind(row.action) ? s.activity.actions[row.action] : row.action}
                      tone={activityTone(row.action)}
                    />
                    <span style={{ fontFamily: 'var(--mono)', fontSize: 12, color: 'var(--muted)' }}>
                      {ts(row.createdAt)}
                    </span>
                    <span style={{ fontFamily: 'var(--mono)', fontSize: 12 }}>{actorShort(row.actor)}</span>
                    {row.reason != null && (
                      <span style={{ fontFamily: 'var(--mono)', fontSize: 12, color: 'var(--muted)' }}>{row.reason}</span>
                    )}
                  </div>
                  {row.note != null && (
                    <p style={{ margin: '6px 0 0', whiteSpace: 'pre-wrap' }}>
                      <span style={{ color: 'var(--muted)' }}>{s.activity.note}: </span>
                      {row.note}
                    </p>
                  )}
                  {row.changes.length > 0 && (
                    <div style={{ marginTop: 6, fontFamily: 'var(--mono)', fontSize: 12 }}>
                      <div style={{ color: 'var(--muted)' }}>{s.activity.changes}</div>
                      {row.changes.map((c) => (
                        <div key={c.key}>{formatChange(c)}</div>
                      ))}
                    </div>
                  )}
                  {row.requestId != null && (
                    <div style={{ marginTop: 4, fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--muted)' }}>
                      {s.activity.requestId}: {row.requestId}
                    </div>
                  )}
                </div>
              ))}
            </Card>
          )}
        </Section>
      )}

      {/* === Timeline === */}
      <Section title={d.sections.timeline}>
        {detail.transitions.length === 0 ? (
          <Muted>{d.empty.transitions}</Muted>
        ) : (
          <Card>
            {detail.transitions.map((tx, i) => (
              <div
                key={`${tx.createdAt}:${i}`}
                style={{ display: 'flex', justifyContent: 'space-between', gap: 12, fontSize: 13, padding: '4px 0', flexWrap: 'wrap' }}
              >
                <span style={{ fontFamily: 'var(--mono)' }}>
                  {tx.fromState ?? '∅'} → {tx.toState}
                </span>
                <span style={{ color: 'var(--muted)', fontFamily: 'var(--mono)', fontSize: 12 }}>
                  {tx.actor}
                  {tx.reason != null && ` · ${tx.reason}`}
                  {' · '}
                  {formatOpsTimestamp(tx.createdAt, lang)}
                </span>
              </div>
            ))}
          </Card>
        )}
      </Section>

      {/* === Ledger === */}
      <Section title={d.sections.ledger}>
        {detail.ledger.length === 0 ? (
          <Muted>{d.empty.ledger}</Muted>
        ) : (
          <>
            <p style={{ fontSize: 12, margin: '0 0 8px', color: balanced ? 'var(--hero)' : 'var(--color-error)', fontWeight: 600 }}>
              {balanced ? L.ledgerBalanced : L.ledgerUnbalanced}
            </p>
            {detail.ledger.map((batch) => (
              <Card key={batch.idempotencyKey}>
                <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8, fontSize: 13, flexWrap: 'wrap' }}>
                  <span style={{ fontFamily: 'var(--mono)', fontWeight: 600 }}>{batch.transition ?? '—'}</span>
                  <span style={{ color: 'var(--muted)', fontSize: 12 }}>{formatOpsTimestamp(batch.postedAt, lang)}</span>
                </div>
                <div style={{ fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--muted)', wordBreak: 'break-all' }}>
                  {batch.idempotencyKey}
                </div>
                <div style={{ marginTop: 6 }}>
                  {batch.entries.map((e, i) => (
                    <div key={i} style={{ display: 'flex', justifyContent: 'space-between', fontSize: 13, padding: '2px 0' }}>
                      <span style={{ fontFamily: 'var(--mono)' }}>
                        {e.direction === 'debit' ? 'DR' : 'CR'} {e.accountCode}
                      </span>
                      <span style={{ fontFamily: 'var(--mono)' }}>{formatMinor(e.amountMinor, e.currency)}</span>
                    </div>
                  ))}
                </div>
                <Row label={L.ledgerNet} mono>
                  <span style={{ color: batch.netMinor === 0 ? undefined : 'var(--color-error)' }}>{batch.netMinor}</span>
                </Row>
              </Card>
            ))}
          </>
        )}
      </Section>

      {/* === Payment events === */}
      <Section title={d.sections.paymentEvents}>
        {detail.paymentEvents.length === 0 ? (
          <Muted>{d.empty.events}</Muted>
        ) : (
          <Card>
            {detail.paymentEvents.map((ev) => (
              <div key={ev.id} style={{ display: 'flex', justifyContent: 'space-between', gap: 12, fontSize: 13, padding: '4px 0', flexWrap: 'wrap' }}>
                <span style={{ fontFamily: 'var(--mono)' }}>
                  {ev.source}/{ev.eventType}
                </span>
                <span style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                  <span style={{ color: 'var(--muted)', fontSize: 12 }}>{formatOpsTimestamp(ev.receivedAt, lang)}</span>
                  <Pill
                    label={ev.hasError ? `${ev.status} · ${L.hasError}` : ev.status}
                    tone={ev.status === 'processed' ? 'success' : ev.status === 'failed' || ev.hasError ? 'error' : 'neutral'}
                  />
                </span>
              </div>
            ))}
          </Card>
        )}
      </Section>

      {/* === Cancellations === */}
      <Section title={d.sections.cancellations}>
        {tr.cancellationRequestedAt == null && detail.cancellationRequests.length === 0 ? (
          <Muted>{d.empty.cancellations}</Muted>
        ) : (
          <>
            {tr.cancellationRequestedAt != null && (
              <Card>
                <Row label={L.cancellationRequestedAt} mono>
                  {ts(tr.cancellationRequestedAt)}
                </Row>
                <Row label={L.cancelableUntil} mono>
                  {ts(tr.cancelableUntil)}
                </Row>
              </Card>
            )}
            {detail.cancellationRequests.map((cr) => (
              <Card key={cr.id}>
                <Row label={L.requestedAt} mono>
                  {formatOpsTimestamp(cr.requestedAt, lang)}
                </Row>
                <Row label={L.requestedState} mono>
                  {cr.requestedState}
                </Row>
                <Row label={L.withinWindow}>{cr.withinWindow ? s.withinWindow : s.outOfWindow}</Row>
                <Row label={L.status} mono>
                  {cr.status}
                </Row>
                {cr.resolvedAt != null && (
                  <Row label={L.resolvedAt} mono>
                    {formatOpsTimestamp(cr.resolvedAt, lang)}
                  </Row>
                )}
                {cr.resolvedBy != null && (
                  <Row label={L.resolvedBy} mono>
                    {cr.resolvedBy}
                  </Row>
                )}
              </Card>
            ))}
          </>
        )}
      </Section>

      {/* === Funding + deposit instructions === */}
      <Section title={d.sections.depositInstructions}>
        <Card>
          <Row label={L.fundingSource} mono>
            {tr.fundingSourceType}
          </Row>
          <Row label={L.fundingRef} mono>
            {tr.fundingPaymentRef ?? '—'}
          </Row>
          <Row label={L.fundingCleared}>{yesNo(tr.fundingCleared)}</Row>
          <Row label={L.paymentAt} mono>
            {ts(tr.paymentAt)}
          </Row>
          <Row label={L.paymentClaimedAt} mono>
            {ts(tr.paymentClaimedAt)}
          </Row>
          <Row label={L.submitAttemptedAt} mono>
            {ts(tr.submitAttemptedAt)}
          </Row>
          <Row label={L.providerRef} mono>
            {tr.providerTransferRef ?? '—'}
          </Row>
        </Card>
        {detail.depositInstructions == null ? (
          <Muted>{d.empty.depositInstructions}</Muted>
        ) : (
          <Card>
            <Row label={L.onrampRef} mono>
              {detail.depositInstructions.bridgeTransferRef}
            </Row>
            <Row label={L.depositAmount} mono>
              {formatMinor(detail.depositInstructions.amountMinor, detail.depositInstructions.currency)}
            </Row>
            <Row label={L.depositRail} mono>
              {detail.depositInstructions.paymentRail}
            </Row>
            <Row label={L.depositMessage} mono>
              {detail.depositInstructions.depositMessage}
            </Row>
            <Row label={L.attachedBy} mono>
              {detail.depositInstructions.attachedBy ?? L.attachedBySystem}
            </Row>
          </Card>
        )}
      </Section>

      {/* === Quote === */}
      <Section title={d.sections.quote}>
        {detail.quote == null ? (
          <Muted>{d.empty.quote}</Muted>
        ) : (
          <Card>
            <Row label={L.fxRate} mono>
              {detail.quote.fxRate}
            </Row>
            <Row label={L.sourceRate} mono>
              {detail.quote.sourceRate}
            </Row>
            <Row label={L.margin} mono>
              {formatUsd(detail.quote.marginMinor)}
            </Row>
            <Row label={L.quoteAt} mono>
              {formatOpsTimestamp(detail.quote.fxRateAt, lang)}
            </Row>
            <Row label={L.quoteExpires} mono>
              {formatOpsTimestamp(detail.quote.expiresAt, lang)}
            </Row>
            <Row label={L.quoteStatus} mono>
              {detail.quote.status}
            </Row>
            <Row label={L.disclosureAcceptedAt} mono>
              {ts(tr.disclosureAcceptedAt)}
            </Row>
          </Card>
        )}
      </Section>

      {/* === Destination (statuses only) === */}
      <Section title={d.sections.destination}>
        {detail.destination == null ? (
          <Muted>{d.empty.destination}</Muted>
        ) : (
          <Card>
            <Row label={L.destinationStatus} mono>
              {detail.destination.status}
            </Row>
            <Row label={L.recipientStatus} mono>
              {detail.destination.recipientStatus ?? '—'}
            </Row>
            <Row label={L.providerAccountRef}>
              {detail.destination.hasProviderAccountRef ? L.present : L.missing}
            </Row>
          </Card>
        )}
      </Section>

      {/* === Disclosures === */}
      <Section title={d.sections.disclosures}>
        {detail.disclosures.length === 0 ? (
          <Muted>{d.empty.disclosures}</Muted>
        ) : (
          <Card>
            {detail.disclosures.map((dc, i) => (
              <div key={`${dc.type}:${dc.locale}:${i}`} style={{ display: 'flex', justifyContent: 'space-between', fontSize: 13, padding: '3px 0' }}>
                <span style={{ fontFamily: 'var(--mono)' }}>
                  {dc.type} · {dc.locale}
                </span>
                <span style={{ color: 'var(--muted)' }}>{formatOpsTimestamp(dc.presentedAt, lang)}</span>
              </div>
            ))}
          </Card>
        )}
      </Section>

      <Card>
        <Row label={L.createdAt} mono>
          {formatOpsTimestamp(tr.createdAt, lang)}
        </Row>
        <Row label={L.completedAt} mono>
          {ts(tr.completedAt)}
        </Row>
        {tr.receiveCurrency === 'MXN' && (
          <Row label={L.receive} mono>
            {formatMxn(tr.receiveAmountMinor)}
          </Row>
        )}
      </Card>
    </div>
  )
}
