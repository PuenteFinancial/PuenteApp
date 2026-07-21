import { env } from '../config/env.js'
import { getAccountBalance } from './ledger.js'
import { supabaseAdmin } from './supabase.js'
import type { LedgerEntryJson } from './transfers.js'

// Payout-submission support for the payout.submit job (slice 5 PR 2): the
// SUBMITTED ledger batch, the FX drift computation, strict decimal↔minor
// converters for Bridge amounts, the payability gate, and the crude float
// ceiling (decision 4). All amount/rate arithmetic is integer/BigInt —
// IEEE-754 never touches money (same rule as quotes.ts / ledger.ts).

const RATE_SCALE_8 = 10n ** 8n
const BPS_SCALE = 10_000n
const MAX_SAFE = BigInt(Number.MAX_SAFE_INTEGER)

/** Bad input to a pure payout computation — a bug or corrupt data, never retryable. */
export class PayoutValidationError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'PayoutValidationError'
  }
}

// ── SUBMITTED ledger batch ─────────────────────────────────────────────────
// S = quoted send principal, A = actual USDC draw Bridge reported,
// D = A − S (Bridge explicit fee = 0). Recognize what Bridge now owes us (S),
// the wallet outflow (A), and the difference as FX slippage:
//
//   DR due_from_bridge      S
//   DR fx_slippage          D     (D > 0, unfavorable — wallet drew more)
//   CR fx_slippage          |D|   (D < 0, favorable — wallet drew less)
//   CR bridge_wallet_float  A
//
// Nets to zero in all cases; the slippage line is omitted when D = 0 because
// the ledger rejects zero-amount entries (see ledger.ts).
export function submittedLedgerEntries(input: {
  sendAmountMinor: number
  actualSourceAmountMinor: number
}): LedgerEntryJson[] {
  const { sendAmountMinor: s, actualSourceAmountMinor: a } = input
  if (!Number.isSafeInteger(s) || s <= 0) {
    throw new PayoutValidationError(`sendAmountMinor must be a positive integer, got ${s}`)
  }
  if (!Number.isSafeInteger(a) || a <= 0) {
    throw new PayoutValidationError(`actualSourceAmountMinor must be a positive integer, got ${a}`)
  }
  const d = a - s
  const entries: LedgerEntryJson[] = [
    { account_code: 'due_from_bridge', direction: 'debit', amount_minor: s, currency: 'USD' },
  ]
  if (d > 0) {
    entries.push({ account_code: 'fx_slippage', direction: 'debit', amount_minor: d, currency: 'USD' })
  } else if (d < 0) {
    entries.push({ account_code: 'fx_slippage', direction: 'credit', amount_minor: -d, currency: 'USD' })
  }
  entries.push({
    account_code: 'bridge_wallet_float',
    direction: 'credit',
    amount_minor: a,
    currency: 'USD',
  })
  return entries
}

// ── FX drift ───────────────────────────────────────────────────────────────
// Rate grammar for the drift comparison: quotes.source_rate is numeric(18,8)
// (up to 10 integer digits) and Bridge buy_rate caps at 6 — accept the wider
// column bound, up to 8 fractional digits. Reject, never truncate: an
// unparseable rate means unknown drift, and we never submit on unknown drift.
const DRIFT_RATE_PATTERN = /^\d{1,10}(\.\d{1,8})?$/

function parseRateScale8(value: string, label: string): bigint {
  if (typeof value !== 'string' || !DRIFT_RATE_PATTERN.test(value)) {
    throw new PayoutValidationError(`${label} is not a valid decimal rate string`)
  }
  const [intPart = '0', fracPart = ''] = value.split('.')
  const scaled = BigInt(intPart) * RATE_SCALE_8 + BigInt(fracPart.padEnd(8, '0'))
  if (scaled <= 0n) {
    throw new PayoutValidationError(`${label} must be positive`)
  }
  return scaled
}

/**
 * FX submission backstop (decision 7): |live − source| · 10000 / source in
 * basis points, scaled-BigInt with integer division (a sub-bp remainder
 * rounds toward zero — a 199.9-bps drift reads 199, which only ever errs on
 * the permissive side of a >= threshold check by less than one bp).
 */
export function computeDriftBps(liveRate: string, sourceRate: string): number {
  const live8 = parseRateScale8(liveRate, 'liveRate')
  const source8 = parseRateScale8(sourceRate, 'sourceRate')
  const diff8 = live8 >= source8 ? live8 - source8 : source8 - live8
  const bps = (diff8 * BPS_SCALE) / source8
  if (bps > MAX_SAFE) {
    // >2^53 bps of drift is corrupt data, not a market move.
    throw new PayoutValidationError('drift exceeds representable basis points')
  }
  return Number(bps)
}

// ── Decimal ↔ minor-unit converters (2-dp currencies) ──────────────────────

// The plan's "strict 2-dp; alert on more precision" gate for Bridge
// source.amount: digits with at most 2 decimal places, nothing else. A 3rd
// decimal from Bridge (USDC is 6-dp on chain) must throw so the job alerts
// instead of silently rounding money.
const DECIMAL_2DP_PATTERN = /^\d+(\.\d{1,2})?$/

/** Strict decimal string → integer minor units ('3960.14' → 396014). No float arithmetic. */
export function parseDecimalToMinor(value: string): number {
  if (typeof value !== 'string' || !DECIMAL_2DP_PATTERN.test(value)) {
    throw new PayoutValidationError(
      `expected a non-negative decimal string with at most 2 decimal places, got ${JSON.stringify(value)}`,
    )
  }
  const [intPart = '0', fracPart = ''] = value.split('.')
  const minor = BigInt(intPart) * 100n + BigInt(fracPart.padEnd(2, '0'))
  if (minor > MAX_SAFE) {
    throw new PayoutValidationError('amount exceeds safe integer minor units')
  }
  return Number(minor)
}

/** Integer minor units → exact 2-dp decimal string (396014 → '3960.14'). */
export function minorToDecimal(minor: number): string {
  if (!Number.isSafeInteger(minor) || minor < 0) {
    throw new PayoutValidationError(`minor units must be a non-negative integer, got ${minor}`)
  }
  const big = BigInt(minor)
  return `${big / 100n}.${(big % 100n).toString().padStart(2, '0')}`
}

// ── Payability gate ────────────────────────────────────────────────────────

export type PayabilityResult =
  | { payable: true; providerAccountRef: string }
  | { payable: false; reason: string }

interface PayabilityRow {
  status: string
  provider_account_ref: string | null
  // Supabase embeds a many-to-one !inner join as an object, but the generated
  // types sometimes widen it to an array — handle both shapes.
  recipients: { status: string } | { status: string }[] | null
}

/**
 * Single joined query deciding whether the payout.submit job may pay this
 * destination: destination active AND recipient active AND Bridge external
 * account registered. Deliberately NOT verification_status — that column is
 * dormant (a Bridge 201 means REGISTERED, not verified; no real
 * Verification-of-Payee exists for MXN CLABE — see the payout_destinations
 * migration comment). Reasons are short stable strings, never PII.
 */
export async function checkPayability(payoutDestinationId: string): Promise<PayabilityResult> {
  const { data, error } = await supabaseAdmin
    .from('payout_destinations')
    .select('status, provider_account_ref, recipients!inner(status)')
    .eq('id', payoutDestinationId)
    .maybeSingle()
  if (error) throw new Error(`payability query failed: ${error.message}`)
  const row = data as PayabilityRow | null
  if (!row) return { payable: false, reason: 'destination_not_found' }

  if (row.status !== 'active') return { payable: false, reason: 'destination_not_active' }
  const recipient = Array.isArray(row.recipients) ? row.recipients[0] : row.recipients
  if (!recipient || recipient.status !== 'active') {
    return { payable: false, reason: 'recipient_not_active' }
  }
  if (!row.provider_account_ref) {
    return { payable: false, reason: 'provider_account_ref_missing' }
  }
  return { payable: true, providerAccountRef: row.provider_account_ref }
}

// ── Float ceiling (decision 4) ─────────────────────────────────────────────

/**
 * Crude aggregate float ceiling: pause payout submission while the
 * funding_receivable balance (money fronted but not yet collected) is at or
 * above FLOAT_CEILING_MINOR. Tripping sets NO hold — the sweep retries each
 * minute as the balance drains (self-healing backpressure).
 *
 * A missing FLOAT_CEILING_MINOR is a config error, not a pass: this is a
 * risk-control knob, so the job must fail loudly (pg-boss retries, Sentry on
 * exhaustion) rather than silently skip the control.
 */
export async function isFloatCeilingTripped(): Promise<{
  tripped: boolean
  balanceMinor: number
  ceilingMinor: number
}> {
  const ceilingMinor = env.FLOAT_CEILING_MINOR
  if (ceilingMinor === undefined) {
    throw new Error(
      'FLOAT_CEILING_MINOR is not set: refusing to submit payouts without the float ceiling control',
    )
  }
  const balance = await getAccountBalance('funding_receivable')
  return { tripped: balance.amountMinor >= ceilingMinor, balanceMinor: balance.amountMinor, ceilingMinor }
}
