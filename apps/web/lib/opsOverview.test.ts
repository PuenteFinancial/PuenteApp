import { describe, it, expect } from 'vitest'
import {
  formatBalance,
  isOpsOverviewShape,
  latestSkipped,
  heldTransfers,
  agingReviews,
  latestRun,
  latestFindings,
  isOpsResolveSuccessShape,
  isOpsTransferFundingSuccessShape,
  isOpsAttachSuccessShape,
  transferActions,
  isOpsFloatTopUpSuccessShape,
  resolveErrorKind,
  firstDetailIssue,
  workerHeartbeatAlarm,
  stalestHeartbeat,
  type OpsOverview,
  type OpsOpenTransfer,
  type OpsWorkerHeartbeat,
} from './opsOverview'

const openTransfer = (over: Partial<OpsOpenTransfer> = {}): OpsOpenTransfer => ({
  transferId: 't-1',
  state: 'FUNDED',
  sendAmountMinor: 30_000,
  enteredStateAt: '2026-08-01T10:00:00.000Z',
  dwellMinutes: 20,
  thresholdMinutes: 15,
  overThreshold: true,
  holdReason: null,
  fundingCleared: false,
  submitAttempted: false,
  cancellationRequested: false,
  ...over,
})

const beat = (over: Partial<OpsWorkerHeartbeat> = {}): OpsWorkerHeartbeat => ({
  worker: 'worker',
  beatAt: '2026-08-01T11:58:00.000Z',
  ageSeconds: 120,
  stale: false,
  ...over,
})

const overview = (over: Partial<OpsOverview> = {}): OpsOverview => ({
  generatedAt: '2026-08-01T12:00:00.000Z',
  pendingCancellations: [],
  openTransfers: [],
  floatCeiling: { configured: false, tripped: null, balanceMinor: 0, ceilingMinor: null },
  transferCounts: [],
  ledgerBalances: null,
  reconciliationRuns: [],
  ...over,
})

describe('isOpsOverviewShape', () => {
  it('accepts a well-formed payload (empty world and populated)', () => {
    expect(isOpsOverviewShape(overview())).toBe(true)
    expect(
      isOpsOverviewShape(
        overview({
          openTransfers: [openTransfer()],
          ledgerBalances: { asOf: 'x', balances: [] },
        }),
      ),
    ).toBe(true)
  })

  it('rejects contract violations rather than rendering a healthy empty board', () => {
    expect(isOpsOverviewShape(null)).toBe(false)
    expect(isOpsOverviewShape('<html>gateway error</html>')).toBe(false)
    expect(isOpsOverviewShape({})).toBe(false)
    expect(isOpsOverviewShape({ ...overview(), openTransfers: 'nope' })).toBe(false)
    expect(isOpsOverviewShape({ ...overview(), floatCeiling: {} })).toBe(false)
    expect(isOpsOverviewShape({ ...overview(), ledgerBalances: 'stale' })).toBe(false)
    expect(isOpsOverviewShape({ ...overview(), workerHeartbeats: 'nope' })).toBe(false)
  })

  it('tolerates workerHeartbeats being absent (API predating Workstream A)', () => {
    // Deploy skew must degrade to a missing panel, never to a blanked board.
    expect(isOpsOverviewShape(overview())).toBe(true)
    expect(isOpsOverviewShape(overview({ workerHeartbeats: [] }))).toBe(true)
    expect(isOpsOverviewShape(overview({ workerHeartbeats: [beat()] }))).toBe(true)
  })
})

describe('derivations', () => {
  it('heldTransfers filters on holdReason presence', () => {
    const o = overview({
      openTransfers: [
        openTransfer(),
        openTransfer({ transferId: 't-2', holdReason: 'velocity_review' }),
      ],
    })
    expect(heldTransfers(o).map((t) => t.transferId)).toEqual(['t-2'])
  })

  it('agingReviews = UNDER_REVIEW past threshold only', () => {
    const o = overview({
      openTransfers: [
        openTransfer({ transferId: 't-r1', state: 'UNDER_REVIEW', overThreshold: true }),
        openTransfer({ transferId: 't-r2', state: 'UNDER_REVIEW', overThreshold: false }),
        openTransfer({ transferId: 't-f', state: 'FUNDED', overThreshold: true }),
      ],
    })
    expect(agingReviews(o).map((t) => t.transferId)).toEqual(['t-r1'])
  })

  it('latestRun / latestFindings read the first (newest) run and its non-pass checks', () => {
    const o = overview({
      reconciliationRuns: [
        {
          createdAt: '2026-08-01T06:00:00.000Z',
          status: 'findings',
          findingsCount: 2,
          checks: [
            { name: 'ledger_net_zero', status: 'pass', findingsCount: 0 },
            { name: 'bridge_wallet_float', status: 'findings', findingsCount: 2 },
            { name: 'stripe_receivables', status: 'error', findingsCount: 0, error: 'timeout' },
            { name: 'stripe_orphans', status: 'skipped', findingsCount: 0 },
          ],
        },
        { createdAt: '2026-07-31T06:00:00.000Z', status: 'pass', findingsCount: 0, checks: [] },
      ],
    })
    expect(latestRun(o)?.createdAt).toBe('2026-08-01T06:00:00.000Z')
    expect(latestFindings(o).map((c) => c.name)).toEqual(['bridge_wallet_float', 'stripe_receivables'])
    expect(latestFindings(overview())).toEqual([])
    // Skipped is not a finding — but it must surface separately, never vanish
    // into "latest run was clean" (review finding).
    expect(latestSkipped(o).map((c) => c.name)).toEqual(['stripe_orphans'])
    expect(latestSkipped(overview())).toEqual([])
  })
})

describe('formatBalance', () => {
  it('formats per the wire currency — never assumes USD (codex finding)', () => {
    expect(formatBalance(50_000, 'USD')).toBe('$500.00')
    expect(formatBalance(50_000, 'MXN')).toBe('500.00 MXN')
    expect(formatBalance(123_456, 'EUR')).toBe('1234.56 EUR')
  })
})

describe('actionsEnabled tolerance (slice 8.5-v1.1)', () => {
  it('accepts payloads with and without actionsEnabled (deploy skew)', () => {
    expect(isOpsOverviewShape(overview())).toBe(true)
    expect(isOpsOverviewShape({ ...overview(), actionsEnabled: true })).toBe(true)
    expect(isOpsOverviewShape({ ...overview(), actionsEnabled: false })).toBe(true)
  })

  it('rejects a non-boolean actionsEnabled', () => {
    expect(isOpsOverviewShape({ ...overview(), actionsEnabled: 'yes' })).toBe(false)
  })
})

describe('isOpsResolveSuccessShape', () => {
  it('accepts the four success outcomes', () => {
    for (const outcome of ['refunded', 'denied', 'already_disbursed', 'already_refunded']) {
      expect(isOpsResolveSuccessShape({ transferId: 't-1', outcome })).toBe(true)
    }
  })

  it('rejects anything else', () => {
    expect(isOpsResolveSuccessShape(null)).toBe(false)
    expect(isOpsResolveSuccessShape({})).toBe(false)
    expect(isOpsResolveSuccessShape({ transferId: 't-1', outcome: 'ok' })).toBe(false)
    expect(isOpsResolveSuccessShape({ outcome: 'refunded' })).toBe(false)
  })
})

describe('resolveErrorKind', () => {
  const envelope = (code: string, issue?: string) => ({
    error: { code, message: 'x', requestId: 'r', ...(issue && { details: [{ path: 'depositedAt', issue }] }) },
  })

  it('classifies each ops refusal onto its own UI branch', () => {
    expect(resolveErrorKind(409, envelope('claim_abandoned'))).toBe('claim_abandoned')
    expect(resolveErrorKind(409, envelope('refund_owed'))).toBe('refund_owed')
    expect(resolveErrorKind(409, envelope('deposit_evidence_conflict'))).toBe('evidence_conflict')
    expect(resolveErrorKind(409, envelope('conflict'))).toBe('conflict')
    expect(resolveErrorKind(409, envelope('idempotency_conflict'))).toBe('conflict')
    expect(resolveErrorKind(404, envelope('not_found'))).toBe('not_found')
    expect(resolveErrorKind(400, envelope('validation_error'))).toBe('validation')
  })

  it('falls back to generic for unknown statuses, codes, and non-envelope bodies', () => {
    expect(resolveErrorKind(500, envelope('internal_error'))).toBe('generic')
    expect(resolveErrorKind(409, envelope('something_new'))).toBe('generic')
    expect(resolveErrorKind(409, '<html>gateway</html>')).toBe('generic')
    expect(resolveErrorKind(400, null)).toBe('validation')
  })

  it('firstDetailIssue surfaces the evidence bounds, or null', () => {
    expect(firstDetailIssue(envelope('deposit_evidence_conflict', 'must lie between A and B'))).toBe(
      'must lie between A and B',
    )
    expect(firstDetailIssue(envelope('conflict'))).toBe(null)
    expect(firstDetailIssue(null)).toBe(null)
  })
})

describe('worker heartbeat derivations', () => {
  it('workerHeartbeatAlarm is false when absent, empty, or all fresh', () => {
    // Absent is the deploy-skew case: "not reported" must not read as an
    // alarm, or every deploy of the web ahead of the API would cry wolf.
    expect(workerHeartbeatAlarm(overview())).toBe(false)
    expect(workerHeartbeatAlarm(overview({ workerHeartbeats: [] }))).toBe(false)
    expect(workerHeartbeatAlarm(overview({ workerHeartbeats: [beat(), beat()] }))).toBe(false)
  })

  it('workerHeartbeatAlarm is true when ANY worker is stale', () => {
    // Any, not all: a second worker service going dark must not be masked by a
    // healthy first one.
    const o = overview({
      workerHeartbeats: [beat(), beat({ worker: 'payout-worker', stale: true })],
    })
    expect(workerHeartbeatAlarm(o)).toBe(true)
  })

  it('stalestHeartbeat returns null when absent or empty', () => {
    expect(stalestHeartbeat(overview())).toBeNull()
    expect(stalestHeartbeat(overview({ workerHeartbeats: [] }))).toBeNull()
  })

  it('stalestHeartbeat picks the highest age', () => {
    const o = overview({
      workerHeartbeats: [
        beat({ worker: 'a', ageSeconds: 60 }),
        beat({ worker: 'b', ageSeconds: 3000, stale: true }),
        beat({ worker: 'c', ageSeconds: 900 }),
      ],
    })
    expect(stalestHeartbeat(o)?.worker).toBe('b')
  })
})

describe('transferActions (funding-ops-automation slice 1)', () => {
  // A row from a slice-1 API: action fields present.
  const actionable = (over: Partial<OpsOpenTransfer> = {}): OpsOpenTransfer =>
    openTransfer({ feeAmountMinor: 500, fundingInitiated: true, onrampRef: null, ...over })

  // #244: every action here is an OUT-OF-BAND funding action — the server
  // refuses all three unless the ROW's rail is manual (recordManualFunding →
  // processor_not_manual). Offering them on any other rail is a button whose
  // only possible outcome is a 409, and on the crypto rail the K lane ships
  // that is every row an operator will be looking at during the pilot.
  it('offers nothing on a non-manual rail — the server refuses all three', () => {
    for (const rail of ['stripe', 'stripe_onramp', 'stripe_crypto', 'mock']) {
      expect(transferActions(actionable({ state: 'PENDING_PAYMENT', fundingProcessor: rail }))).toEqual([])
      expect(transferActions(actionable({ state: 'FUNDED', fundingProcessor: rail }))).toEqual([])
    }
  })

  it('still offers them when the row says manual', () => {
    expect(
      transferActions(actionable({ state: 'PENDING_PAYMENT', fundingProcessor: 'manual' })),
    ).toEqual(['attach', 'release'])
    expect(transferActions(actionable({ state: 'FUNDED', fundingProcessor: 'manual' }))).toEqual([
      'depositLanded',
    ])
  })

  // Deploy skew, same posture as the other optional fields: an older API omits
  // the rail. Keep the pre-#244 behaviour rather than blanking the board of a
  // manual-rail operator mid-deploy — the server is the real guard either way.
  it('falls back to offering actions when the API omits the rail', () => {
    expect(transferActions(actionable({ state: 'PENDING_PAYMENT' }))).toEqual(['attach', 'release'])
  })

  it('returns [] on deploy skew — an older API omits the action fields', () => {
    expect(transferActions(openTransfer())).toEqual([])
    expect(transferActions(openTransfer({ state: 'PENDING_PAYMENT' }))).toEqual([])
  })

  it('offers attach + release on a confirmed PENDING_PAYMENT row', () => {
    expect(transferActions(actionable({ state: 'PENDING_PAYMENT' }))).toEqual([
      'attach',
      'release',
    ])
  })

  it('offers NOTHING on an unconfirmed PENDING_PAYMENT row — no ref to act on yet', () => {
    expect(
      transferActions(actionable({ state: 'PENDING_PAYMENT', fundingInitiated: false })),
    ).toEqual([])
  })

  it('offers deposit-landed on released rows until the receivable settles', () => {
    for (const state of ['FUNDED', 'SUBMITTED', 'IN_FLIGHT', 'UNDER_REVIEW']) {
      expect(transferActions(actionable({ state }))).toEqual(['depositLanded'])
      expect(transferActions(actionable({ state, fundingCleared: true }))).toEqual([])
    }
  })
})

describe('transfer action success shapes', () => {
  it('accepts every funding outcome and rejects the rest', () => {
    for (const outcome of ['funded', 'cleared', 'cleared_skipped']) {
      expect(isOpsTransferFundingSuccessShape({ transferId: 't-1', outcome })).toBe(true)
    }
    expect(isOpsTransferFundingSuccessShape({ transferId: 't-1', outcome: 'attached' })).toBe(false)
    expect(isOpsTransferFundingSuccessShape({ outcome: 'funded' })).toBe(false)
    expect(isOpsTransferFundingSuccessShape(null)).toBe(false)
  })

  it('requires the attach shape to carry the reference code', () => {
    expect(
      isOpsAttachSuccessShape({ transferId: 't-1', outcome: 'attached', depositMessage: 'BRGABC' }),
    ).toBe(true)
    expect(isOpsAttachSuccessShape({ transferId: 't-1', outcome: 'attached' })).toBe(false)
    expect(
      isOpsAttachSuccessShape({ transferId: 't-1', outcome: 'funded', depositMessage: 'BRGABC' }),
    ).toBe(false)
  })
})

describe('isOpsFloatTopUpSuccessShape (slice 2)', () => {
  it('accepts the booked shape', () => {
    expect(
      isOpsFloatTopUpSuccessShape({ amountMinor: 10_000, externalRef: 'adhoc:k', floatBalanceMinor: 22_000 }),
    ).toBe(true)
  })

  it('rejects partial or non-record shapes', () => {
    expect(isOpsFloatTopUpSuccessShape({ amountMinor: 10_000, externalRef: 'x' })).toBe(false)
    expect(isOpsFloatTopUpSuccessShape({ amountMinor: '100', externalRef: 'x', floatBalanceMinor: 1 })).toBe(false)
    expect(isOpsFloatTopUpSuccessShape(null)).toBe(false)
    expect(isOpsFloatTopUpSuccessShape('booked')).toBe(false)
  })
})
