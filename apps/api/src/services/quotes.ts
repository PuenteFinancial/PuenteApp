// Quote pricing — Puente's firm USD→MXN offer, priced off Bridge's buy_rate minus
// our FX buffer AND our margin (#193: one displayed rate, no separate fee line).
// All arithmetic is scaled-BigInt; IEEE-754 never touches an amount or a rate.
//
// The customer pays `send` (the FULL amount they typed), the recipient gets
// `send × customer_rate`, and Puente's take is embedded in the rate. The take
// still exists as a USD amount — `margin` — because the FUNDED ledger batch
// must book it to fee_revenue: with fee = 0 and no margin, the revenue would
// silently vanish from the books and the whole spread would land in
// fx_slippage, whose job is measuring market movement.
//
// margin reuses the exact residual arithmetic the old fee used
// (floor(send·BPS/(BPS+marginBps)), margin = remainder), so at equal bps a
// merged-rate transfer books the byte-identical FUNDED batch the fee-line
// era booked. That is the economics-neutrality requirement of #193: structure
// now, tuning (the rate-basis probe, #197) later — as config, not code.

const RATE_SCALE_8 = 10n ** 8n
const BPS_DIVISOR = 10_000n
const MAX_SAFE = BigInt(Number.MAX_SAFE_INTEGER)

// Bridge rate grammar: up to 6 integer digits, up to 8 fractional digits.
// Anything outside this is rejected, never truncated (reconciliation depends on source_rate).
const BUY_RATE_PATTERN = /^\d{1,6}(\.\d{1,8})?$/

export interface QuotePricingConfig {
  /** Revenue, in bps off the rate — becomes margin_minor / fee_revenue. */
  marginBps: number
  /** Risk, in bps off the rate — drift cover, never revenue. */
  fxBufferBps: number
}

export interface PricedQuote {
  /** The full amount the customer pays (= their input, minor units). */
  sendMinor: number
  /** Puente's take in USD minor units; send − margin is the payout principal. */
  marginMinor: number
  /** Customer-facing rate as an exactly-4-dp decimal string, e.g. "17.3400". */
  fxRate4: string
  receiveMinor: number
}

/** The requested amount cannot be priced — maps to 400 validation_error. */
export class QuoteAmountError extends Error {}

/** The provider rate is unusable (malformed, zero, or crushed by the buffer) — maps to 503 rate_unavailable. */
export class InvalidBuyRateError extends Error {}

function assertConfig(config: QuotePricingConfig): void {
  const { marginBps, fxBufferBps } = config
  if (!Number.isSafeInteger(marginBps) || marginBps < 0 || marginBps > 9999) {
    throw new Error(`Invalid QUOTE_MARGIN_BPS: ${marginBps}`)
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

  // The customer pays exactly what they typed — no carve-out.
  const send = BigInt(totalMinor)
  const marginBps = BigInt(config.marginBps)
  const bufferBps = BigInt(config.fxBufferBps)

  // Margin is the residual of the old fee arithmetic (same divisor, same
  // floor), so principal (send − margin) is floored and the sub-cent remainder
  // lands in the margin. principal + margin = send holds exactly by
  // construction, and at equal bps the split matches the old send/fee split
  // to the cent — the FUNDED batch stays byte-identical (#193).
  const principal = (send * BPS_DIVISOR) / (BPS_DIVISOR + marginBps)
  if (principal <= 0n) {
    throw new QuoteAmountError('Amount is too small to send')
  }
  const margin = send - principal

  // Customer rate = buy_rate minus the buffer, then scaled by principal/send —
  // the SAME factor the margin split uses — floored at every step (never
  // promise MXN we might not be able to deliver), then quantized down to 4 dp.
  //
  // Multiplicative on purpose (Codex P1 on #193's first cut): an additive
  // (1 − buffer − margin) discount uses 1 − m where the margin residual uses
  // 1/(1 + m), a ~m²/10⁴ cross-term that systematically under-promised MXN vs
  // the fee era and surfaced as phantom favorable fx_slippage. Folding the
  // exact principal/send ratio in makes receive match the fee era to within
  // 4-dp rate quantization, and reproduces #193's worked target exactly
  // (buy 17.117109 → displayed 16.8612 → 1,686.12 MXN on $100).
  const buy8 = parseBuyRateScale8(buyRate)
  const buffered8 = (buy8 * (BPS_DIVISOR - bufferBps)) / BPS_DIVISOR
  const customer8 = (buffered8 * principal) / send
  const fxRate4 = customer8 / (RATE_SCALE_8 / BPS_DIVISOR)
  if (fxRate4 <= 0n) {
    throw new InvalidBuyRateError('Customer rate is not positive after buffer and margin')
  }

  // USD and MXN minor units are both 2 dp, so cents × rate = centavos directly.
  const receive = (send * fxRate4) / BPS_DIVISOR
  if (receive <= 0n) {
    throw new QuoteAmountError('Amount is too small to deliver')
  }
  if (send > MAX_SAFE || receive > MAX_SAFE) {
    throw new QuoteAmountError('Amount exceeds the supported maximum')
  }

  return {
    sendMinor: Number(send),
    marginMinor: Number(margin),
    fxRate4: formatRate4(fxRate4),
    receiveMinor: Number(receive),
  }
}
