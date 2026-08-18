import { describe, it, expect } from 'vitest'
import {
  priceQuote,
  QuoteAmountError,
  InvalidBuyRateError,
  type QuotePricingConfig,
} from './quotes.js'

const defaults: QuotePricingConfig = {
  marginBps: 100,
  fxBufferBps: 50,
}

const cfg = (overrides: Partial<QuotePricingConfig> = {}): QuotePricingConfig => ({
  ...defaults,
  ...overrides,
})

describe('priceQuote', () => {
  it('prices the worked example: $200 total, 1% margin, no buffer', () => {
    const result = priceQuote({
      totalMinor: 20000,
      buyRate: '17.3400',
      config: cfg({ fxBufferBps: 0 }),
    })
    // The customer pays exactly what they typed — no carve-out (#193).
    expect(result.sendMinor).toBe(20000)
    // margin = residual of the old fee arithmetic: 20000 − floor(20000·10000/10100)
    expect(result.marginMinor).toBe(199)
    // rate carries the margin as the principal/send ratio:
    // 17.34 × 19801/20000 = 17.16746… floored to 4 dp
    expect(result.fxRate4).toBe('17.1674')
    // floor(20000 × 17.1674) = 343348 — the fee era paid 343349 (within
    // 4-dp rate quantization, the closest a disclosed-rate quote can get)
    expect(result.receiveMinor).toBe(343348)
  })

  it('reproduces the live prod example from #193: $100 at buy 17.117109', () => {
    // The issue's own target table: rate 16.8612 shown, recipient gets
    // 1,686.12 MXN — same pesos as the fee era, same $99.00/$1.00 split.
    const result = priceQuote({ totalMinor: 10000, buyRate: '17.117109', config: cfg() })
    expect(result.sendMinor).toBe(10000)
    expect(result.marginMinor).toBe(100)
    // floor4(17.117109 × 0.995) × 9900/10000 = 16.86121…, floored to 4 dp
    expect(result.fxRate4).toBe('16.8612')
    // floor(10000 × 16.8612) = 168612 centavos = 1,686.12 MXN
    expect(result.receiveMinor).toBe(168612)
  })

  it('books the same split the fee era booked (economics-neutrality, #193)', () => {
    // At equal bps, principal/margin must equal the old send/fee to the cent —
    // this is what keeps the FUNDED batch byte-identical across generations.
    for (const total of [10000, 20000, 199, 101, 33333, 999999]) {
      const { sendMinor, marginMinor } = priceQuote({
        totalMinor: total,
        buyRate: '17.34',
        config: cfg(),
      })
      const oldSend = Number((BigInt(total) * 10_000n) / 10_100n)
      expect(sendMinor).toBe(total)
      expect(marginMinor).toBe(total - oldSend)
    }
  })

  it('applies the buffer then the margin ratio (sandbox rate shape)', () => {
    // buy 20.10025100 → ×0.995 = 19.9997 (4 dp) territory, × 19801/20000
    // → 19.80074…, floored to 4 dp
    const result = priceQuote({
      totalMinor: 20000,
      buyRate: '20.10025100',
      config: cfg(),
    })
    expect(result.fxRate4).toBe('19.8007')
    // floor(20000 × 19.8007) = 396014 — the fee era's exact receive
    expect(result.receiveMinor).toBe(396014)
  })

  it('matches the fee era receive to within 4-dp rate quantization', () => {
    // The old flow floored the buffered rate to 4 dp and applied it to the
    // principal; the new flow folds principal/send into the rate BEFORE
    // quantizing. The two can differ only by the rate's last decimal applied
    // to the full send — bound |diff| ≤ send/10⁴ centavos (+1 for flooring).
    for (const total of [200, 999, 10000, 20000, 123457, 999999]) {
      const { receiveMinor } = priceQuote({ totalMinor: total, buyRate: '20.10025100', config: cfg() })
      const principal = Number((BigInt(total) * 10_000n) / 10_100n)
      const oldRate4 = 199997n // floor4(20.10025100 × 0.995)
      const oldReceive = Number((BigInt(principal) * oldRate4) / 10_000n)
      expect(Math.abs(receiveMinor - oldReceive)).toBeLessThanOrEqual(Math.ceil(total / 10_000) + 1)
    }
  })

  it('holds send + 0 = total and principal + margin = send exactly across a range of totals', () => {
    const config = cfg({ marginBps: 250 })
    for (let total = 200; total < 200 + 500; total++) {
      const { sendMinor, marginMinor } = priceQuote({ totalMinor: total, buyRate: '17.34', config })
      expect(sendMinor).toBe(total)
      expect(marginMinor).toBeGreaterThanOrEqual(0)
      expect(sendMinor - marginMinor).toBeGreaterThan(0)
    }
  })

  it('prices zero margin as a pass-through (buffer only, nothing to book)', () => {
    const result = priceQuote({
      totalMinor: 20000,
      buyRate: '17.34',
      config: cfg({ marginBps: 0, fxBufferBps: 0 }),
    })
    expect(result.marginMinor).toBe(0)
    expect(result.fxRate4).toBe('17.3400')
    expect(result.receiveMinor).toBe(346800) // floor(20000 × 17.34)
  })

  it('pads the customer rate to exactly four decimal places', () => {
    expect(
      priceQuote({
        totalMinor: 20000,
        buyRate: '20.1',
        config: cfg({ marginBps: 0, fxBufferBps: 0 }),
      }).fxRate4,
    ).toBe('20.1000')
    expect(
      priceQuote({
        totalMinor: 20000,
        buyRate: '20',
        config: cfg({ marginBps: 0, fxBufferBps: 0 }),
      }).fxRate4,
    ).toBe('20.0000')
  })

  it('rejects totals whose principal rounds to zero', () => {
    expect(() =>
      priceQuote({
        totalMinor: 1,
        buyRate: '17.34',
        config: cfg({ marginBps: 9999, fxBufferBps: 0 }),
      }),
    ).toThrow(QuoteAmountError)
  })

  it('rejects amounts too small to deliver any MXN', () => {
    // rate 0.0001 -> receive = floor(100 * 0.0001) = 0
    expect(() =>
      priceQuote({
        totalMinor: 100,
        buyRate: '0.0001',
        config: cfg({ marginBps: 0, fxBufferBps: 0 }),
      }),
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
        config: cfg({ marginBps: 0, fxBufferBps: 0 }),
      }),
    ).toThrow(QuoteAmountError)
  })

  it('stays exact at large magnitudes (no float drift)', () => {
    // send = 999_999_999_999, rate 9.9999 -> receive = floor(send * 99999 / 10000)
    const result = priceQuote({
      totalMinor: 999_999_999_999,
      buyRate: '9.9999',
      config: cfg({ marginBps: 0, fxBufferBps: 0 }),
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

  it('rejects a zero buy_rate and a rate crushed to zero by the spreads', () => {
    expect(() => priceQuote({ totalMinor: 20000, buyRate: '0', config: cfg() })).toThrow(
      InvalidBuyRateError,
    )
    expect(() => priceQuote({ totalMinor: 20000, buyRate: '0.00000001', config: cfg() })).toThrow(
      InvalidBuyRateError,
    )
  })

  it('survives the maximum combined spread without going negative', () => {
    // 9999 bps off 17.34 -> 0.001734 -> floored to 4 dp = 0.0017
    const result = priceQuote({
      totalMinor: 2_000_000,
      buyRate: '17.34',
      config: cfg({ marginBps: 0, fxBufferBps: 9999 }),
    })
    expect(result.fxRate4).toBe('0.0017')
    expect(result.receiveMinor).toBe(3400) // floor(2_000_000 * 17 / 10_000)
  })

  it('rejects invalid pricing config', () => {
    const call = (overrides: Partial<QuotePricingConfig>) => () =>
      priceQuote({ totalMinor: 20000, buyRate: '17.34', config: cfg(overrides) })
    expect(call({ fxBufferBps: 10000 })).toThrow()
    expect(call({ fxBufferBps: -1 })).toThrow()
    expect(call({ marginBps: 10000 })).toThrow()
    expect(call({ marginBps: -1 })).toThrow()
    expect(call({ marginBps: 1.5 })).toThrow()
  })
})
