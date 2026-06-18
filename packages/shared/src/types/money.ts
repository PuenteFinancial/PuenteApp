export interface Money {
  amountMinor: number // integer minor units (e.g. 1099 = $10.99 USD, 1099 = 10.99 MXN)
  currency: string    // ISO 4217
}

// Construct from an integer coming out of the DB — never from a float literal
export function moneyFromMinorUnits(amountMinor: number, currency: string): Money {
  if (!Number.isInteger(amountMinor)) throw new Error('amountMinor must be an integer')
  return { amountMinor, currency }
}

// Parse a user-input display string like "10.99" — string-split avoids float drift
export function moneyFromString(display: string, currency: string): Money {
  const divisor = MINOR_UNIT_DIVISORS[currency] ?? 100
  const decimals = Math.round(Math.log10(divisor))
  const cleaned = display.replace(/[^0-9.]/g, '')
  const [whole = '0', fraction = ''] = cleaned.split('.')
  const paddedFraction = fraction.padEnd(decimals, '0').slice(0, decimals)
  const amountMinor = parseInt(whole, 10) * divisor + parseInt(paddedFraction, 10)
  if (isNaN(amountMinor)) throw new Error(`Cannot parse "${display}" as ${currency}`)
  return { amountMinor, currency }
}

export function addMoney(a: Money, b: Money): Money {
  assertSameCurrency(a, b)
  return { amountMinor: a.amountMinor + b.amountMinor, currency: a.currency }
}

export function subtractMoney(a: Money, b: Money): Money {
  assertSameCurrency(a, b)
  return { amountMinor: a.amountMinor - b.amountMinor, currency: a.currency }
}

// For display only — float division is safe here, never stored
export function formatMoney(m: Money, locale = 'en-US'): string {
  const divisor = MINOR_UNIT_DIVISORS[m.currency] ?? 100
  return new Intl.NumberFormat(locale, {
    style: 'currency',
    currency: m.currency,
  }).format(m.amountMinor / divisor)
}

function assertSameCurrency(a: Money, b: Money): void {
  if (a.currency !== b.currency) {
    throw new Error(`Currency mismatch: ${a.currency} vs ${b.currency}`)
  }
}

// Currencies relevant to LATAM remittance corridors
const MINOR_UNIT_DIVISORS: Record<string, number> = {
  USD: 100,
  MXN: 100,
  GTQ: 100, // Guatemala
  HNL: 100, // Honduras
  NIO: 100, // Nicaragua
  CRC: 100, // Costa Rica
  SVC: 100, // El Salvador
  DOP: 100, // Dominican Republic
}
