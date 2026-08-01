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
let runsResult: { data: unknown; error: unknown }
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
  funding_cleared: false,
  payout_hold_reason: null,
  disclosure_accepted_at: minutesAgo(90),
  payment_at: minutesAgo(83),
  submit_attempted_at: null,
  cancellation_requested_at: null,
  created_at: minutesAgo(95),
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
  runsResult = { data: [], error: null }
  transfersIn = vi.fn()
  from.mockImplementation((table: string) => {
    if (table === 'transfers') return chain(() => transfersResult)
    if (table === 'reconciliation_runs') return chain(() => runsResult)
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
    // The open-transfers select sweeps exactly the pager's states.
    expect(transfersIn).toHaveBeenCalledWith('state', ['FUNDED', 'SUBMITTED', 'IN_FLIGHT', 'UNDER_REVIEW'])
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
      enteredStateAt: minutesAgo(200), // cancel tap does NOT reset a FUNDED clock
      dwellMinutes: 200,
      thresholdMinutes: 15,
      overThreshold: true,
      holdReason: 'velocity_review',
      fundingCleared: false,
      submitAttempted: false,
      cancellationRequested: true,
    })
    expect(overview.openTransfers[2]).toMatchObject({
      transferId: 't-2',
      dwellMinutes: 10,
      thresholdMinutes: 30,
      overThreshold: false,
      submitAttempted: true,
    })
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
  })

  it('throws at the PostgREST cap on the open-transfers sweep', async () => {
    transfersResult = {
      data: Array.from({ length: 1000 }, (_, i) => openRow({ id: `t-${i}` })),
      error: null,
    }
    await expect(buildOpsOverview()).rejects.toThrow(/1000-row PostgREST cap/)
  })
})
