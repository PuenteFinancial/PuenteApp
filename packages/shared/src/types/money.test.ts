import { describe, expect, it } from 'vitest'
import {
  addMoney,
  compareMoney,
  formatMoney,
  isZero,
  moneyFromMinorUnits,
  moneyFromString,
  subtractMoney,
  zeroOf,
} from './money.js'

describe('moneyFromMinorUnits', () => {
  it('constructs from a valid integer', () => {
    expect(moneyFromMinorUnits(1099, 'USD')).toEqual({ amountMinor: 1099, currency: 'USD' })
  })

  it('allows negative integers (ledger reversal lines)', () => {
    expect(moneyFromMinorUnits(-1099, 'USD')).toEqual({ amountMinor: -1099, currency: 'USD' })
  })

  it('allows zero', () => {
    expect(moneyFromMinorUnits(0, 'USD')).toEqual({ amountMinor: 0, currency: 'USD' })
  })

  it('throws on a float', () => {
    expect(() => moneyFromMinorUnits(10.99, 'USD')).toThrow('amountMinor must be an integer')
  })
})

describe('moneyFromString', () => {
  it('parses a whole-dollar string', () => {
    expect(moneyFromString('10', 'USD')).toEqual({ amountMinor: 1000, currency: 'USD' })
  })

  it('parses a decimal string', () => {
    expect(moneyFromString('10.99', 'USD')).toEqual({ amountMinor: 1099, currency: 'USD' })
  })

  it('strips currency symbols like $', () => {
    expect(moneyFromString('$10.99', 'USD')).toEqual({ amountMinor: 1099, currency: 'USD' })
  })

  it('pads a short fraction', () => {
    expect(moneyFromString('10.9', 'USD')).toEqual({ amountMinor: 1090, currency: 'USD' })
  })

  it('truncates a long fraction', () => {
    expect(moneyFromString('10.999', 'USD')).toEqual({ amountMinor: 1099, currency: 'USD' })
  })

  it('parses zero', () => {
    expect(moneyFromString('0.00', 'USD')).toEqual({ amountMinor: 0, currency: 'USD' })
  })

  it('handles MXN (also 2 decimal places)', () => {
    expect(moneyFromString('500.50', 'MXN')).toEqual({ amountMinor: 50050, currency: 'MXN' })
  })

  it('throws on a negative string', () => {
    expect(() => moneyFromString('-10.99', 'USD')).toThrow('Negative amounts are not allowed')
  })

  it('throws on a negative string with leading space', () => {
    expect(() => moneyFromString('  -10.99', 'USD')).toThrow('Negative amounts are not allowed')
  })

  it('throws on an unparseable string', () => {
    expect(() => moneyFromString('', 'USD')).toThrow()
  })
})

describe('addMoney', () => {
  it('adds two amounts of the same currency', () => {
    expect(addMoney({ amountMinor: 500, currency: 'USD' }, { amountMinor: 300, currency: 'USD' })).toEqual({
      amountMinor: 800,
      currency: 'USD',
    })
  })

  it('throws on currency mismatch', () => {
    expect(() =>
      addMoney({ amountMinor: 500, currency: 'USD' }, { amountMinor: 300, currency: 'MXN' })
    ).toThrow('Currency mismatch')
  })
})

describe('subtractMoney', () => {
  it('subtracts two amounts of the same currency', () => {
    expect(subtractMoney({ amountMinor: 500, currency: 'USD' }, { amountMinor: 300, currency: 'USD' })).toEqual({
      amountMinor: 200,
      currency: 'USD',
    })
  })

  it('subtracts to zero', () => {
    expect(subtractMoney({ amountMinor: 500, currency: 'USD' }, { amountMinor: 500, currency: 'USD' })).toEqual({
      amountMinor: 0,
      currency: 'USD',
    })
  })

  it('subtracts to negative (for ledger reversal logic)', () => {
    const result = subtractMoney({ amountMinor: 100, currency: 'USD' }, { amountMinor: 300, currency: 'USD' })
    expect(result.amountMinor).toBe(-200)
  })

  it('throws on currency mismatch', () => {
    expect(() =>
      subtractMoney({ amountMinor: 500, currency: 'USD' }, { amountMinor: 300, currency: 'MXN' })
    ).toThrow('Currency mismatch')
  })
})

describe('formatMoney', () => {
  it('formats USD in en-US locale', () => {
    expect(formatMoney({ amountMinor: 1099, currency: 'USD' })).toBe('$10.99')
  })

  it('formats MXN in es-MX locale', () => {
    const result = formatMoney({ amountMinor: 50050, currency: 'MXN' }, 'es-MX')
    expect(result).toContain('500')
    expect(result).toContain('50')
  })
})

describe('compareMoney', () => {
  it('returns negative when a < b', () => {
    expect(compareMoney({ amountMinor: 100, currency: 'USD' }, { amountMinor: 200, currency: 'USD' })).toBeLessThan(0)
  })

  it('returns 0 when a === b', () => {
    expect(compareMoney({ amountMinor: 100, currency: 'USD' }, { amountMinor: 100, currency: 'USD' })).toBe(0)
  })

  it('returns positive when a > b', () => {
    expect(compareMoney({ amountMinor: 200, currency: 'USD' }, { amountMinor: 100, currency: 'USD' })).toBeGreaterThan(0)
  })

  it('throws on currency mismatch', () => {
    expect(() =>
      compareMoney({ amountMinor: 100, currency: 'USD' }, { amountMinor: 100, currency: 'MXN' })
    ).toThrow('Currency mismatch')
  })
})

describe('isZero', () => {
  it('returns true for a zero amount', () => {
    expect(isZero({ amountMinor: 0, currency: 'USD' })).toBe(true)
  })

  it('returns false for a nonzero amount', () => {
    expect(isZero({ amountMinor: 1, currency: 'USD' })).toBe(false)
  })

  it('returns false for a negative amount', () => {
    expect(isZero({ amountMinor: -1, currency: 'USD' })).toBe(false)
  })
})

describe('zeroOf', () => {
  it('returns a zero Money with the given currency', () => {
    expect(zeroOf('USD')).toEqual({ amountMinor: 0, currency: 'USD' })
  })

  it('works for MXN', () => {
    expect(zeroOf('MXN')).toEqual({ amountMinor: 0, currency: 'MXN' })
  })
})
