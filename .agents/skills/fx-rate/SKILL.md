---
name: fx-rate
description: Scaffold any cross-currency operation — explicit FX step with recorded rate and timestamp
---

Invoke this skill any time an operation converts between currencies. For Puente this is every remittance: user pays USD, recipient receives MXN (or other LATAM currency).

## The rule
**Never mix currencies without an explicit FX step that records the rate and timestamp.**
A rate without a timestamp is meaningless — rates change by the second.

## FX Rate record shape
```ts
interface FxRate {
  id: string
  fromCurrency: string   // ISO 4217, e.g. "USD"
  toCurrency: string     // ISO 4217, e.g. "MXN"
  rate: number           // multiply fromCurrency minor units by this to get toCurrency minor units
  rateSource: string     // e.g. "wise", "open-exchange-rates", "banco-de-mexico"
  fetchedAt: string      // ISO timestamp — when this rate was retrieved
  expiresAt: string      // ISO timestamp — when this rate should no longer be used
  quoteId: string | null // if provider gives a locked quote ID, store it here
}
```

Store in DB — never convert with a rate that isn't in the `fx_rates` table.

## Conversion helper
```ts
import type { Money } from '@puente/shared'

function convertCurrency(amount: Money, rate: FxRate): Money {
  if (amount.currency !== rate.fromCurrency) {
    throw new Error(`Rate is ${rate.fromCurrency}→${rate.toCurrency}, got ${amount.currency}`)
  }
  if (new Date() > new Date(rate.expiresAt)) {
    throw new Error(`FX rate expired at ${rate.expiresAt}`)
  }
  // Integer multiply + round — no float intermediary stored
  return {
    amountMinor: Math.round(amount.amountMinor * rate.rate),
    currency: rate.toCurrency,
  }
}
```

## Route pattern for a remittance send
```ts
// 1. Fetch and lock a rate from provider
const rate = await fxService.getRate('USD', 'MXN')

// 2. Persist the rate before using it
await db.from('fx_rates').insert(rate)

// 3. Convert
const mxnAmount = convertCurrency(usdAmount, rate)

// 4. Store rate reference on the transaction
await db.from('remittances').insert({
  ...transactionFields,
  fx_rate_id: rate.id,
  amount_minor_from: usdAmount.amountMinor,
  currency_from: usdAmount.currency,
  amount_minor_to: mxnAmount.amountMinor,
  currency_to: mxnAmount.currency,
})
```

## FX rate DB table (create via migration skill)
```sql
CREATE TABLE fx_rates (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  from_currency CHAR(3) NOT NULL CHECK (from_currency ~ '^[A-Z]{3}$'),
  to_currency   CHAR(3) NOT NULL CHECK (to_currency ~ '^[A-Z]{3}$'),
  rate          NUMERIC(20, 10) NOT NULL CHECK (rate > 0),
  rate_source   TEXT NOT NULL,
  fetched_at    TIMESTAMPTZ NOT NULL,
  expires_at    TIMESTAMPTZ NOT NULL,
  quote_id      TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX ON fx_rates (from_currency, to_currency, fetched_at DESC);
```

Use `NUMERIC(20,10)` not `FLOAT` for the rate column — float imprecision compounds across many conversions.

## Required tests
```ts
it('throws if rate is expired', () => {
  const expiredRate = { ...validRate, expiresAt: new Date(Date.now() - 1000).toISOString() }
  expect(() => convertCurrency(usdAmount, expiredRate)).toThrow('expired')
})

it('throws if currency mismatch', () => {
  expect(() => convertCurrency({ amountMinor: 100, currency: 'EUR' }, usdToMxnRate)).toThrow('Rate is USD→MXN')
})

it('converts without storing a float', () => {
  const result = convertCurrency({ amountMinor: 1000, currency: 'USD' }, rate)
  expect(Number.isInteger(result.amountMinor)).toBe(true)
})
```

## Checklist
- [ ] Rate persisted to `fx_rates` before use
- [ ] `fetchedAt` and `expiresAt` both stored
- [ ] `quoteId` stored if provider locks a rate
- [ ] `convertCurrency` called with expiry check
- [ ] Both sides of the conversion stored on the transaction (`amount_minor_from`, `amount_minor_to`)
- [ ] `fx_rate_id` foreign key on the transaction row
- [ ] Rate column in DB is NUMERIC, not FLOAT
