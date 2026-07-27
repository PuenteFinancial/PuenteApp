import { describe, it, expect, beforeEach, vi } from 'vitest'

// risk.ts reads env.* at call time, so one mutable stub drives every case
// (mirrors payouts.test.ts). Defaults match config/env.ts (the AML launch limits).
const envStub = vi.hoisted(() => ({
  RISK_PER_TXN_MAX_MINOR: 150_000,
  RISK_DAILY_MAX_MINOR: 150_000,
  RISK_MONTHLY_MAX_MINOR: 300_000,
  RISK_SEMIANNUAL_MAX_MINOR: 1_800_000,
  RISK_VELOCITY_MAX_COUNT: 5,
}))
vi.mock('../config/env.js', () => ({ env: envStub }))

const from = vi.hoisted(() => vi.fn())
vi.mock('./supabase.js', () => ({ supabaseAdmin: { from: (...args: unknown[]) => from(...args) } }))

const { assessTransferRisk } = await import('./risk.js')

interface Row {
  disclosure_accepted_at: string
  send_amount_minor: number
}

// A thenable PostgREST-ish builder: every filter method is a spy returning the
// chain; awaiting resolves the configured result.
type ChainMethod = 'select' | 'eq' | 'not' | 'gte' | 'neq'
type MockChain = Record<ChainMethod, ReturnType<typeof vi.fn>> & {
  then: (resolve: (v: { data: unknown; error: unknown }) => unknown) => unknown
}

function makeChain(result: { data: unknown; error: unknown }): MockChain {
  const chain = {} as MockChain
  for (const m of ['select', 'eq', 'not', 'gte', 'neq'] as ChainMethod[]) {
    chain[m] = vi.fn(() => chain)
  }
  chain.then = (resolve) => resolve(result)
  return chain
}

function seed(rows: Row[]): MockChain {
  const chain = makeChain({ data: rows, error: null })
  from.mockReturnValue(chain)
  return chain
}

const HOUR = 60 * 60 * 1000
const DAY = 24 * HOUR
// A committed send `msAgo` before now, of the given send principal. Historical
// rows may exceed the per-transaction cap — that cap only gates the *new* send,
// and the query already scoped these to the window, so risk.ts trusts them.
const rowAt = (msAgo: number, sendMinor: number): Row => ({
  disclosure_accepted_at: new Date(Date.now() - msAgo).toISOString(),
  send_amount_minor: sendMinor,
})

beforeEach(() => {
  envStub.RISK_PER_TXN_MAX_MINOR = 150_000
  envStub.RISK_DAILY_MAX_MINOR = 150_000
  envStub.RISK_MONTHLY_MAX_MINOR = 300_000
  envStub.RISK_SEMIANNUAL_MAX_MINOR = 1_800_000
  envStub.RISK_VELOCITY_MAX_COUNT = 5
  from.mockReset()
})

describe('assessTransferRisk', () => {
  it('passes when under every cap', async () => {
    seed([rowAt(HOUR, 20_000), rowAt(HOUR, 20_000)]) // 2 sends, $400 today
    await expect(assessTransferRisk({ userId: 'u1', sendAmountMinor: 10_000 })).resolves.toEqual({
      ok: true,
    })
  })

  it('blocks per_transaction over the single-send cap — before any query', async () => {
    await expect(assessTransferRisk({ userId: 'u1', sendAmountMinor: 150_001 })).resolves.toEqual({
      ok: false,
      reason: 'per_transaction',
    })
    expect(from).not.toHaveBeenCalled() // a property of this send alone; no history read
  })

  it('allows a send exactly at the per-transaction cap', async () => {
    seed([]) // no history
    await expect(assessTransferRisk({ userId: 'u1', sendAmountMinor: 150_000 })).resolves.toEqual({
      ok: true,
    })
  })

  it('blocks daily when today’s sends + this one exceed the daily cap (== ok, +1 over)', async () => {
    seed([rowAt(HOUR, 140_000)]) // $1,400 today
    await expect(assessTransferRisk({ userId: 'u1', sendAmountMinor: 10_000 })).resolves.toEqual({
      ok: true,
    }) // == $1,500
    seed([rowAt(HOUR, 140_000)])
    await expect(assessTransferRisk({ userId: 'u1', sendAmountMinor: 10_001 })).resolves.toEqual({
      ok: false,
      reason: 'daily',
    })
  })

  it('blocks monthly on sends within 30d but not today (daily stays under)', async () => {
    seed([rowAt(10 * DAY, 145_000), rowAt(15 * DAY, 145_000)]) // $2,900 this month, $0 today
    await expect(assessTransferRisk({ userId: 'u1', sendAmountMinor: 20_000 })).resolves.toEqual({
      ok: false,
      reason: 'monthly',
    }) // month $3,100 > $3,000; day $200 fine
  })

  it('allows a send landing exactly on the monthly cap', async () => {
    seed([rowAt(10 * DAY, 280_000)]) // $2,800 this month, none today
    await expect(assessTransferRisk({ userId: 'u1', sendAmountMinor: 20_000 })).resolves.toEqual({
      ok: true,
    }) // month == $3,000 exactly
  })

  it('blocks semiannual on sends within 180d but not this month', async () => {
    seed([rowAt(60 * DAY, 1_790_000)]) // $17,900 two months ago
    await expect(assessTransferRisk({ userId: 'u1', sendAmountMinor: 20_000 })).resolves.toEqual({
      ok: false,
      reason: 'semiannual',
    }) // 6-month $18,100 > $18,000; day/month fine
  })

  it('allows a send landing exactly on the 6-month cap', async () => {
    seed([rowAt(60 * DAY, 1_780_000)]) // $17,800 in the 6-month window, none this month
    await expect(assessTransferRisk({ userId: 'u1', sendAmountMinor: 20_000 })).resolves.toEqual({
      ok: true,
    }) // 6-month == $18,000 exactly
  })

  it('blocks velocity_count at the per-day send count cap', async () => {
    seed([
      rowAt(HOUR, 100),
      rowAt(HOUR, 100),
      rowAt(HOUR, 100),
      rowAt(HOUR, 100),
      rowAt(HOUR, 100),
    ]) // 5 tiny sends today — dollar caps fine, count at the cap
    await expect(assessTransferRisk({ userId: 'u1', sendAmountMinor: 100 })).resolves.toEqual({
      ok: false,
      reason: 'velocity_count',
    })
  })

  it('allows the last send under the per-day count cap', async () => {
    seed([rowAt(HOUR, 100), rowAt(HOUR, 100), rowAt(HOUR, 100), rowAt(HOUR, 100)]) // 4 today (cap 5)
    await expect(assessTransferRisk({ userId: 'u1', sendAmountMinor: 100 })).resolves.toEqual({
      ok: true,
    }) // this is the 5th — dayCount 4 < 5
  })

  it('does not count sends from earlier days toward the daily count', async () => {
    seed([rowAt(2 * DAY, 100), rowAt(3 * DAY, 100), rowAt(4 * DAY, 100), rowAt(5 * DAY, 100)])
    await expect(assessTransferRisk({ userId: 'u1', sendAmountMinor: 100 })).resolves.toEqual({
      ok: true,
    }) // 0 sends today → under the 5/day count
  })

  it('respects env overrides on the caps', async () => {
    envStub.RISK_DAILY_MAX_MINOR = 50_000
    seed([rowAt(HOUR, 45_000)])
    await expect(assessTransferRisk({ userId: 'u1', sendAmountMinor: 6_000 })).resolves.toEqual({
      ok: false,
      reason: 'daily',
    })
  })

  it('excludes the transfer under consideration when excludeTransferId is set', async () => {
    const chain = seed([])
    await assessTransferRisk({ userId: 'u1', sendAmountMinor: 1_000, excludeTransferId: 't-self' })
    expect(chain.neq).toHaveBeenCalledWith('id', 't-self')
  })

  it('adds no exclusion when excludeTransferId is omitted', async () => {
    const chain = seed([])
    await assessTransferRisk({ userId: 'u1', sendAmountMinor: 1_000 })
    expect(chain.neq).not.toHaveBeenCalled()
  })

  it('scopes to the user, committed-and-not-unwound, within the widest window', async () => {
    const chain = seed([])
    await assessTransferRisk({ userId: 'u-42', sendAmountMinor: 1_000 })
    expect(chain.eq).toHaveBeenCalledWith('user_id', 'u-42')
    expect(chain.not).toHaveBeenCalledWith('disclosure_accepted_at', 'is', null)
    expect(chain.not).toHaveBeenCalledWith(
      'state',
      'in',
      '(PAYMENT_FAILED,CANCELED,REFUNDED,FUNDING_REVERSED)',
    )
    expect(chain.gte).toHaveBeenCalledWith('disclosure_accepted_at', expect.any(String))
  })

  it('throws (fail-closed) when the query errors', async () => {
    const chain = makeChain({ data: null, error: { message: 'boom' } })
    from.mockReturnValue(chain)
    await expect(assessTransferRisk({ userId: 'u1', sendAmountMinor: 1_000 })).rejects.toThrow(
      /risk limit query failed/,
    )
  })

  it('throws (fail-closed) when data is null without an error', async () => {
    const chain = makeChain({ data: null, error: null })
    from.mockReturnValue(chain)
    await expect(assessTransferRisk({ userId: 'u1', sendAmountMinor: 1_000 })).rejects.toThrow(
      /risk limit query failed/,
    )
  })
})
