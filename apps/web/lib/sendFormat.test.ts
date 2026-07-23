import { describe, it, expect } from 'vitest'
import { formatUsd, formatMxn, mmss, secondsUntil, isQuoteShape } from './sendFormat'

describe('formatUsd', () => {
  it('formats USD minor units with grouping and two decimals', () => {
    expect(formatUsd(0)).toBe('$0.00')
    expect(formatUsd(5)).toBe('$0.05')
    expect(formatUsd(10000)).toBe('$100.00')
    expect(formatUsd(123456789)).toBe('$1,234,567.89')
  })
})

describe('formatMxn', () => {
  it('formats MXN minor units with an explicit code suffix', () => {
    expect(formatMxn(0)).toBe('0.00 MXN')
    expect(formatMxn(169000)).toBe('1,690.00 MXN')
  })
})

describe('mmss', () => {
  it('formats seconds as m:ss and clamps negatives to 0:00', () => {
    expect(mmss(0)).toBe('0:00')
    expect(mmss(9)).toBe('0:09')
    expect(mmss(899)).toBe('14:59')
    expect(mmss(-5)).toBe('0:00')
  })
})

describe('secondsUntil', () => {
  it('returns whole seconds remaining, negative once past', () => {
    const now = Date.parse('2026-07-23T00:00:00.000Z')
    expect(secondsUntil('2026-07-23T00:15:00.000Z', now)).toBe(900)
    expect(secondsUntil('2026-07-23T00:00:00.000Z', now)).toBe(0)
    expect(secondsUntil('2026-07-22T23:59:30.000Z', now)).toBe(-30)
  })
})

describe('isQuoteShape', () => {
  const valid = {
    id: 'q1',
    payoutDestinationId: 'd1',
    status: 'active',
    fxRate: '17.3400',
    expiresAt: '2026-07-23T00:15:00.000Z',
    totalAmount: { amountMinor: 10000, currency: 'USD' },
    feeAmount: { amountMinor: 200, currency: 'USD' },
    receiveAmount: { amountMinor: 169000, currency: 'MXN' },
  }

  it('accepts a well-formed quote body', () => {
    expect(isQuoteShape(valid)).toBe(true)
  })

  it('rejects anything not shaped like a quote (guards the money render)', () => {
    expect(isQuoteShape(null)).toBe(false)
    expect(isQuoteShape({})).toBe(false)
    expect(isQuoteShape('<html>not json</html>')).toBe(false)
    expect(isQuoteShape({ ...valid, totalAmount: undefined })).toBe(false)
    expect(isQuoteShape({ ...valid, expiresAt: 123 })).toBe(false)
    expect(isQuoteShape({ ...valid, receiveAmount: { currency: 'MXN' } })).toBe(false)
  })
})
