import { describe, it, expect } from 'vitest'
import { parseUsdToMinor } from './money'

// Mirrors the CLI parser's pinned cases (record-float-topup.test.ts) with the
// web variant's null-instead-of-throw contract.
describe('parseUsdToMinor', () => {
  it('parses whole dollars', () => {
    expect(parseUsdToMinor('100')).toBe(10_000)
    expect(parseUsdToMinor('1')).toBe(100)
  })

  it('parses one and two decimal places', () => {
    expect(parseUsdToMinor('100.5')).toBe(10_050)
    expect(parseUsdToMinor('100.50')).toBe(10_050)
    expect(parseUsdToMinor('0.01')).toBe(1)
  })

  it('trims surrounding whitespace', () => {
    expect(parseUsdToMinor('  57.00  ')).toBe(5_700)
  })

  it('never round-trips through a float — the 4.10 case', () => {
    expect(parseUsdToMinor('4.10')).toBe(410)
  })

  it('rejects zero, negatives, and non-amounts', () => {
    expect(parseUsdToMinor('0')).toBeNull()
    expect(parseUsdToMinor('0.00')).toBeNull()
    expect(parseUsdToMinor('-5')).toBeNull()
    expect(parseUsdToMinor('')).toBeNull()
    expect(parseUsdToMinor('abc')).toBeNull()
    expect(parseUsdToMinor('$100')).toBeNull()
    expect(parseUsdToMinor('100.123')).toBeNull()
    expect(parseUsdToMinor('1,000')).toBeNull()
    expect(parseUsdToMinor('1e6')).toBeNull()
  })

  it('rejects implausibly large amounts instead of overflowing', () => {
    expect(parseUsdToMinor('9999999999999')).toBeNull() // 13 digits — over the regex cap
  })
})
