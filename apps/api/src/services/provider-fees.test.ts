import { describe, it, expect, beforeEach, vi } from 'vitest'

// Mutable env stub: the fee computation reads the contract rates at call time.
const envStub = vi.hoisted(() => ({
  BRIDGE_SPEI_FEE_MINOR: 100,
  BRIDGE_ORCHESTRATION_BPS: 25,
}))
vi.mock('../config/env.js', () => ({ env: envStub }))

vi.mock('./ledger.js', () => ({ postLedgerTransaction: vi.fn() }))
vi.mock('./supabase.js', () => ({ supabaseAdmin: { from: vi.fn(), rpc: vi.fn() } }))

const {
  bridgePerSendFeeMinor,
  accrualLedgerEntries,
  classifyInvoiceLine,
  classifyInvoice,
  bookInvoiceLedgerEntries,
  payInvoiceLedgerEntries,
  ProviderFeeError,
  INVOICE_ROUNDING_TOLERANCE_MINOR,
  ROUNDING_LINE_LABEL,
} = await import('./provider-fees.js')

beforeEach(() => {
  envStub.BRIDGE_SPEI_FEE_MINOR = 100
  envStub.BRIDGE_ORCHESTRATION_BPS = 25
})

function netMinor(entries: { direction: string; amount_minor: number }[]): number {
  return entries.reduce(
    (sum, e) => sum + (e.direction === 'debit' ? e.amount_minor : -e.amount_minor),
    0,
  )
}

// The real invoice this whole slice came from (2026-09-11). Amounts as printed.
const INV19341 = [
  { label: 'SPEI Fee', quantity: '2', rate: '1.00', amountMinor: 200 },
  { label: 'Wallet Fee (active/created)', quantity: '2', rate: '0.25', amountMinor: 50 },
  { label: 'Orchestration Volume Fee', quantity: '118.05', rate: '0.25%', amountMinor: 30 },
  { label: 'Next Day ACH Fee', quantity: '3', rate: '0.50', amountMinor: 150 },
  { label: 'Gas', quantity: '0.006472', rate: '1.00', amountMinor: 1 },
  {
    label: 'Individual Compliance Fee (created accounts)',
    quantity: '3',
    rate: '2.00',
    amountMinor: 600,
  },
]

describe('bridgePerSendFeeMinor', () => {
  it('is the flat SPEI fee plus bps on the principal', () => {
    // $400.00 principal: 40000 * 25 / 10000 = 100, + the $1.00 flat fee.
    expect(bridgePerSendFeeMinor(40_000)).toEqual({
      speiMinor: 100,
      orchestrationMinor: 100,
      totalMinor: 200,
    })
  })

  it('rounds the bps line half-up at the cent', () => {
    // 1000 * 25 / 10000 = 2.5 -> 3;  999 * 25 / 10000 = 2.4975 -> 2
    envStub.BRIDGE_SPEI_FEE_MINOR = 0
    expect(bridgePerSendFeeMinor(1000).orchestrationMinor).toBe(3)
    expect(bridgePerSendFeeMinor(999).orchestrationMinor).toBe(2)
  })

  it('shows why the flat fee dominates at pilot size and fades at scale', () => {
    // The pricing fact the invoice made concrete: $1.00 is 2000bps of a $5
    // send and 10bps of a $1,000 one. A pure-bps price can never carry it.
    const small = bridgePerSendFeeMinor(500)
    const large = bridgePerSendFeeMinor(100_000)
    expect(small.speiMinor / 500).toBeGreaterThan(0.19)
    expect(large.speiMinor / 100_000).toBeLessThan(0.002)
  })

  it('both knobs at zero means no accrual at all', () => {
    envStub.BRIDGE_SPEI_FEE_MINOR = 0
    envStub.BRIDGE_ORCHESTRATION_BPS = 0
    expect(bridgePerSendFeeMinor(100_000).totalMinor).toBe(0)
  })

  it('rejects a non-positive or non-integer principal', () => {
    expect(() => bridgePerSendFeeMinor(0)).toThrow(ProviderFeeError)
    expect(() => bridgePerSendFeeMinor(-1)).toThrow(ProviderFeeError)
    expect(() => bridgePerSendFeeMinor(10.5)).toThrow(ProviderFeeError)
  })
})

describe('accrualLedgerEntries', () => {
  it('posts the expense/liability pair', () => {
    const entries = accrualLedgerEntries(1090)
    expect(entries).toEqual([
      { account_code: 'provider_fees', direction: 'debit', amount_minor: 1090, currency: 'USD' },
      {
        account_code: 'bridge_fees_payable',
        direction: 'credit',
        amount_minor: 1090,
        currency: 'USD',
      },
    ])
    expect(netMinor(entries)).toBe(0)
  })

  it('posts nothing at all for a zero accrual', () => {
    expect(accrualLedgerEntries(0)).toEqual([])
  })

  it('rejects a negative or non-integer fee', () => {
    expect(() => accrualLedgerEntries(-1)).toThrow(ProviderFeeError)
    expect(() => accrualLedgerEntries(1.5)).toThrow(ProviderFeeError)
  })
})

describe('classifyInvoiceLine', () => {
  it('classifies every line Bridge actually billed', () => {
    expect(classifyInvoiceLine('SPEI Fee')).toBe('accruable')
    expect(classifyInvoiceLine('Orchestration Volume Fee')).toBe('accruable')
    expect(classifyInvoiceLine('Wallet Fee (active/created)')).toBe('onboarding')
    expect(classifyInvoiceLine('Individual Compliance Fee (created accounts)')).toBe('onboarding')
    expect(classifyInvoiceLine('Next Day ACH Fee')).toBe('other')
    expect(classifyInvoiceLine('Gas')).toBe('other')
  })

  it('is case- and parenthetical-insensitive', () => {
    expect(classifyInvoiceLine('  spei fee (mexico)  ')).toBe('accruable')
    expect(classifyInvoiceLine('WALLET FEE')).toBe('onboarding')
  })

  it('returns null for a line we have never seen — the pricing-change tripwire', () => {
    expect(classifyInvoiceLine('Instant Settlement Surcharge')).toBeNull()
    expect(classifyInvoiceLine('')).toBeNull()
  })
})

describe('classifyInvoice', () => {
  it('rolls INV19341 up into its three buckets and absorbs Bridge’s rounding', () => {
    // Printed lines sum to $10.31; the invoice bills $10.30 because Bridge
    // rounds the total, not each line (orchestration 0.295125, gas 0.006472).
    const result = classifyInvoice(INV19341, 1030)
    expect(result.accruableMinor).toBe(230) // SPEI 200 + orchestration 30
    expect(result.onboardingMinor).toBe(650) // compliance 600 + wallet 50
    expect(result.otherMinor).toBe(150) // ACH 150 + gas 1 + rounding −1
    expect(result.totalMinor).toBe(1030)
    expect(result.roundingMinor).toBe(-1)
    expect(result.lines.at(-1)?.label).toBe(ROUNDING_LINE_LABEL)
    expect(result.accruableMinor + result.onboardingMinor + result.otherMinor).toBe(
      result.totalMinor,
    )
  })

  it('keeps the one-time-per-customer lines out of per-send cost', () => {
    // The point of the split: 63% of this invoice was acquisition cost. Booked
    // into provider_fees it would have made every transfer that month look
    // twice as expensive as it was.
    const { accruableMinor, onboardingMinor, totalMinor } = classifyInvoice(INV19341, 1030)
    expect(onboardingMinor).toBeGreaterThan(accruableMinor * 2)
    expect(onboardingMinor / totalMinor).toBeGreaterThan(0.6)
  })

  it('needs no stated total, and then trusts the lines', () => {
    const result = classifyInvoice(INV19341)
    expect(result.totalMinor).toBe(1031)
    expect(result.roundingMinor).toBe(0)
    expect(result.lines).toHaveLength(INV19341.length)
  })

  it('refuses an unrecognized line rather than guessing', () => {
    expect(() =>
      classifyInvoice([...INV19341, { label: 'Instant Settlement Surcharge', amountMinor: 500 }]),
    ).toThrow(/unrecognized invoice line/)
  })

  it('accepts an operator-stated category for a new line and marks it', () => {
    const result = classifyInvoice([
      ...INV19341,
      { label: 'Instant Settlement Surcharge', amountMinor: 500, category: 'accruable' },
    ])
    expect(result.accruableMinor).toBe(730)
    expect(result.lines.at(-1)?.categoryOverridden).toBe(true)
  })

  it('does not mark a stated category as an override when we knew the label', () => {
    const result = classifyInvoice([{ label: 'Gas', amountMinor: 1, category: 'other' }])
    expect(result.lines[0]?.categoryOverridden).toBe(false)
  })

  it('marks an operator reclassifying a label we DO recognize', () => {
    // Moving a line between buckets moves real money between transfer cost and
    // acquisition cost. Whoever did it should be visible on the record.
    const result = classifyInvoice([{ label: 'SPEI Fee', amountMinor: 200, category: 'other' }])
    expect(result.otherMinor).toBe(200)
    expect(result.accruableMinor).toBe(0)
    expect(result.lines[0]?.categoryOverridden).toBe(true)
  })

  it('rejects a stated total the lines miss by more than provider rounding', () => {
    const dropped = INV19341.filter((l) => l.label !== 'Next Day ACH Fee')
    expect(() => classifyInvoice(dropped, 1030)).toThrow(/too large to be the provider/)
    expect(() => classifyInvoice(INV19341, 1031 + INVOICE_ROUNDING_TOLERANCE_MINOR + 1)).toThrow(
      ProviderFeeError,
    )
  })

  it('rejects an empty invoice and a negative line', () => {
    expect(() => classifyInvoice([])).toThrow(ProviderFeeError)
    expect(() => classifyInvoice([{ label: 'Gas', amountMinor: -1 }])).toThrow(ProviderFeeError)
  })
})

describe('bookInvoiceLedgerEntries', () => {
  const book = (over: Partial<Parameters<typeof bookInvoiceLedgerEntries>[0]>) =>
    bookInvoiceLedgerEntries({
      onboardingMinor: 650,
      otherMinor: 150,
      accruableMinor: 230,
      accruedMinor: 230,
      payableAccountCode: 'bridge_fees_payable',
      ...over,
    })

  it('books onboarding and unaccrued lines when the accrual matched exactly', () => {
    const entries = book({})
    expect(entries).toEqual([
      {
        account_code: 'provider_onboarding_fees',
        direction: 'debit',
        amount_minor: 650,
        currency: 'USD',
      },
      { account_code: 'provider_fees', direction: 'debit', amount_minor: 150, currency: 'USD' },
      {
        account_code: 'bridge_fees_payable',
        direction: 'credit',
        amount_minor: 800,
        currency: 'USD',
      },
    ])
    expect(netMinor(entries)).toBe(0)
  })

  it('debits the shortfall when we under-accrued', () => {
    // Bridge charged 230 accruable; we only accrued 200.
    const entries = book({ accruedMinor: 200 })
    const fees = entries.find((e) => e.account_code === 'provider_fees')
    expect(fees).toEqual({
      account_code: 'provider_fees',
      direction: 'debit',
      amount_minor: 180, // other 150 + variance 30
      currency: 'USD',
    })
    expect(netMinor(entries)).toBe(0)
  })

  it('credits provider_fees back when we over-accrued', () => {
    // The failed-payout case: we accrued a SPEI fee for a payout that never
    // executed. The true-up gives it back rather than a per-transfer reversal.
    const entries = book({ onboardingMinor: 0, otherMinor: 0, accruedMinor: 330 })
    expect(entries).toEqual([
      { account_code: 'provider_fees', direction: 'credit', amount_minor: 100, currency: 'USD' },
      {
        account_code: 'bridge_fees_payable',
        direction: 'debit',
        amount_minor: 100,
        currency: 'USD',
      },
    ])
    expect(netMinor(entries)).toBe(0)
  })

  it('posts nothing when the accrual covered the invoice exactly', () => {
    expect(book({ onboardingMinor: 0, otherMinor: 0, accruedMinor: 230 })).toEqual([])
  })

  it('nets to zero for every sign of every term', () => {
    let seed = 12345
    const next = (n: number) => {
      seed = (seed * 16807) % 2147483647
      return seed % n
    }
    for (let i = 0; i < 500; i++) {
      const entries = bookInvoiceLedgerEntries({
        onboardingMinor: next(5000),
        otherMinor: next(5000),
        accruableMinor: next(5000),
        accruedMinor: next(5000),
        payableAccountCode: 'bridge_fees_payable',
      })
      expect(netMinor(entries)).toBe(0)
      expect(entries.length === 0 || entries.length >= 2).toBe(true)
      for (const entry of entries) expect(entry.amount_minor).toBeGreaterThan(0)
    }
  })

  it('rejects negative inputs', () => {
    expect(() => book({ onboardingMinor: -1 })).toThrow(ProviderFeeError)
    expect(() => book({ accruedMinor: -1 })).toThrow(ProviderFeeError)
  })
})

describe('payInvoiceLedgerEntries', () => {
  it('discharges the liability in cash', () => {
    const entries = payInvoiceLedgerEntries(1030, 'bridge_fees_payable')
    expect(entries).toEqual([
      {
        account_code: 'bridge_fees_payable',
        direction: 'debit',
        amount_minor: 1030,
        currency: 'USD',
      },
      { account_code: 'cash_clearing', direction: 'credit', amount_minor: 1030, currency: 'USD' },
    ])
    expect(netMinor(entries)).toBe(0)
  })

  it('rejects a non-positive total', () => {
    expect(() => payInvoiceLedgerEntries(0, 'bridge_fees_payable')).toThrow(ProviderFeeError)
  })
})
