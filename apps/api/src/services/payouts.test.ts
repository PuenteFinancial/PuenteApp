import { describe, it, expect, beforeEach, vi } from 'vitest'

// Mutable env stub: payouts.ts reads env.FLOAT_CEILING_MINOR at call time,
// so tests flip it per case without re-importing the module. The BRIDGE_*
// fee knobs are read through services/provider-fees.ts by the SUBMITTED
// batch; they default to 0 here so the FX-shape cases below stay about FX,
// and the accrual cases set them explicitly.
const envStub = vi.hoisted(() => ({
  FLOAT_CEILING_MINOR: undefined as number | undefined,
  BRIDGE_SPEI_FEE_MINOR: 0,
  BRIDGE_ORCHESTRATION_BPS: 0,
  FX_MAX_QUOTE_AGE_MINUTES: 240,
  // MXN/SPEI's 50 MXN floor, in receive minor units.
  PAYOUT_MIN_RECEIVE_MINOR: 5_000,
}))
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
  assessQuoteAge,
  isBelowPayoutMinimum,
  payoutMinimumReceiveMinor,
  parseDecimalToMinor,
  minorToDecimal,
  checkPayability,
  isFloatCeilingTripped,
  PayoutValidationError,
} = await import('./payouts.js')

beforeEach(() => {
  envStub.FLOAT_CEILING_MINOR = undefined
  envStub.BRIDGE_SPEI_FEE_MINOR = 0
  envStub.BRIDGE_ORCHESTRATION_BPS = 0
  envStub.FX_MAX_QUOTE_AGE_MINUTES = 240
  envStub.PAYOUT_MIN_RECEIVE_MINOR = 5_000
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

  it('accrues the Bridge per-send fee alongside the FX lines', () => {
    // The 2026-09-11 invoice rates: $1.00 flat SPEI + 25bps orchestration.
    // $3,960.00 principal -> 396000 * 25 / 10000 = 990 minor, + 100 flat.
    envStub.BRIDGE_SPEI_FEE_MINOR = 100
    envStub.BRIDGE_ORCHESTRATION_BPS = 25
    const entries = submittedLedgerEntries({
      sendAmountMinor: 396000,
      actualSourceAmountMinor: 396014,
    })
    expect(entries).toEqual([
      { account_code: 'due_from_bridge', direction: 'debit', amount_minor: 396000, currency: 'USD' },
      { account_code: 'fx_slippage', direction: 'debit', amount_minor: 14, currency: 'USD' },
      { account_code: 'bridge_wallet_float', direction: 'credit', amount_minor: 396014, currency: 'USD' },
      { account_code: 'provider_fees', direction: 'debit', amount_minor: 1090, currency: 'USD' },
      { account_code: 'bridge_fees_payable', direction: 'credit', amount_minor: 1090, currency: 'USD' },
    ])
    expect(netMinor(entries)).toBe(0)
  })

  it('an explicit providerFeeMinor overrides the contract rates', () => {
    envStub.BRIDGE_SPEI_FEE_MINOR = 100
    envStub.BRIDGE_ORCHESTRATION_BPS = 25
    const entries = submittedLedgerEntries({
      sendAmountMinor: 396000,
      actualSourceAmountMinor: 396000,
      providerFeeMinor: 7,
    })
    expect(entries.filter((e) => e.account_code === 'provider_fees')).toEqual([
      { account_code: 'provider_fees', direction: 'debit', amount_minor: 7, currency: 'USD' },
    ])
    expect(netMinor(entries)).toBe(0)
  })

  it('both knobs at zero reproduce the pre-accrual batch exactly', () => {
    const entries = submittedLedgerEntries({
      sendAmountMinor: 396000,
      actualSourceAmountMinor: 396014,
    })
    expect(entries.map((e) => e.account_code)).toEqual([
      'due_from_bridge',
      'fx_slippage',
      'bridge_wallet_float',
    ])
  })

  it('nets to zero with the accrual on, across many S/A pairs', () => {
    envStub.BRIDGE_SPEI_FEE_MINOR = 100
    envStub.BRIDGE_ORCHESTRATION_BPS = 25
    let seed = 90210
    const next = () => {
      seed = (seed * 16807) % 2147483647
      return seed
    }
    for (let i = 0; i < 250; i++) {
      const s = (next() % 5_000_000) + 1
      const a = Math.max(1, s + ((next() % 2001) - 1000))
      const entries = submittedLedgerEntries({ sendAmountMinor: s, actualSourceAmountMinor: a })
      expect(netMinor(entries)).toBe(0)
      for (const entry of entries) {
        expect(Number.isInteger(entry.amount_minor)).toBe(true)
        expect(entry.amount_minor).toBeGreaterThan(0)
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

// The OTHER arm of the fx_drift gate. It exists as its own function because
// three callers must agree on what "stale" means — the submit job's gate, the
// ops release refusal, and the board's read — and because unlike drift it is
// MONOTONE, which is the whole reason a release cannot clear a hold it placed.
describe('assessQuoteAge', () => {
  const NOW = Date.parse('2026-09-14T18:00:00.000Z')
  const minutesAgo = (m: number) => new Date(NOW - m * 60_000).toISOString()

  it('is fresh below the bound and reports the age it measured', () => {
    expect(assessQuoteAge(minutesAgo(30), false, NOW)).toEqual({
      stale: false,
      ageMinutes: 30,
      maxAgeMinutes: 240,
    })
  })

  it('is strict >, matching the gate in payout-submit exactly at the bound', () => {
    // A quote AT the bound still submits. This is not a nicety: the release
    // refusal and the submit gate must agree on the boundary, or the board
    // refuses a release the job would have honoured (or worse, the reverse).
    expect(assessQuoteAge(minutesAgo(240), false, NOW).stale).toBe(false)
    expect(assessQuoteAge(minutesAgo(241), false, NOW).stale).toBe(true)
  })

  it('reads the bound at call time, so raising it un-stales an existing quote', () => {
    // The escape hatch the board's copy points at: FX_MAX_QUOTE_AGE_MINUTES is
    // config, not a fact recorded on the row, so a sign-off can make a quote
    // fresh again and the release goes through. Nothing is written down to
    // contradict it.
    const old = minutesAgo(6_900) // the staging rows, 2026-09-14
    expect(assessQuoteAge(old, false, NOW).stale).toBe(true)
    envStub.FX_MAX_QUOTE_AGE_MINUTES = 10_000
    expect(assessQuoteAge(old, false, NOW)).toEqual({
      stale: false,
      ageMinutes: 6_900,
      maxAgeMinutes: 10_000,
    })
  })

  it('only ever grows — the same quote goes stale with nothing else changing', () => {
    // The property the fix rests on. A hold placed on the DRIFT arm at minute
    // 10 becomes un-releasable by minute 241 with no new event, which is why
    // the cause is derived now and never recorded at hold time.
    const quote = minutesAgo(10)
    expect(assessQuoteAge(quote, false, NOW).stale).toBe(false)
    expect(assessQuoteAge(quote, false, NOW + 240 * 60_000).stale).toBe(true)
  })

  it('throws on an unparseable timestamp rather than reading it as fresh', () => {
    expect(() => assessQuoteAge('not-a-date', false, NOW)).toThrow(PayoutValidationError)
    expect(() => assessQuoteAge('', false, NOW)).toThrow(PayoutValidationError)
  })

  // ── The age arm stands down once the funding has cleared (2026-09-17) ──
  //
  // Every case above is an UNCLEARED row, which is the arm's charter intact:
  // old + not funded = stuck behind a float-ceiling trip / dry treasury /
  // downed worker (prds/remittance-mvp.md, 2026-07-18). These are the other
  // half — old because ACH settlement took days, which is not stuckness.

  it('is never stale once the funding has cleared, however old the quote', () => {
    // The prod defect, 2026-09-17: the first real ACH reached the gate with a
    // 7,866-minute quote against a 240-minute bound and held on fx_drift. With
    // WAIT_FOR_CLEARING on, EVERY ACH transfer arrives like this — the bound is
    // not tight on that rail, it is unsatisfiable.
    expect(assessQuoteAge(minutesAgo(7_866), true, NOW).stale).toBe(false)
    // Not a wider bound — no bound at all on this path. A year-old quote on a
    // cleared row is still the drift arm's problem, never this one's.
    expect(assessQuoteAge(minutesAgo(525_600), true, NOW).stale).toBe(false)
  })

  it('still reports the true age on a cleared row — the board shows it', () => {
    // Standing down is not lying. The operator reading the detail page sees the
    // real number and the real bound; only the VERDICT changes, so a genuinely
    // odd age is still visible to a human even though it no longer holds.
    expect(assessQuoteAge(minutesAgo(7_866), true, NOW)).toEqual({
      stale: false,
      ageMinutes: 7_866,
      maxAgeMinutes: 240,
    })
  })

  it('holds an uncleared row at the same age — clearing is the whole difference', () => {
    // The one comparison that proves this is about funding and not about the
    // bound: same quote, same clock, opposite verdicts.
    const quote = minutesAgo(7_866)
    expect(assessQuoteAge(quote, false, NOW).stale).toBe(true)
    expect(assessQuoteAge(quote, true, NOW).stale).toBe(false)
  })

  it('still throws on a corrupt timestamp when the funding cleared', () => {
    // Fail-closed beats the shortcut: an unreadable quote must not be waved
    // through just because the money arrived.
    expect(() => assessQuoteAge('not-a-date', true, NOW)).toThrow(PayoutValidationError)
  })
})

// The destination rail's floor (2026-09-17). Bridge enforces it by rejecting
// POST /v0/transfers with a sync 400; the only question was ever where we find
// out, and the answer used to be "days after the sender paid".
describe('isBelowPayoutMinimum', () => {
  it('refuses below the floor, accepts at and above it', () => {
    // Strict <, so the floor itself is deliverable — matching how Bridge
    // documents the minimum (at least 50 MXN, not more than).
    expect(isBelowPayoutMinimum(4_999)).toBe(true)
    expect(isBelowPayoutMinimum(5_000)).toBe(false)
    expect(isBelowPayoutMinimum(5_001)).toBe(false)
  })

  it('refuses the prod case that proved this was missing', () => {
    // $1.00 at ~19.8 MXN/USD ≈ 1,980 MXN minor. Transfer 8bf376a9, 2026-09-17.
    expect(isBelowPayoutMinimum(1_980)).toBe(true)
  })

  it('reads the bound at call time, so raising it takes effect at once', () => {
    envStub.PAYOUT_MIN_RECEIVE_MINOR = 10_000
    expect(isBelowPayoutMinimum(5_000)).toBe(true)
    expect(payoutMinimumReceiveMinor()).toBe(10_000)
  })

  it('a zero bound disables the gate rather than refusing everything', () => {
    // The off switch has to be the harmless direction: a misread or unset
    // bound must not start refusing sends that were fine yesterday.
    envStub.PAYOUT_MIN_RECEIVE_MINOR = 0
    expect(isBelowPayoutMinimum(0)).toBe(false)
    expect(isBelowPayoutMinimum(1)).toBe(false)
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
