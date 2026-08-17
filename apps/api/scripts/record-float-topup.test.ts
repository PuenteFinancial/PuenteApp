import { describe, it, expect } from 'vitest'
import { floatTopUpLedgerEntries, PayoutValidationError } from '../src/services/payouts.js'
import { parseUsdToMinor, parseArgs } from './record-float-topup.js'

// The float top-up CLI. Two classes of guarantee: the arg parsing (the only
// user input on a path that writes to the ledger, so every way a mistyped
// command could be silently reinterpreted is a test), and the batch itself —
// bridge_wallet_float is CREDITED by every payout, so this debit is what stops
// the account going negative and the daily reconciliation opening a discrepancy
// on the very first real send.

describe('floatTopUpLedgerEntries', () => {
  it('debits the wallet float and credits cash, netting to zero', () => {
    const entries = floatTopUpLedgerEntries(10_000)
    expect(entries).toEqual([
      {
        account_code: 'bridge_wallet_float',
        direction: 'debit',
        amount_minor: 10_000,
        currency: 'USD',
      },
      { account_code: 'cash_clearing', direction: 'credit', amount_minor: 10_000, currency: 'USD' },
    ])
    const net = entries.reduce(
      (sum, e) => sum + (e.direction === 'debit' ? e.amount_minor : -e.amount_minor),
      0,
    )
    expect(net).toBe(0)
  })

  it('debits the float — the direction that makes the payout credit survivable', () => {
    // Getting this backwards would double the drain instead of offsetting it,
    // and the error would only surface as a reconciliation finding days later.
    const [first] = floatTopUpLedgerEntries(5_000)
    expect(first).toMatchObject({ account_code: 'bridge_wallet_float', direction: 'debit' })
  })

  it.each([0, -1, 1.5, NaN])('rejects %s rather than posting a bad batch', (amount) => {
    expect(() => floatTopUpLedgerEntries(amount)).toThrow(PayoutValidationError)
  })
})

describe('parseUsdToMinor — no float arithmetic ever touches an amount', () => {
  it.each([
    ['100', 10_000],
    ['100.00', 10_000],
    ['100.5', 10_050],
    ['100.50', 10_050],
    ['0.01', 1],
    ['1234.56', 123_456],
  ])('parses %s to %i minor units', (input, expected) => {
    expect(parseUsdToMinor(input)).toBe(expected)
  })

  it.each(['', '  ', 'abc', '1.234', '-5', '1e3', '$100', '100.'])(
    'rejects "%s" rather than guessing',
    (input) => {
      expect(() => parseUsdToMinor(input)).toThrow()
    },
  )

  it('rejects zero', () => {
    expect(() => parseUsdToMinor('0')).toThrow(/greater than zero/)
  })
})

describe('parseArgs', () => {
  it('requires both amount and ref', () => {
    expect(() => parseArgs(['--amount', '100'])).toThrow(/--ref is required/)
    expect(() => parseArgs(['--ref', 'abc'])).toThrow(/--amount is required/)
  })

  it('rejects an unknown flag rather than silently ignoring it', () => {
    expect(() => parseArgs(['--amount', '100', '--ref', 'abc', '--force'])).toThrow(/unknown flag/)
  })

  it('defaults to a dry run — posting requires --confirm', () => {
    expect(parseArgs(['--amount', '100', '--ref', 'abc'])).toEqual({
      amountMinor: 10_000,
      ref: 'abc',
      confirm: false,
    })
    expect(parseArgs(['--amount', '100', '--ref', 'abc', '--confirm']).confirm).toBe(true)
  })

  it('rejects a --ref that swallowed the next flag', () => {
    expect(() => parseArgs(['--ref', '--confirm', '--amount', '100'])).toThrow(/--ref is required/)
  })
})
