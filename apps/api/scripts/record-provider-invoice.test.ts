import { describe, it, expect } from 'vitest'
import { parseUsdToMinor, parseArgs, parseInvoiceFile } from './record-provider-invoice.js'

// The provider-invoice CLI. This is the only path by which a real Bridge bill
// reaches the book, and every number on it is typed by hand off a PDF — so the
// parsing IS the control. A mistyped amount here does not fail loudly; it
// silently changes what the monthly true-up believes the provider charged.

const INV19341 = {
  provider: 'bridge',
  invoiceNumber: 'INV19341',
  periodStart: '2026-08-01',
  periodEnd: '2026-08-31',
  issuedAt: '2026-09-01',
  dueAt: '2026-09-30',
  total: '10.30',
  lines: [
    { label: 'SPEI Fee', quantity: '2', rate: '1.00', amount: '2.00' },
    { label: 'Wallet Fee (active/created)', quantity: '2', rate: '0.25', amount: '0.50' },
    { label: 'Orchestration Volume Fee', quantity: '118.05', rate: '0.25%', amount: '0.30' },
    { label: 'Next Day ACH Fee', quantity: '3', rate: '0.50', amount: '1.50' },
    { label: 'Gas', quantity: '0.006472', rate: '1.00', amount: '0.01' },
    {
      label: 'Individual Compliance Fee (created accounts)',
      quantity: '3',
      rate: '2.00',
      amount: '6.00',
    },
  ],
}

describe('parseUsdToMinor', () => {
  it('reads dollars as printed, with or without the sign', () => {
    expect(parseUsdToMinor('10.30', 'total')).toBe(1030)
    expect(parseUsdToMinor('$10.30', 'total')).toBe(1030)
    expect(parseUsdToMinor('6', 'total')).toBe(600)
    expect(parseUsdToMinor('0.01', 'total')).toBe(1)
    expect(parseUsdToMinor(' 2.5 ', 'total')).toBe(250)
  })

  it('accepts zero — a $0.00 line is a real thing on an invoice', () => {
    expect(parseUsdToMinor('0.00', 'line')).toBe(0)
  })

  it('refuses anything it would have to guess at', () => {
    // Three decimals is the dangerous one: Bridge prints sub-cent quantities,
    // and silently truncating 0.006 to 0 or 1 cent is a decision for a human.
    for (const bad of ['0.006', '1,000.00', '10.3.0', 'ten', '', '-1.00']) {
      expect(() => parseUsdToMinor(bad, 'amount')).toThrow(/must be dollars/)
    }
  })

  it('names the field it rejected, so a 6-line invoice is debuggable', () => {
    expect(() => parseUsdToMinor('oops', 'line "Gas" amount')).toThrow(/line "Gas" amount/)
  })
})

describe('parseArgs', () => {
  it('requires a file and defaults to a dry run', () => {
    expect(parseArgs(['--file', 'inv.json'])).toEqual({
      file: 'inv.json',
      confirm: false,
      pay: false,
    })
    expect(() => parseArgs([])).toThrow('--file is required')
    expect(() => parseArgs(['--file'])).toThrow('--file is required')
    expect(() => parseArgs(['--file', '--confirm'])).toThrow('--file is required')
  })

  it('rejects an unknown flag rather than ignoring it', () => {
    // A typo'd --confirm that silently reads as a dry run wastes an operator's
    // afternoon; one that silently reads as a POST is worse.
    expect(() => parseArgs(['--file', 'inv.json', '--comfirm'])).toThrow(/unknown flag --comfirm/)
  })

  it('takes --confirm and --pay together', () => {
    expect(parseArgs(['--file', 'inv.json', '--confirm', '--pay'])).toEqual({
      file: 'inv.json',
      confirm: true,
      pay: true,
    })
  })
})

describe('parseInvoiceFile', () => {
  it('parses the real 2026-09-11 Bridge invoice', () => {
    const parsed = parseInvoiceFile(INV19341)
    expect(parsed.invoiceNumber).toBe('INV19341')
    expect(parsed.statedTotalMinor).toBe(1030)
    expect(parsed.lines).toHaveLength(6)
    expect(parsed.lines[0]).toEqual({
      label: 'SPEI Fee',
      amountMinor: 200,
      quantity: '2',
      rate: '1.00',
    })
    // Printed lines sum to $10.31; the bill says $10.30. The parser passes
    // both through and lets classifyInvoice reconcile the provider's rounding.
    expect(parsed.lines.reduce((s, l) => s + l.amountMinor, 0)).toBe(1031)
  })

  it('keeps an operator-stated category for a line we do not recognize', () => {
    const parsed = parseInvoiceFile({
      ...INV19341,
      lines: [{ label: 'Instant Settlement Surcharge', amount: '5.00', category: 'accruable' }],
      total: '5.00',
    })
    expect(parsed.lines[0]?.category).toBe('accruable')
  })

  it('rejects a category that is not one of the three buckets', () => {
    expect(() =>
      parseInvoiceFile({
        ...INV19341,
        lines: [{ label: 'Gas', amount: '0.01', category: 'misc' }],
      }),
    ).toThrow()
  })

  it('rejects a malformed or reversed period', () => {
    expect(() => parseInvoiceFile({ ...INV19341, periodStart: '08/01/2026' })).toThrow(/ISO date/)
    expect(() =>
      parseInvoiceFile({ ...INV19341, periodStart: '2026-08-31', periodEnd: '2026-08-01' }),
    ).toThrow(/is before periodStart/)
  })

  it('rejects a provider we have no accrual stream for', () => {
    // bridge_fees_payable is Bridge's alone; another provider needs its own
    // account before its invoice can mean anything.
    expect(() => parseInvoiceFile({ ...INV19341, provider: 'stripe' })).toThrow()
  })

  it('rejects an invoice with no lines', () => {
    expect(() => parseInvoiceFile({ ...INV19341, lines: [] })).toThrow()
  })
})
