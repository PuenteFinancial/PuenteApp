import { describe, it, expect, beforeEach, vi } from 'vitest'

// Mutable env stub: payouts.ts reads env.FLOAT_CEILING_MINOR at call time,
// so tests flip it per case without re-importing the module.
const envStub = vi.hoisted(() => ({ FLOAT_CEILING_MINOR: undefined as number | undefined }))
vi.mock('../config/env.js', () => ({ env: envStub }))

const getBalance = vi.hoisted(() => vi.fn())
vi.mock('./ledger.js', () => ({
  getAccountBalance: (...args: unknown[]) => getBalance(...args),
}))

const from = vi.hoisted(() => vi.fn())
vi.mock('./supabase.js', () => ({
  supabaseAdmin: {
    from: (...args: unknown[]) => from(...args),
  },
}))

const {
  submittedLedgerEntries,
  computeDriftBps,
  parseDecimalToMinor,
  minorToDecimal,
  checkPayability,
  isFloatCeilingTripped,
  PayoutValidationError,
} = await import('./payouts.js')

beforeEach(() => {
  envStub.FLOAT_CEILING_MINOR = undefined
  getBalance.mockReset()
  from.mockReset()
})

function netMinor(entries: { direction: string; amount_minor: number }[]): number {
  return entries.reduce(
    (sum, e) => sum + (e.direction === 'debit' ? e.amount_minor : -e.amount_minor),
    0,
  )
}

describe('submittedLedgerEntries', () => {
  it('posts the unfavorable batch (A > S): slippage debited', () => {
    // S = $3960.00 quoted, A = $3960.14 actually drawn -> D = 14 unfavorable
    const entries = submittedLedgerEntries({
      sendAmountMinor: 396000,
      actualSourceAmountMinor: 396014,
    })
    expect(entries).toEqual([
      { account_code: 'due_from_bridge', direction: 'debit', amount_minor: 396000, currency: 'USD' },
      { account_code: 'fx_slippage', direction: 'debit', amount_minor: 14, currency: 'USD' },
      { account_code: 'bridge_wallet_float', direction: 'credit', amount_minor: 396014, currency: 'USD' },
    ])
    expect(netMinor(entries)).toBe(0)
  })

  it('posts the favorable batch (A < S): slippage credited at |D|', () => {
    const entries = submittedLedgerEntries({
      sendAmountMinor: 396000,
      actualSourceAmountMinor: 395980,
    })
    expect(entries).toEqual([
      { account_code: 'due_from_bridge', direction: 'debit', amount_minor: 396000, currency: 'USD' },
      { account_code: 'fx_slippage', direction: 'credit', amount_minor: 20, currency: 'USD' },
      { account_code: 'bridge_wallet_float', direction: 'credit', amount_minor: 395980, currency: 'USD' },
    ])
    expect(netMinor(entries)).toBe(0)
  })

  it('omits the slippage line entirely when A = S', () => {
    const entries = submittedLedgerEntries({
      sendAmountMinor: 396000,
      actualSourceAmountMinor: 396000,
    })
    expect(entries).toHaveLength(2)
    expect(entries.map((e) => e.account_code)).toEqual(['due_from_bridge', 'bridge_wallet_float'])
    expect(netMinor(entries)).toBe(0)
  })

  it('nets to zero with all-positive amounts and >= 2 entries across many S/A pairs', () => {
    // Deterministic pseudo-random walk over both slippage signs and magnitudes.
    let seed = 48271
    const next = () => {
      seed = (seed * 16807) % 2147483647
      return seed
    }
    for (let i = 0; i < 250; i++) {
      const s = (next() % 5_000_000) + 1
      // Slippage from -large to +large, clamped so A stays positive.
      const a = Math.max(1, s + ((next() % 2001) - 1000))
      const entries = submittedLedgerEntries({ sendAmountMinor: s, actualSourceAmountMinor: a })
      expect(netMinor(entries)).toBe(0)
      expect(entries.length).toBeGreaterThanOrEqual(2)
      for (const entry of entries) {
        expect(Number.isInteger(entry.amount_minor)).toBe(true)
        expect(entry.amount_minor).toBeGreaterThan(0)
        expect(entry.currency).toBe('USD')
      }
    }
  })

  it('rejects non-positive and non-integer amounts', () => {
    const call = (s: number, a: number) => () =>
      submittedLedgerEntries({ sendAmountMinor: s, actualSourceAmountMinor: a })
    expect(call(0, 100)).toThrow(PayoutValidationError)
    expect(call(-5, 100)).toThrow(PayoutValidationError)
    expect(call(100, 0)).toThrow(PayoutValidationError)
    expect(call(100, -1)).toThrow(PayoutValidationError)
    expect(call(100.5, 100)).toThrow(PayoutValidationError)
    expect(call(100, 100.5)).toThrow(PayoutValidationError)
    expect(call(NaN, 100)).toThrow(PayoutValidationError)
    expect(call(100, Number.MAX_SAFE_INTEGER + 2)).toThrow(PayoutValidationError)
  })
})

describe('computeDriftBps', () => {
  it('matches hand-computed drift values', () => {
    // |20.100251 - 20| * 10000 / 20 = 50.1255 -> 50 (integer division)
    expect(computeDriftBps('20.100251', '20.000000')).toBe(50)
    // |21 - 20| * 10000 / 20 = 500
    expect(computeDriftBps('21', '20')).toBe(500)
    expect(computeDriftBps('20.100251', '20.100251')).toBe(0)
  })

  it('lands exactly on the 200-bps boundary', () => {
    // |20.40 - 20.00| * 10000 / 20.00 = 200 exactly
    expect(computeDriftBps('20.40', '20.00000000')).toBe(200)
  })

  it('rounds a tiny drift toward zero', () => {
    // 1e-8 absolute drift on a rate of 20 is far below one bp
    expect(computeDriftBps('20.00000001', '20')).toBe(0)
  })

  it('is symmetric when the live rate is below the source rate', () => {
    expect(computeDriftBps('19.6', '20')).toBe(200)
    expect(computeDriftBps('20.4', '20')).toBe(computeDriftBps('19.6', '20'))
  })

  it('rejects malformed, non-positive, or >8dp rates', () => {
    const bad = ['', 'abc', '-5', '2e1', '20.123456789', '20.', '.5', ' 20', '20,1', 'NaN']
    for (const rate of bad) {
      expect(() => computeDriftBps(rate, '20'), `live=${rate}`).toThrow(PayoutValidationError)
      expect(() => computeDriftBps('20', rate), `source=${rate}`).toThrow(PayoutValidationError)
    }
    expect(() => computeDriftBps('0', '20')).toThrow(PayoutValidationError)
    expect(() => computeDriftBps('20', '0')).toThrow(PayoutValidationError)
    expect(() => computeDriftBps('0.00000000', '20')).toThrow(PayoutValidationError)
  })
})

describe('parseDecimalToMinor', () => {
  it('accepts 0, 1, and 2 decimal places', () => {
    expect(parseDecimalToMinor('20')).toBe(2000)
    expect(parseDecimalToMinor('20.1')).toBe(2010)
    expect(parseDecimalToMinor('20.10')).toBe(2010)
    expect(parseDecimalToMinor('3960.14')).toBe(396014)
    expect(parseDecimalToMinor('0')).toBe(0)
    expect(parseDecimalToMinor('0.05')).toBe(5)
  })

  it('rejects >2dp, exponents, negatives, empty, and garbage', () => {
    const bad = ['20.101', '2e1', '-1', '', 'abc', '20.', '.5', 'NaN', 'Infinity', ' 20', '+20', '20,10']
    for (const value of bad) {
      expect(() => parseDecimalToMinor(value), JSON.stringify(value)).toThrow(PayoutValidationError)
    }
  })

  it('rejects amounts beyond safe integer minor units', () => {
    expect(() => parseDecimalToMinor('99999999999999999999')).toThrow(PayoutValidationError)
  })
})

describe('minorToDecimal', () => {
  it('formats exact 2-dp decimal strings', () => {
    expect(minorToDecimal(396014)).toBe('3960.14')
    expect(minorToDecimal(2000)).toBe('20.00')
    expect(minorToDecimal(5)).toBe('0.05')
    expect(minorToDecimal(0)).toBe('0.00')
  })

  it('round-trips through parseDecimalToMinor', () => {
    for (const minor of [0, 1, 5, 99, 100, 2010, 396014, 123456789]) {
      expect(parseDecimalToMinor(minorToDecimal(minor))).toBe(minor)
    }
  })

  it('rejects non-integer and negative input', () => {
    expect(() => minorToDecimal(1.5)).toThrow(PayoutValidationError)
    expect(() => minorToDecimal(-1)).toThrow(PayoutValidationError)
    expect(() => minorToDecimal(NaN)).toThrow(PayoutValidationError)
    expect(() => minorToDecimal(Number.MAX_SAFE_INTEGER + 2)).toThrow(PayoutValidationError)
  })
})

// Mock the single joined payability query:
// from('payout_destinations').select(...).eq('id', ...).maybeSingle()
function mockPayabilityQuery(result: { data: unknown; error: unknown }) {
  const maybeSingle = vi.fn().mockResolvedValue(result)
  const eq = vi.fn().mockReturnValue({ maybeSingle })
  const select = vi.fn().mockReturnValue({ eq })
  from.mockReturnValue({ select })
  return { select, eq, maybeSingle }
}

describe('checkPayability', () => {
  const row = (overrides: Record<string, unknown> = {}) => ({
    status: 'active',
    provider_account_ref: 'ea_123',
    recipients: { status: 'active' },
    ...overrides,
  })

  it('is payable when destination active, recipient active, and provider ref set', async () => {
    const { select, eq } = mockPayabilityQuery({ data: row(), error: null })

    const result = await checkPayability('pd-1')

    expect(result).toEqual({ payable: true, providerAccountRef: 'ea_123' })
    expect(from).toHaveBeenCalledWith('payout_destinations')
    // The recipient status must come from an inner join, not a second query.
    expect(select).toHaveBeenCalledWith('status, provider_account_ref, recipients!inner(status)')
    expect(eq).toHaveBeenCalledWith('id', 'pd-1')
  })

  it('handles the embedded recipient arriving as an array', async () => {
    mockPayabilityQuery({ data: row({ recipients: [{ status: 'active' }] }), error: null })
    await expect(checkPayability('pd-1')).resolves.toEqual({
      payable: true,
      providerAccountRef: 'ea_123',
    })
  })

  it('is not payable when the destination is archived', async () => {
    mockPayabilityQuery({ data: row({ status: 'archived' }), error: null })
    await expect(checkPayability('pd-1')).resolves.toEqual({
      payable: false,
      reason: 'destination_not_active',
    })
  })

  it('is not payable when the recipient is archived', async () => {
    mockPayabilityQuery({ data: row({ recipients: { status: 'archived' } }), error: null })
    await expect(checkPayability('pd-1')).resolves.toEqual({
      payable: false,
      reason: 'recipient_not_active',
    })
  })

  it('is not payable when provider_account_ref is null', async () => {
    mockPayabilityQuery({ data: row({ provider_account_ref: null }), error: null })
    await expect(checkPayability('pd-1')).resolves.toEqual({
      payable: false,
      reason: 'provider_account_ref_missing',
    })
  })

  it('is not payable when the destination row is missing', async () => {
    mockPayabilityQuery({ data: null, error: null })
    await expect(checkPayability('pd-1')).resolves.toEqual({
      payable: false,
      reason: 'destination_not_found',
    })
  })

  it('throws when the query fails (job retries, never submits blind)', async () => {
    mockPayabilityQuery({ data: null, error: { message: 'boom' } })
    await expect(checkPayability('pd-1')).rejects.toThrow(/payability query failed: boom/)
  })
})

describe('isFloatCeilingTripped', () => {
  it('is not tripped below the ceiling', async () => {
    envStub.FLOAT_CEILING_MINOR = 1_000_000
    getBalance.mockResolvedValue({ amountMinor: 999_999, currency: 'USD' })

    await expect(isFloatCeilingTripped()).resolves.toEqual({
      tripped: false,
      balanceMinor: 999_999,
      ceilingMinor: 1_000_000,
    })
    expect(getBalance).toHaveBeenCalledWith('funding_receivable')
  })

  it('trips exactly at the ceiling (>= comparison)', async () => {
    envStub.FLOAT_CEILING_MINOR = 1_000_000
    getBalance.mockResolvedValue({ amountMinor: 1_000_000, currency: 'USD' })

    await expect(isFloatCeilingTripped()).resolves.toEqual({
      tripped: true,
      balanceMinor: 1_000_000,
      ceilingMinor: 1_000_000,
    })
  })

  it('trips above the ceiling', async () => {
    envStub.FLOAT_CEILING_MINOR = 1_000_000
    getBalance.mockResolvedValue({ amountMinor: 1_500_000, currency: 'USD' })

    await expect(isFloatCeilingTripped()).resolves.toEqual({
      tripped: true,
      balanceMinor: 1_500_000,
      ceilingMinor: 1_000_000,
    })
  })

  it('throws loudly when FLOAT_CEILING_MINOR is unset — never skips the control', async () => {
    envStub.FLOAT_CEILING_MINOR = undefined

    await expect(isFloatCeilingTripped()).rejects.toThrow(/FLOAT_CEILING_MINOR is not set/)
    expect(getBalance).not.toHaveBeenCalled()
  })
})
