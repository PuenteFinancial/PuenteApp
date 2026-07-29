import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

// The aggregate Reg E double-pay trend guard (slice-7 debt pass). Harness
// mirrors reconcile-pending.test.ts (fake Date + per-query chain mocks) with
// the Sentry mock promoted to assertable spies — the alert's exact shape
// (fingerprint, context, severity) IS the contract ops depends on.

const from = vi.fn()

vi.mock('../services/supabase.js', () => ({
  supabaseAdmin: {
    from: (...args: unknown[]) => from(...args),
  },
}))

const envMock = vi.hoisted(() => ({
  LOSS_CORRECTION_ALERT_MINOR: 20_000,
  LOSS_CORRECTION_WINDOW_DAYS: 7,
}))
vi.mock('../config/env.js', () => ({ env: envMock }))

const captureMessage = vi.hoisted(() => vi.fn())
const setFingerprint = vi.hoisted(() => vi.fn())
const setContext = vi.hoisted(() => vi.fn())
vi.mock('@sentry/node', () => ({
  withScope: (fn: (s: unknown) => void) => fn({ setFingerprint, setContext }),
  captureMessage: (...a: unknown[]) => captureMessage(...a),
}))

const { watchLossCorrections } = await import('./correction-watch.js')

const ACCOUNT_ID = 'acct-loss-corr-1'

// Two sequential queries: the account lookup (single) then the windowed
// entries select. Each mock records its filter args for exact-shape asserts.
function mockQueries(
  accountResult: { data: unknown; error: unknown },
  entriesResult: { data: unknown; error: unknown },
) {
  const single = vi.fn().mockResolvedValue(accountResult)
  const accountEq = vi.fn().mockReturnValue({ single })
  const accountSelect = vi.fn().mockReturnValue({ eq: accountEq })

  const gte = vi.fn().mockResolvedValue(entriesResult)
  const entriesEq = vi.fn().mockReturnValue({ gte })
  const entriesSelect = vi.fn().mockReturnValue({ eq: entriesEq })

  from.mockImplementation((table: string) => {
    if (table === 'ledger_accounts') return { select: accountSelect }
    if (table === 'ledger_entries') return { select: entriesSelect }
    throw new Error(`unexpected supabase.from('${table}')`)
  })
  return { accountSelect, accountEq, single, entriesSelect, entriesEq, gte }
}

const account = { data: { id: ACCOUNT_ID }, error: null }
const debit = (amount_minor: number) => ({ amount_minor, direction: 'debit' as const })
const credit = (amount_minor: number) => ({ amount_minor, direction: 'credit' as const })

beforeEach(() => {
  from.mockReset()
  captureMessage.mockReset()
  setFingerprint.mockReset()
  setContext.mockReset()
  envMock.LOSS_CORRECTION_ALERT_MINOR = 20_000
  envMock.LOSS_CORRECTION_WINDOW_DAYS = 7
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(new Date('2026-07-29T12:00:00.000Z'))
})

afterEach(() => vi.useRealTimers())

describe('watchLossCorrections', () => {
  it('looks the account up by code and windows the entries select on the cutoff', async () => {
    const { accountSelect, accountEq, entriesSelect, entriesEq, gte } = mockQueries(account, {
      data: [],
      error: null,
    })

    const count = await watchLossCorrections()

    expect(count).toBe(0)
    expect(accountSelect).toHaveBeenCalledWith('id')
    expect(accountEq).toHaveBeenCalledWith('code', 'loss_cancellation_correction')
    expect(entriesSelect).toHaveBeenCalledWith('amount_minor, direction')
    expect(entriesEq).toHaveBeenCalledWith('account_id', ACCOUNT_ID)
    // 7 rolling days before the frozen clock — the exact string, not a matcher.
    expect(gte).toHaveBeenCalledWith('created_at', '2026-07-22T12:00:00.000Z')
  })

  it('an empty window alerts nothing and returns 0', async () => {
    mockQueries(account, { data: [], error: null })

    await expect(watchLossCorrections()).resolves.toBe(0)
    expect(captureMessage).not.toHaveBeenCalled()
  })

  it('sums across entries and a credit SUBTRACTS (signed, normal-balance convention)', async () => {
    // 150 + 100 − 60 = 190 < 200 → silent despite 250 gross debits: a posted
    // reversal means the money came back, and the guard must not keep alarming
    // on a loss that was clawed back.
    mockQueries(account, {
      data: [debit(15_000), debit(10_000), credit(6_000)],
      error: null,
    })

    await expect(watchLossCorrections()).resolves.toBe(3)
    expect(captureMessage).not.toHaveBeenCalled()
  })

  it('fires AT the threshold, not only above it', async () => {
    mockQueries(account, { data: [debit(20_000)], error: null })

    await watchLossCorrections()

    expect(captureMessage).toHaveBeenCalledTimes(1)
  })

  it('stays silent one minor unit under the threshold', async () => {
    mockQueries(account, { data: [debit(19_999)], error: null })

    await watchLossCorrections()

    expect(captureMessage).not.toHaveBeenCalled()
  })

  it('respects the env threshold and window knobs', async () => {
    envMock.LOSS_CORRECTION_ALERT_MINOR = 5_000
    envMock.LOSS_CORRECTION_WINDOW_DAYS = 1
    const { gte } = mockQueries(account, { data: [debit(5_000)], error: null })

    await watchLossCorrections()

    expect(gte).toHaveBeenCalledWith('created_at', '2026-07-28T12:00:00.000Z')
    expect(captureMessage).toHaveBeenCalledTimes(1)
  })

  it('pages with the exact fingerprint, context, and warning severity', async () => {
    mockQueries(account, { data: [debit(19_801), debit(199), debit(20_000)], error: null })

    await watchLossCorrections()

    expect(setFingerprint).toHaveBeenCalledWith(['loss-correction-threshold'])
    expect(setContext).toHaveBeenCalledWith('loss_correction_threshold', {
      windowDays: 7,
      totalMinor: 40_000,
      thresholdMinor: 20_000,
      correctionCount: 3,
      runbook: 'docs/runbooks/pending-cancellation.md',
    })
    expect(captureMessage).toHaveBeenCalledWith(
      'Reg E correction losses at/above aggregate threshold',
      'warning',
    )
  })

  // Fail CLOSED: a broken read must never present as "no corrections" — the
  // throw reaches worker handle(), which Sentry-captures and lets the next
  // cron tick retry.
  it('throws on an account lookup error', async () => {
    mockQueries({ data: null, error: { message: 'boom' } }, { data: [], error: null })

    await expect(watchLossCorrections()).rejects.toThrow(/account lookup failed: boom/)
    expect(captureMessage).not.toHaveBeenCalled()
  })

  it('throws on an account null-without-error result (missing seed must be loud)', async () => {
    mockQueries({ data: null, error: null }, { data: [], error: null })

    await expect(watchLossCorrections()).rejects.toThrow(/account lookup failed: no row returned/)
  })

  it('throws on an entries select error', async () => {
    mockQueries(account, { data: null, error: { message: 'db down' } })

    await expect(watchLossCorrections()).rejects.toThrow(/entries query failed: db down/)
    expect(captureMessage).not.toHaveBeenCalled()
  })

  it('throws on an entries null-without-error result', async () => {
    mockQueries(account, { data: null, error: null })

    await expect(watchLossCorrections()).rejects.toThrow(/entries query failed: no rows returned/)
  })
})
