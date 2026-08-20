import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

// The 8.5-v1 ops overview aggregate. Harness: per-table chain mocks + frozen
// clock (stuck-watch/reconciliation style); the panel seams (pending reviews,
// float ceiling, ledger balance) are mocked so each panel's mapping and
// fail-closed posture is pinned independently. stuck-watch's coarseAnchor/
// thresholdMs are REAL — the page must tick with the pager's own clocks.

const from = vi.fn()
const rpc = vi.fn()
vi.mock('./supabase.js', () => ({
  supabaseAdmin: {
    from: (...args: unknown[]) => from(...args),
    rpc: (...args: unknown[]) => rpc(...args),
  },
}))

const envMock = vi.hoisted(() => ({
  STUCK_FUNDED_AFTER_MINUTES: 15,
  STUCK_SUBMITTED_AFTER_MINUTES: 30,
  STUCK_IN_FLIGHT_AFTER_MINUTES: 60,
  STUCK_UNDER_REVIEW_AFTER_HOURS: 24,
  MANUAL_PENDING_MAX_AGE_DAYS: 7,
  FLOAT_CEILING_MINOR: undefined as number | undefined,
}))
vi.mock('../config/env.js', () => ({ env: envMock }))

const listPendingReviews = vi.hoisted(() => vi.fn())
vi.mock('./cancellation-review.js', () => ({
  listPendingReviews: (...args: unknown[]) => listPendingReviews(...args),
}))

const isFloatCeilingTripped = vi.hoisted(() => vi.fn())
vi.mock('./payouts.js', () => ({
  isFloatCeilingTripped: (...args: unknown[]) => isFloatCeilingTripped(...args),
}))

const getAccountBalance = vi.hoisted(() => vi.fn())
vi.mock('./ledger.js', () => ({
  getAccountBalance: (...args: unknown[]) => getAccountBalance(...args),
}))

const { buildOpsOverview } = await import('./ops-overview.js')

const NOW = new Date('2026-08-01T12:00:00.000Z')
const nowMs = NOW.getTime()
const minutesAgo = (m: number) => new Date(nowMs - m * 60_000).toISOString()

let transfersResult: { data: unknown; error: unknown }
let instructionsResult: { data: unknown; error: unknown }
let runsResult: { data: unknown; error: unknown }
let heartbeatResult: { data: unknown; error: unknown }
let transfersIn: ReturnType<typeof vi.fn>

function chain(resolveFn: () => { data: unknown; error: unknown }) {
  const c: Record<string, unknown> = {}
  for (const m of ['select', 'limit', 'order', 'eq']) c[m] = vi.fn().mockReturnValue(c)
  c['in'] = transfersIn.mockReturnValue(c)
  c['then'] = (res: (v: unknown) => unknown, rej: (e: unknown) => unknown) =>
    Promise.resolve(resolveFn()).then(res, rej)
  return c
}

const openRow = (over: Record<string, unknown> = {}) => ({
  id: 't-1',
  user_id: 'u-1',
  state: 'FUNDED',
  send_amount_minor: 30_000,
  fee_amount_minor: 500,
  funding_cleared: false,
  payout_hold_reason: null,
  disclosure_accepted_at: minutesAgo(90),
  payment_at: minutesAgo(83),
  submit_attempted_at: null,
  cancellation_requested_at: null,
  created_at: minutesAgo(95),
  funding_payment_ref: 'manualpay_ref-1',
  ...over,
})

const runRow = (over: Record<string, unknown> = {}) => ({
  created_at: '2026-08-01T06:00:04.000Z',
  status: 'findings',
  findings_count: 2,
  checks: [
    { name: 'ledger_net_zero', status: 'pass', findings_count: 0 },
    { name: 'bridge_wallet_float', status: 'findings', findings_count: 2, summary: { diffMinor: -500 } },
    { name: 'stripe_receivables', status: 'error', findings_count: 0, error: 'stripe timeout' },
  ],
  balances: {
    funding_receivable: { amount_minor: 123_400, currency: 'USD' },
    cash_clearing: { amount_minor: -199, currency: 'USD' },
  },
  ...over,
})

beforeEach(() => {
  from.mockReset()
  rpc.mockReset().mockResolvedValue({ data: [{ state: 'COMPLETED', count: 87 }], error: null })
  listPendingReviews.mockReset().mockResolvedValue([])
  isFloatCeilingTripped.mockReset().mockResolvedValue({ tripped: false, balanceMinor: 0, ceilingMinor: 100 })
  getAccountBalance.mockReset().mockResolvedValue({ amountMinor: 0, currency: 'USD' })
  envMock.FLOAT_CEILING_MINOR = undefined
  transfersResult = { data: [], error: null }
  instructionsResult = { data: [], error: null }
  runsResult = { data: [], error: null }
  heartbeatResult = { data: [], error: null }
  transfersIn = vi.fn()
  from.mockImplementation((table: string) => {
    if (table === 'transfers') return chain(() => transfersResult)
    if (table === 'deposit_instructions') return chain(() => instructionsResult)
    if (table === 'reconciliation_runs') return chain(() => runsResult)
    if (table === 'worker_heartbeat') return chain(() => heartbeatResult)
    throw new Error(`unexpected supabase.from('${table}')`)
  })
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(NOW)
})

afterEach(() => {
  vi.useRealTimers()
})

describe('buildOpsOverview', () => {
  it('renders an empty world: no queues, unconfigured float with live balance, null balances', async () => {
    getAccountBalance.mockResolvedValue({ amountMinor: 4200, currency: 'USD' })

    const overview = await buildOpsOverview()

    expect(overview.generatedAt).toBe(NOW.toISOString())
    expect(overview.pendingCancellations).toEqual([])
    expect(overview.openTransfers).toEqual([])
    expect(overview.floatCeiling).toEqual({
      configured: false,
      tripped: null,
      balanceMinor: 4200,
      ceilingMinor: null,
    })
    expect(getAccountBalance).toHaveBeenCalledWith('funding_receivable')
    expect(isFloatCeilingTripped).not.toHaveBeenCalled()
    expect(overview.transferCounts).toEqual([{ state: 'COMPLETED', count: 87 }])
    expect(rpc).toHaveBeenCalledWith('ops_transfer_state_counts')
    expect(overview.ledgerBalances).toBeNull()
    expect(overview.reconciliationRuns).toEqual([])
    // The open-transfers select sweeps the pager's states PLUS
    // PENDING_PAYMENT (board-only — the pager itself stays untouched).
    expect(transfersIn).toHaveBeenCalledWith('state', [
      'PENDING_PAYMENT',
      'FUNDED',
      'SUBMITTED',
      'IN_FLIGHT',
      'UNDER_REVIEW',
    ])
  })

  it('maps open transfers with the pager clocks and sorts by dwell descending', async () => {
    transfersResult = {
      data: [
        openRow(), // FUNDED 83m > 15m threshold → over
        openRow({
          id: 't-2',
          state: 'SUBMITTED',
          payment_at: minutesAgo(20),
          submit_attempted_at: minutesAgo(10),
        }), // SUBMITTED 10m < 30m → under
        openRow({
          id: 't-3',
          payout_hold_reason: 'velocity_review',
          created_at: minutesAgo(210),
          payment_at: minutesAgo(200),
          cancellation_requested_at: minutesAgo(5),
        }), // held FUNDED — still listed, annotated, over threshold
      ],
      error: null,
    }

    const overview = await buildOpsOverview()

    expect(overview.openTransfers.map((t) => t.transferId)).toEqual(['t-3', 't-1', 't-2'])
    expect(overview.openTransfers[0]).toEqual({
      transferId: 't-3',
      state: 'FUNDED',
      sendAmountMinor: 30_000,
      feeAmountMinor: 500,
      enteredStateAt: minutesAgo(200), // cancel tap does NOT reset a FUNDED clock
      dwellMinutes: 200,
      thresholdMinutes: 15,
      overThreshold: true,
      holdReason: 'velocity_review',
      fundingCleared: false,
      submitAttempted: false,
      cancellationRequested: true,
      fundingInitiated: true,
      onrampRef: null,
    })
    expect(overview.openTransfers[2]).toMatchObject({
      transferId: 't-2',
      dwellMinutes: 10,
      thresholdMinutes: 30,
      overThreshold: false,
      submitAttempted: true,
    })
  })

  it('shows PENDING_PAYMENT rows on the board with the reconcile-pending clock, not the pager clock', async () => {
    transfersResult = {
      data: [
        openRow({
          id: 't-pp',
          state: 'PENDING_PAYMENT',
          // A confirmed-but-unpaid manual transfer: no payment yet, no payout.
          payment_at: null,
          funding_payment_ref: 'manualpay_pp',
          created_at: minutesAgo(60 * 24 * 2), // 2 days old
        }),
      ],
      error: null,
    }

    const overview = await buildOpsOverview()

    expect(overview.openTransfers[0]).toMatchObject({
      transferId: 't-pp',
      state: 'PENDING_PAYMENT',
      enteredStateAt: minutesAgo(60 * 24 * 2), // dwell anchors on creation
      dwellMinutes: 60 * 24 * 2,
      thresholdMinutes: 7 * 24 * 60, // MANUAL_PENDING_MAX_AGE_DAYS, not a pager knob
      overThreshold: false, // 2 days into a 7-day window is NORMAL for ACH
      fundingInitiated: true,
      onrampRef: null,
    })
  })

  it('flags a PENDING_PAYMENT row past the abandonment window', async () => {
    transfersResult = {
      data: [
        openRow({
          id: 't-old',
          state: 'PENDING_PAYMENT',
          payment_at: null,
          created_at: minutesAgo(60 * 24 * 8), // 8 days > the 7-day window
        }),
      ],
      error: null,
    }

    const overview = await buildOpsOverview()

    expect(overview.openTransfers[0]).toMatchObject({ transferId: 't-old', overThreshold: true })
  })

  it('maps onramp refs from deposit_instructions and reports unconfirmed rows', async () => {
    transfersResult = {
      data: [
        openRow({ id: 't-attached', state: 'PENDING_PAYMENT', payment_at: null }),
        openRow({
          id: 't-bare',
          state: 'PENDING_PAYMENT',
          payment_at: null,
          funding_payment_ref: null, // not confirmed yet — nothing to act on
        }),
      ],
      error: null,
    }
    instructionsResult = {
      data: [{ transfer_id: 't-attached', bridge_transfer_ref: 'onramp-bridge-1' }],
      error: null,
    }

    const overview = await buildOpsOverview()
    const byId = new Map(overview.openTransfers.map((t) => [t.transferId, t]))

    expect(byId.get('t-attached')).toMatchObject({
      onrampRef: 'onramp-bridge-1',
      fundingInitiated: true,
    })
    expect(byId.get('t-bare')).toMatchObject({ onrampRef: null, fundingInitiated: false })
  })

  it('fails closed when the deposit_instructions lookup breaks', async () => {
    transfersResult = { data: [openRow()], error: null }
    instructionsResult = { data: null, error: { message: 'boom' } }

    await expect(buildOpsOverview()).rejects.toThrow(/deposit-instructions select failed/)
  })

  it('skips the deposit_instructions lookup entirely when there are no open transfers', async () => {
    await buildOpsOverview()

    expect(from).not.toHaveBeenCalledWith('deposit_instructions')
  })

  it('maps pending cancellations to the camelCase wire shape', async () => {
    listPendingReviews.mockResolvedValue([
      {
        transfer_id: 't-9',
        state: 'UNDER_REVIEW',
        send_amount_minor: 50_000,
        fee_amount_minor: 550,
        requested_at: minutesAgo(30),
        within_window: false,
        refund_payment_ref: null,
      },
    ])

    const overview = await buildOpsOverview()

    expect(overview.pendingCancellations).toEqual([
      {
        transferId: 't-9',
        state: 'UNDER_REVIEW',
        sendAmountMinor: 50_000,
        feeAmountMinor: 550,
        requestedAt: minutesAgo(30),
        withinWindow: false,
        refundPaymentRef: null,
      },
    ])
  })

  it('uses the real float check when the ceiling is configured', async () => {
    envMock.FLOAT_CEILING_MINOR = 500_000
    isFloatCeilingTripped.mockResolvedValue({ tripped: true, balanceMinor: 500_100, ceilingMinor: 500_000 })

    const overview = await buildOpsOverview()

    expect(overview.floatCeiling).toEqual({
      configured: true,
      tripped: true,
      balanceMinor: 500_100,
      ceilingMinor: 500_000,
    })
    expect(getAccountBalance).not.toHaveBeenCalled()
  })

  it('maps recon runs, strips check summaries, and lifts the latest balances snapshot', async () => {
    runsResult = { data: [runRow(), runRow({ created_at: '2026-07-31T06:00:00.000Z', status: 'pass', findings_count: 0, checks: [] })], error: null }

    const overview = await buildOpsOverview()

    expect(overview.reconciliationRuns).toHaveLength(2)
    expect(overview.reconciliationRuns[0]).toEqual({
      createdAt: '2026-08-01T06:00:04.000Z',
      status: 'findings',
      findingsCount: 2,
      checks: [
        { name: 'ledger_net_zero', status: 'pass', findingsCount: 0 },
        // summary objects never reach this wire — counts and refs only
        { name: 'bridge_wallet_float', status: 'findings', findingsCount: 2 },
        { name: 'stripe_receivables', status: 'error', findingsCount: 0, error: 'stripe timeout' },
      ],
    })
    expect(overview.ledgerBalances).toEqual({
      asOf: '2026-08-01T06:00:04.000Z',
      balances: [
        { code: 'cash_clearing', amountMinor: -199, currency: 'USD' },
        { code: 'funding_receivable', amountMinor: 123_400, currency: 'USD' },
      ],
    })
  })

  it('falls back to the newest run WITH a snapshot when the latest lost its balances check', async () => {
    // A run whose account_balances check failed persists balances '{}' — the
    // snapshot must come from the older healthy run, never render as an
    // empty-but-healthy card (review finding).
    runsResult = {
      data: [
        runRow({ created_at: '2026-08-02T06:00:00.000Z', status: 'error', balances: {} }),
        runRow(),
      ],
      error: null,
    }
    const overview = await buildOpsOverview()
    expect(overview.ledgerBalances?.asOf).toBe('2026-08-01T06:00:04.000Z')
    expect(overview.ledgerBalances?.balances.length).toBeGreaterThan(0)

    // No run carries a snapshot at all → null (the page's empty state).
    runsResult = { data: [runRow({ balances: {} })], error: null }
    expect((await buildOpsOverview()).ledgerBalances).toBeNull()
  })

  it('fails CLOSED on any broken panel read', async () => {
    transfersResult = { data: null, error: { message: 'db down' } }
    await expect(buildOpsOverview()).rejects.toThrow(/open-transfers select failed: db down/)

    transfersResult = { data: [], error: null }
    runsResult = { data: null, error: null }
    await expect(buildOpsOverview()).rejects.toThrow(/reconciliation-runs select failed: no rows returned/)

    runsResult = { data: [], error: null }
    rpc.mockResolvedValue({ data: null, error: { message: 'rpc missing' } })
    await expect(buildOpsOverview()).rejects.toThrow(/transfer-counts rpc failed: rpc missing/)

    rpc.mockResolvedValue({ data: [], error: null })
    heartbeatResult = { data: null, error: { message: 'heartbeat gone' } }
    await expect(buildOpsOverview()).rejects.toThrow(
      /worker-heartbeat select failed: heartbeat gone/,
    )
  })

  it('marks a recent beat live and an old one stale', async () => {
    heartbeatResult = {
      data: [
        { worker: 'worker', updated_at: minutesAgo(2) },
        { worker: 'payout-worker', updated_at: minutesAgo(40) },
      ],
      error: null,
    }

    const overview = await buildOpsOverview()

    expect(overview.workerHeartbeats).toEqual([
      { worker: 'worker', beatAt: minutesAgo(2), ageSeconds: 120, stale: false },
      { worker: 'payout-worker', beatAt: minutesAgo(40), ageSeconds: 2400, stale: true },
    ])
  })

  it('holds the stale threshold at 15 minutes — the same arithmetic the pager uses', async () => {
    // The Sentry monitor opens an issue after 3 missed 5-minute beats. If this
    // boundary drifts, the board and the pager start disagreeing about whether
    // the worker is alive, which is worse than either signal alone.
    heartbeatResult = {
      data: [
        { worker: 'at-boundary', updated_at: minutesAgo(15) },
        { worker: 'just-past', updated_at: new Date(nowMs - (15 * 60_000 + 1000)).toISOString() },
      ],
      error: null,
    }

    const overview = await buildOpsOverview()

    expect(overview.workerHeartbeats.map((b) => b.stale)).toEqual([false, true])
  })

  it('reports no beats as an empty array, never as a healthy board', async () => {
    heartbeatResult = { data: [], error: null }

    const overview = await buildOpsOverview()

    // Empty is the truthful pre-first-beat state; the web side renders it as
    // "no heartbeat recorded yet", not as a passing check.
    expect(overview.workerHeartbeats).toEqual([])
  })

  it('throws at the PostgREST cap on the open-transfers sweep', async () => {
    transfersResult = {
      data: Array.from({ length: 1000 }, (_, i) => openRow({ id: `t-${i}` })),
      error: null,
    }
    await expect(buildOpsOverview()).rejects.toThrow(/1000-row PostgREST cap/)
  })
})
