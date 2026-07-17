// Quote pricing — Puente's firm USD→MXN offer, priced off Bridge's buy_rate minus
// our FX buffer (docs/ledger-rules.md "no rate lock"). All arithmetic is scaled-BigInt;
// IEEE-754 never touches an amount or a rate.

const RATE_SCALE_8 = 10n ** 8n
const BPS_DIVISOR = 10_000n
const MAX_SAFE = BigInt(Number.MAX_SAFE_INTEGER)

// Bridge rate grammar: up to 6 integer digits, up to 8 fractional digits.
// Anything outside this is rejected, never truncated (reconciliation depends on source_rate).
const BUY_RATE_PATTERN = /^\d{1,6}(\.\d{1,8})?$/

export interface QuotePricingConfig {
  feeFlatMinor: number
  feeBps: number
  fxBufferBps: number
}

export interface PricedQuote {
  sendMinor: number
  feeMinor: number
  /** Customer-facing rate as an exactly-4-dp decimal string, e.g. "17.3400". */
  fxRate4: string
  receiveMinor: number
}

/** The requested amount cannot be priced — maps to 400 validation_error. */
export class QuoteAmountError extends Error {}

/** The provider rate is unusable (malformed, zero, or crushed by the buffer) — maps to 503 rate_unavailable. */
export class InvalidBuyRateError extends Error {}

function assertConfig(config: QuotePricingConfig): void {
  const { feeFlatMinor, feeBps, fxBufferBps } = config
  if (!Number.isSafeInteger(feeFlatMinor) || feeFlatMinor < 0) {
    throw new Error(`Invalid QUOTE_FEE_FLAT_MINOR: ${feeFlatMinor}`)
  }
  if (!Number.isSafeInteger(feeBps) || feeBps < 0 || feeBps > 9999) {
    throw new Error(`Invalid QUOTE_FEE_BPS: ${feeBps}`)
  }
  if (!Number.isSafeInteger(fxBufferBps) || fxBufferBps < 0 || fxBufferBps > 9999) {
    throw new Error(`Invalid QUOTE_FX_BUFFER_BPS: ${fxBufferBps}`)
  }
}

/** Parse a validated buy_rate string to a scale-8 BigInt (17.34 → 1734000000n). */
function parseBuyRateScale8(buyRate: string): bigint {
  if (!BUY_RATE_PATTERN.test(buyRate)) {
    throw new InvalidBuyRateError(`Bridge buy_rate outside expected grammar`)
  }
  const [intPart = '0', fracPart = ''] = buyRate.split('.')
  const scaled = BigInt(intPart) * RATE_SCALE_8 + BigInt(fracPart.padEnd(8, '0'))
  if (scaled <= 0n) {
    throw new InvalidBuyRateError('Bridge buy_rate must be positive')
  }
  return scaled
}

/** Format a scale-4 BigInt rate as an exactly-4-dp decimal string. */
export function formatRate4(rate4: bigint): string {
  return `${rate4 / BPS_DIVISOR}.${(rate4 % BPS_DIVISOR).toString().padStart(4, '0')}`
}

export function priceQuote(input: {
  totalMinor: number
  buyRate: string
  config: QuotePricingConfig
}): PricedQuote {
  const { totalMinor, buyRate, config } = input
  assertConfig(config)

  if (!Number.isSafeInteger(totalMinor) || totalMinor <= 0) {
    throw new QuoteAmountError('Amount must be a positive integer in minor units')
  }

  const total = BigInt(totalMinor)
  const flat = BigInt(config.feeFlatMinor)
  const feeBps = BigInt(config.feeBps)
  const bufferBps = BigInt(config.fxBufferBps)

  // Fee is the residual: send is floored, so the sub-cent remainder of the bps
  // portion lands in the fee. total = send + fee holds exactly by construction.
  if (total <= flat) {
    throw new QuoteAmountError('Amount does not cover the transfer fee')
  }
  const send = ((total - flat) * BPS_DIVISOR) / (BPS_DIVISOR + feeBps)
  if (send <= 0n) {
    throw new QuoteAmountError('Amount is too small to send')
  }
  const fee = total - send

  // Customer rate = buy_rate minus buffer, floored at every step (never promise
  // MXN we might not be able to deliver), then quantized down to 4 dp.
  const buy8 = parseBuyRateScale8(buyRate)
  const customer8 = (buy8 * (BPS_DIVISOR - bufferBps)) / BPS_DIVISOR
  const fxRate4 = customer8 / (RATE_SCALE_8 / BPS_DIVISOR)
  if (fxRate4 <= 0n) {
    throw new InvalidBuyRateError('Customer rate is not positive after buffer')
  }

  // USD and MXN minor units are both 2 dp, so cents × rate = centavos directly.
  const receive = (send * fxRate4) / BPS_DIVISOR
  if (receive <= 0n) {
    throw new QuoteAmountError('Amount is too small to deliver')
  }
  if (send > MAX_SAFE || fee > MAX_SAFE || receive > MAX_SAFE) {
    throw new QuoteAmountError('Amount exceeds the supported maximum')
  }

  return {
    sendMinor: Number(send),
    feeMinor: Number(fee),
    fxRate4: formatRate4(fxRate4),
    receiveMinor: Number(receive),
  }
}
