import { describe, it, expect } from 'vitest'
import {
  isOpsTransferDetailShape,
  ledgerBalanced,
  releasableHoldReason,
  refundPreflight,
  detailActions,
  formatOpsTimestamp,
  RELEASABLE_HOLD_REASONS,
  opsNoteValid,
  isOpsHoldReleaseSuccessShape,
  isOpsRefundSuccessShape,
  activityRows,
  type OpsTransferDetail,
} from './opsTransferDetail'

const T = 'cccccccc-1111-4222-8333-444444444444'

const detail = (over: Partial<OpsTransferDetail> = {}): OpsTransferDetail => ({
  generatedAt: '2026-09-08T12:00:00.000Z',
  actionsEnabled: true,
  transfer: {
    transferId: T,
    state: 'FUNDED',
    sendAmountMinor: 30_000,
    sendCurrency: 'USD',
    receiveAmountMinor: 540_000,
    receiveCurrency: 'MXN',
    feeAmountMinor: 500,
    marginMinor: 0,
    fxRate: 18,
    fundingSourceType: 'ach',
    fundingProcessor: 'stripe_crypto',
    fundingCleared: false,
    fundingPaymentRef: 'cos_1',
    providerTransferRef: null,
    refundPaymentRef: null,
    payoutHoldReason: null,
    payoutHeldAt: null,
    submitAttemptedAt: null,
    cancellationRequestedAt: null,
    paymentClaimedAt: null,
    disclosureAcceptedAt: null,
    paymentAt: '2026-09-08T10:30:00.000Z',
    cancelableUntil: null,
    completedAt: null,
    refundedAt: null,
    createdAt: '2026-09-08T09:55:00.000Z',
    dwell: null,
  },
  quote: null,
  destination: null,
  refund: {
    claimStatus: 'unclaimed',
    claimedAt: null,
    claimedBy: null,
    returnEventType: null,
    ledgerKeys: { bridgeReturn: false, refunded: false },
  },
  transitions: [],
  ledger: [],
  paymentEvents: [],
  cancellationRequests: [],
  depositInstructions: null,
  disclosures: [],
  ...over,
})

const withTransfer = (over: Partial<OpsTransferDetail['transfer']>, rest: Partial<OpsTransferDetail> = {}) =>
  detail({ ...rest, transfer: { ...detail().transfer, ...over } })

describe('isOpsTransferDetailShape', () => {
  it('accepts a well-formed payload', () => {
    expect(isOpsTransferDetailShape(detail())).toBe(true)
    expect(isOpsTransferDetailShape(detail({ actionsEnabled: undefined }))).toBe(true)
  })

  it('rejects contract violations rather than rendering an empty healthy page', () => {
    expect(isOpsTransferDetailShape(null)).toBe(false)
    expect(isOpsTransferDetailShape('<html>gateway error</html>')).toBe(false)
    expect(isOpsTransferDetailShape({})).toBe(false)
    expect(isOpsTransferDetailShape({ ...detail(), transfer: {} })).toBe(false)
    expect(isOpsTransferDetailShape({ ...detail(), transitions: 'nope' })).toBe(false)
    expect(isOpsTransferDetailShape({ ...detail(), refund: { claimStatus: 'maybe' } })).toBe(false)
    expect(isOpsTransferDetailShape({ ...detail(), actionsEnabled: 'yes' })).toBe(false)
  })
})

describe('ledgerBalanced', () => {
  const batch = (netMinor: number) => ({
    transition: 'FUNDED',
    idempotencyKey: `${T}:FUNDED`,
    description: null,
    postedAt: '2026-09-08T10:30:00.000Z',
    netMinor,
    entries: [],
  })

  it('is true with no batches and when every batch nets to zero', () => {
    expect(ledgerBalanced(detail())).toBe(true)
    expect(ledgerBalanced(detail({ ledger: [batch(0), batch(0)] }))).toBe(true)
  })

  it('is false the moment any batch does not net to zero', () => {
    expect(ledgerBalanced(detail({ ledger: [batch(0), batch(10)] }))).toBe(false)
  })
})

describe('releasableHoldReason', () => {
  it('offers exactly the four human-actioned reasons on a FUNDED row', () => {
    for (const reason of RELEASABLE_HOLD_REASONS) {
      expect(releasableHoldReason(withTransfer({ payoutHoldReason: reason }))).toBe(reason)
    }
  })

  it('never offers sender_kyc_pending — it auto-releases on the Bridge webhook', () => {
    expect(releasableHoldReason(withTransfer({ payoutHoldReason: 'sender_kyc_pending' }))).toBeNull()
  })

  it('is null without a hold, and on any state other than FUNDED', () => {
    expect(releasableHoldReason(detail())).toBeNull()
    expect(
      releasableHoldReason(withTransfer({ state: 'SUBMITTED', payoutHoldReason: 'fx_drift' })),
    ).toBeNull()
  })
})

describe('refundPreflight', () => {
  const failed = (refund: Partial<OpsTransferDetail['refund']> = {}, tr: Partial<OpsTransferDetail['transfer']> = {}) =>
    withTransfer(
      { state: 'PAYOUT_FAILED', providerTransferRef: 'br_1', ...tr },
      { refund: { ...detail().refund, returnEventType: 'returned', ...refund } },
    )

  it('passes a submitted PAYOUT_FAILED row with a recorded return and a free claim', () => {
    expect(refundPreflight(failed())).toEqual({ blockers: [] })
  })

  it('passes a pre-submit row with NO return event (#254: nothing to return)', () => {
    expect(
      refundPreflight(failed({ returnEventType: null }, { providerTransferRef: null })),
    ).toEqual({ blockers: [] })
  })

  it('blocks a submitted row with no recorded return event', () => {
    expect(refundPreflight(failed({ returnEventType: null }))).toEqual({
      blockers: ['no_return_event'],
    })
  })

  it('blocks on a live or abandoned claim', () => {
    expect(refundPreflight(failed({ claimStatus: 'claimed' }))).toEqual({ blockers: ['claim_live'] })
    expect(refundPreflight(failed({ claimStatus: 'abandoned' }))).toEqual({
      blockers: ['claim_abandoned'],
    })
  })

  it('blocks any state other than PAYOUT_FAILED', () => {
    expect(refundPreflight(detail()).blockers).toContain('not_payout_failed')
  })
})

describe('detailActions', () => {
  it('offers nothing unless the API reports the write capability live', () => {
    expect(detailActions(withTransfer({ payoutHoldReason: 'fx_drift' }, { actionsEnabled: false }))).toEqual([])
    expect(detailActions(withTransfer({ payoutHoldReason: 'fx_drift' }, { actionsEnabled: undefined }))).toEqual([])
  })

  it('offers holdRelease on a releasable hold and refund when preflight passes', () => {
    expect(detailActions(withTransfer({ payoutHoldReason: 'payability' }))).toEqual(['holdRelease'])
    expect(
      detailActions(
        withTransfer(
          { state: 'PAYOUT_FAILED', providerTransferRef: 'br_1' },
          { refund: { ...detail().refund, returnEventType: 'returned' } },
        ),
      ),
    ).toEqual(['refund'])
  })

  it('never offers refund on an abandoned claim — the STOP state has no button', () => {
    expect(
      detailActions(
        withTransfer(
          { state: 'PAYOUT_FAILED', providerTransferRef: 'br_1' },
          { refund: { ...detail().refund, claimStatus: 'abandoned', returnEventType: 'returned' } },
        ),
      ),
    ).toEqual([])
  })
})

describe('opsNoteValid (O-B) — mirrors the API body bound so the 400 is never the first feedback', () => {
  it('accepts 10–500 trimmed chars and rejects outside', () => {
    expect(opsNoteValid('exactly10c')).toBe(true)
    expect(opsNoteValid('   padded to ten   ')).toBe(true)
    expect(opsNoteValid('x'.repeat(500))).toBe(true)
    expect(opsNoteValid('too short')).toBe(false)
    expect(opsNoteValid('         ')).toBe(false)
    expect(opsNoteValid('x'.repeat(501))).toBe(false)
  })
})

describe('write success shapes (O-B)', () => {
  it('hold release: transferId + released + enqueued boolean', () => {
    expect(isOpsHoldReleaseSuccessShape({ transferId: T, outcome: 'released', enqueued: true })).toBe(true)
    expect(isOpsHoldReleaseSuccessShape({ transferId: T, outcome: 'released', enqueued: false })).toBe(true)
    expect(isOpsHoldReleaseSuccessShape({ transferId: T, outcome: 'refunded', enqueued: true })).toBe(false)
    expect(isOpsHoldReleaseSuccessShape({ transferId: T, outcome: 'released' })).toBe(false)
    expect(isOpsHoldReleaseSuccessShape('<html>')).toBe(false)
  })

  it('refund: one of the three outcomes, ledgerComplete, string keys', () => {
    const ok = { transferId: T, outcome: 'refunded', ledgerComplete: true, ledgerKeys: [`${T}:bridge_return`, `${T}:REFUNDED`] }
    expect(isOpsRefundSuccessShape(ok)).toBe(true)
    expect(isOpsRefundSuccessShape({ ...ok, outcome: 'already_disbursed', ledgerComplete: false })).toBe(true)
    expect(isOpsRefundSuccessShape({ ...ok, outcome: 'already_settled', ledgerKeys: [] })).toBe(true)
    expect(isOpsRefundSuccessShape({ ...ok, outcome: 'released' })).toBe(false)
    expect(isOpsRefundSuccessShape({ ...ok, ledgerComplete: 'yes' })).toBe(false)
    expect(isOpsRefundSuccessShape({ ...ok, ledgerKeys: [1] })).toBe(false)
    expect(isOpsRefundSuccessShape(null)).toBe(false)
  })
})

describe('formatOpsTimestamp', () => {
  it('renders date and time in UTC for both languages, and echoes garbage untouched', () => {
    const en = formatOpsTimestamp('2026-09-08T10:30:00.000Z', 'en')
    const es = formatOpsTimestamp('2026-09-08T10:30:00.000Z', 'es')
    expect(en).toMatch(/2026/)
    expect(en).toMatch(/10:30/)
    expect(en).toMatch(/UTC/)
    expect(es).toMatch(/2026/)
    expect(formatOpsTimestamp('not a date', 'en')).toBe('not a date')
  })
})

// Slice 2: the transfer's history is optional (deploy skew) but well-formed
// when present; the note and the derived changes ride here and only here.
describe('activity history tolerance (slice 2)', () => {
  const row = {
    id: 'act-1',
    createdAt: '2026-09-09T12:00:00.000Z',
    actor: 'ops:u1',
    action: 'refund',
    transferId: T,
    reason: 'refunded',
    note: 'Verified by phone.',
    changes: [{ key: 'state', before: 'PAYOUT_FAILED', after: 'REFUNDED' }],
    requestId: 'req-1',
  }

  it('accepts an absent history and an empty one', () => {
    expect(isOpsTransferDetailShape(detail())).toBe(true)
    expect(isOpsTransferDetailShape(detail({ activity: [] }))).toBe(true)
    expect(activityRows(detail())).toEqual([])
  })

  it('passes well-formed rows through and rejects malformed ones', () => {
    expect(isOpsTransferDetailShape(detail({ activity: [row] }))).toBe(true)
    expect(activityRows(detail({ activity: [row] }))).toEqual([row])
    expect(isOpsTransferDetailShape({ ...detail(), activity: [{ ...row, changes: [{ key: 1 }] }] })).toBe(false)
  })
})
