// Pure formatting + timing helpers for the send flow. Extracted from QuoteScreen
// so the money-display, expiry, and quote-shape logic is unit-testable in
// isolation (it was previously private to the .tsx and untestable).

export interface Money {
  amountMinor: number
  currency: string
}

export interface Quote {
  id: string
  payoutDestinationId: string
  totalAmount: Money
  feeAmount: Money
  receiveAmount: Money
  fxRate: string
  expiresAt: string
  status: string
}

// USD minor units → "$1,234.56"
export function formatUsd(minor: number): string {
  return `$${(minor / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
}

// MXN minor units → "1,234.56 MXN". Grouping is identical across en-US/es-MX;
// the explicit code keeps it unambiguous next to the USD "$" amounts.
export function formatMxn(minor: number): string {
  return `${(minor / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} MXN`
}

// seconds → "14:59"; clamped at 0 so the clock never shows a negative time.
export function mmss(totalSeconds: number): string {
  const s = Math.max(0, Math.floor(totalSeconds))
  const m = Math.floor(s / 60)
  const r = s % 60
  return `${m}:${r.toString().padStart(2, '0')}`
}

// Whole seconds remaining until an ISO timestamp, relative to nowMs. May be
// negative once past — callers derive `expired` from `<= 0`.
export function secondsUntil(iso: string, nowMs: number): number {
  return Math.round((new Date(iso).getTime() - nowMs) / 1000)
}

function isMoney(v: unknown): boolean {
  return (
    typeof v === 'object' && v !== null && typeof (v as { amountMinor?: unknown }).amountMinor === 'number'
  )
}

// Minimal shape guard for a quote body before we trust it. A 2xx response that
// isn't actually a quote (e.g. a gateway 200 + HTML slipping past the proxy)
// must not become setQuote({}) → NaN countdown + a render-time TypeError.
export function isQuoteShape(body: unknown): body is Quote {
  if (typeof body !== 'object' || body === null) return false
  const q = body as Record<string, unknown>
  return (
    typeof q.id === 'string' &&
    typeof q.expiresAt === 'string' &&
    typeof q.fxRate === 'string' &&
    isMoney(q.totalAmount) &&
    isMoney(q.feeAmount) &&
    isMoney(q.receiveAmount)
  )
}
