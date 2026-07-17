import { describe, it, expect } from 'vitest'
import {
  priceQuote,
  QuoteAmountError,
  InvalidBuyRateError,
  type QuotePricingConfig,
} from './quotes.js'

const defaults: QuotePricingConfig = {
  feeFlatMinor: 0,
  feeBps: 100,
  fxBufferBps: 50,
}

const cfg = (overrides: Partial<QuotePricingConfig> = {}): QuotePricingConfig => ({
  ...defaults,
  ...overrides,
})

describe('priceQuote', () => {
  it('prices the worked example: $200 total, 1% bps fee, no buffer', () => {
    const result = priceQuote({
      totalMinor: 20000,
      buyRate: '17.3400',
      config: cfg({ fxBufferBps: 0 }),
    })
    expect(result.sendMinor).toBe(19801)
    expect(result.feeMinor).toBe(199)
    expect(result.fxRate4).toBe('17.3400')
    // floor(19801 * 17.3400) = 343349.34 -> 343349
    expect(result.receiveMinor).toBe(343349)
  })

  it('applies the FX buffer and quantizes down to 4 dp (sandbox rate shape)', () => {
    // buy 20.10025100, 50 bps off -> 19.99974974..., floored to 4 dp = 19.9997
    const result = priceQuote({
      totalMinor: 20000,
      buyRate: '20.10025100',
      config: cfg(),
    })
    expect(result.fxRate4).toBe('19.9997')
  })

  it('supports flat-only fee', () => {
    const result = priceQuote({
      totalMinor: 20000,
      buyRate: '17.34',
      config: cfg({ feeFlatMinor: 299, feeBps: 0 }),
    })
    expect(result.sendMinor).toBe(19701)
    expect(result.feeMinor).toBe(299)
  })

  it('supports flat + bps fee with exact invariant', () => {
    const result = priceQuote({
      totalMinor: 20000,
      buyRate: '17.34',
      config: cfg({ feeFlatMinor: 100, feeBps: 100 }),
    })
    // send = floor((20000-100)*10000/10100) = 19702, fee = residual 298
    expect(result.sendMinor).toBe(19702)
    expect(result.feeMinor).toBe(298)
    expect(result.sendMinor + result.feeMinor).toBe(20000)
  })

  it('holds total = send + fee exactly across a range of totals', () => {
    const config = cfg({ feeFlatMinor: 137, feeBps: 250 })
    for (let total = 200; total < 200 + 500; total++) {
      const { sendMinor, feeMinor } = priceQuote({ totalMinor: total, buyRate: '17.34', config })
      expect(sendMinor + feeMinor).toBe(total)
      expect(feeMinor).toBeGreaterThanOrEqual(config.feeFlatMinor)
      expect(sendMinor).toBeGreaterThan(0)
    }
  })

  it('pads the customer rate to exactly four decimal places', () => {
    expect(
      priceQuote({ totalMinor: 20000, buyRate: '20.1', config: cfg({ fxBufferBps: 0 }) }).fxRate4,
    ).toBe('20.1000')
    expect(
      priceQuote({ totalMinor: 20000, buyRate: '20', config: cfg({ fxBufferBps: 0 }) }).fxRate4,
    ).toBe('20.0000')
  })

  it('rejects totals that do not exceed the flat fee', () => {
    expect(() =>
      priceQuote({ totalMinor: 299, buyRate: '17.34', config: cfg({ feeFlatMinor: 299 }) }),
    ).toThrow(QuoteAmountError)
    expect(() =>
      priceQuote({ totalMinor: 100, buyRate: '17.34', config: cfg({ feeFlatMinor: 299 }) }),
    ).toThrow(QuoteAmountError)
  })

  it('rejects totals whose send amount rounds to zero', () => {
    expect(() =>
      priceQuote({ totalMinor: 1, buyRate: '17.34', config: cfg({ feeFlatMinor: 0, feeBps: 9999 }) }),
    ).toThrow(QuoteAmountError)
  })

  it('rejects amounts too small to deliver any MXN', () => {
    // rate 0.0001 -> receive = floor(100 * 0.0001) = 0
    expect(() =>
      priceQuote({ totalMinor: 100, buyRate: '0.0001', config: cfg({ feeBps: 0, fxBufferBps: 0 }) }),
    ).toThrow(QuoteAmountError)
  })

  it('rejects non-integer, unsafe, or non-positive totals', () => {
    const call = (totalMinor: number) => () =>
      priceQuote({ totalMinor, buyRate: '17.34', config: cfg() })
    expect(call(1.5)).toThrow(QuoteAmountError)
    expect(call(0)).toThrow(QuoteAmountError)
    expect(call(-100)).toThrow(QuoteAmountError)
    expect(call(NaN)).toThrow(QuoteAmountError)
    expect(call(Number.MAX_SAFE_INTEGER + 2)).toThrow(QuoteAmountError)
  })

  it('rejects results that would exceed safe integer minor units', () => {
    expect(() =>
      priceQuote({
        totalMinor: 1_000_000_000_000,
        buyRate: '999999.99999999',
        config: cfg({ feeBps: 0, fxBufferBps: 0 }),
      }),
    ).toThrow(QuoteAmountError)
  })

  it('stays exact at large magnitudes (no float drift)', () => {
    // send = 999_999_999_999, rate 9.9999 -> receive = floor(send * 99999 / 10000)
    const result = priceQuote({
      totalMinor: 999_999_999_999,
      buyRate: '9.9999',
      config: cfg({ feeBps: 0, fxBufferBps: 0 }),
    })
    expect(result.receiveMinor).toBe(9_999_899_999_990)
    expect(Number.isSafeInteger(result.receiveMinor)).toBe(true)
  })

  it('rejects malformed buy_rate strings without truncating', () => {
    const rates = ['', 'abc', '17,34', '-5', '17.', '.5', '17.123456789', '1234567', '1e3', ' 17.34']
    for (const buyRate of rates) {
      expect(() => priceQuote({ totalMinor: 20000, buyRate, config: cfg() }), buyRate).toThrow(
        InvalidBuyRateError,
      )
    }
  })

  it('rejects a zero buy_rate and a rate crushed to zero by the buffer', () => {
    expect(() => priceQuote({ totalMinor: 20000, buyRate: '0', config: cfg() })).toThrow(
      InvalidBuyRateError,
    )
    expect(() => priceQuote({ totalMinor: 20000, buyRate: '0.00000001', config: cfg() })).toThrow(
      InvalidBuyRateError,
    )
  })

  it('survives the maximum buffer without going negative', () => {
    // 9999 bps off 17.34 -> 0.001734 -> floored to 4 dp = 0.0017
    const result = priceQuote({
      totalMinor: 2_000_000,
      buyRate: '17.34',
      config: cfg({ feeBps: 0, fxBufferBps: 9999 }),
    })
    expect(result.fxRate4).toBe('0.0017')
    expect(result.receiveMinor).toBe(3400) // floor(2_000_000 * 17 / 10_000)
  })

  it('rejects invalid pricing config', () => {
    const call = (overrides: Partial<QuotePricingConfig>) => () =>
      priceQuote({ totalMinor: 20000, buyRate: '17.34', config: cfg(overrides) })
    expect(call({ fxBufferBps: 10000 })).toThrow()
    expect(call({ fxBufferBps: -1 })).toThrow()
    expect(call({ feeBps: -1 })).toThrow()
    expect(call({ feeFlatMinor: -1 })).toThrow()
    expect(call({ feeFlatMinor: 1.5 })).toThrow()
  })
})
