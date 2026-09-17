import { env } from '../config/env.js'
import { getAccountBalance, postLedgerTransaction } from './ledger.js'
import { accrualLedgerEntries, bridgePerSendFeeMinor } from './provider-fees.js'
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
// S = quoted send principal, A = actual USDC draw Bridge reported, D = A − S.
// Recognize what Bridge now owes us (S), the wallet outflow (A), the difference
// as FX slippage, and the explicit Bridge fee this payout will be invoiced for:
//
//   DR due_from_bridge      S
//   DR fx_slippage          D     (D > 0, unfavorable — wallet drew more)
//   CR fx_slippage          |D|   (D < 0, favorable — wallet drew less)
//   CR bridge_wallet_float  A
//   DR provider_fees        F     (accrued Bridge per-send fee)
//   CR bridge_fees_payable  F
//
// The accrual pair joined this batch on 2026-09-11, when the first Bridge
// invoice proved that Bridge's all-zero per-transfer receipts do NOT mean
// Bridge charges nothing per transfer — it bills monthly, out of band, ~$2 a
// send. The comment that used to sit here ("Bridge explicit fee = 0") was the
// reason per-transfer P&L was wrong by more than its own margin. F comes from
// the contract rates in env (SPEI flat + orchestration bps) and is trued up
// against the invoice; see services/provider-fees.ts.
//
// Same batch, not a separate posting: the fee is incurred BY this submission,
// and sharing the (transfer_id, transition) key makes the accrual exactly as
// idempotent as the payout it belongs to — a retried submit can no more
// double-accrue than it can double-draw.
//
// Nets to zero in all cases; the slippage line is omitted when D = 0 and the
// accrual pair when F = 0, because the ledger rejects zero-amount entries
// (see ledger.ts).
export function submittedLedgerEntries(input: {
  sendAmountMinor: number
  actualSourceAmountMinor: number
  /** Test/ops override; defaults to the contract rates in env. */
  providerFeeMinor?: number
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
  entries.push(
    ...accrualLedgerEntries(input.providerFeeMinor ?? bridgePerSendFeeMinor(s).totalMinor),
  )
  return entries
}

// ── Treasury float top-up ──────────────────────────────────────────────────
// The counterpart to the SUBMITTED draw above. Payouts CREDIT
// bridge_wallet_float on every submission, so without a matching debit when the
// wallet is topped up, the account only ever falls — it goes negative on the
// first payout and the daily bridge_wallet_float reconciliation check opens a
// discrepancy against the real Bridge balance. ledger-rules.md specified this
// batch from the start; it had no implementation until out-of-band funding
// made a real top-up routine.
//
//   DR bridge_wallet_float  X   (USDC now sitting at Bridge)
//   CR cash_clearing        X   (cash that left our bank to get it there)
//
// A batch event, not a transfer event: transferId is null and the idempotency
// key is the depositing rail's own reference, so re-running the script for the
// same deposit is a no-op rather than a double-count.
export function floatTopUpLedgerEntries(amountMinor: number): LedgerEntryJson[] {
  if (!Number.isSafeInteger(amountMinor) || amountMinor <= 0) {
    throw new PayoutValidationError(`amountMinor must be a positive integer, got ${amountMinor}`)
  }
  return [
    { account_code: 'bridge_wallet_float', direction: 'debit', amount_minor: amountMinor, currency: 'USD' },
    { account_code: 'cash_clearing', direction: 'credit', amount_minor: amountMinor, currency: 'USD' },
  ]
}

/**
 * Record a treasury wallet top-up. `externalRef` is the depositing transfer's
 * provider id — it becomes the ledger idempotency key, so the same deposit can
 * never be booked twice.
 */
export async function recordFloatTopUp(input: {
  amountMinor: number
  externalRef: string
}): Promise<{ idempotencyKey: string }> {
  const ref = input.externalRef.trim()
  if (!ref) throw new PayoutValidationError('externalRef is required')

  const idempotencyKey = `float_topup:${ref}`
  await postLedgerTransaction({
    idempotencyKey,
    description: `treasury float top-up (${ref})`,
    entries: floatTopUpLedgerEntries(input.amountMinor).map((e) => ({
      accountCode: e.account_code,
      direction: e.direction,
      money: { amountMinor: e.amount_minor, currency: e.currency },
    })),
  })
  return { idempotencyKey }
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

/**
 * The OTHER arm of the `fx_drift` gate: how old the quote is, and whether that
 * age alone is enough to hold the payout.
 *
 * `fx_drift` is one hold reason covering two conditions (jobs/payout-submit.ts),
 * and they are not equally releasable — the difference decides whether the ops
 * board's Release hold button can accomplish anything at all.
 *
 *   DRIFT is not monotone. Rates move back, the next sweep re-measures, and a
 *   release is precisely how an operator says "absorb this as fx_slippage".
 *
 *   AGE only ever grows. Once a quote is past FX_MAX_QUOTE_AGE_MINUTES no
 *   release can clear the hold: the submit job re-runs this same comparison on
 *   the next 1-minute sweep and parks the row again, forever. Measured on
 *   staging 2026-09-14 — two transfers released by hand at 17:33 were re-held
 *   as `fx_drift` 33 seconds later, with quotes ~6,900 minutes old. No money
 *   moves (the gate returns before claimForSubmission and before any Bridge
 *   call), so it costs the operator an action and nothing else; that is still
 *   an action the board should not have offered.
 *
 * EVALUATED NOW, NEVER RECORDED AT HOLD TIME. Which arm tripped first is a fact
 * about the past; whether a release can work is a fact about the present. A
 * hold placed purely on drift becomes un-releasable the moment its quote ages
 * past the bound — so a cause persisted at hold time would report "releasable"
 * for a row that demonstrably is not, and would say nothing at all about the
 * rows already sitting held. `quotes.created_at` against the live env bound is
 * the whole computation, and it needs no new column.
 *
 * ONE COMPARISON, THREE CALLERS. The submit job's gate, the release refusal
 * (services/payout-holds.ts) and the board's read (services/ops-transfer-detail.ts)
 * all come through here, so the gate and the button cannot disagree about what
 * "stale" means. Strict `>`, matching the gate it replaced.
 *
 * The escape hatch is the bound itself: raising FX_MAX_QUOTE_AGE_MINUTES (with
 * Joshua's sign-off, like every other risk bound) makes the same quote fresh
 * and the release goes through. Nothing here is written down to contradict it.
 *
 * AGE IS A STUCK-DETECTOR, NOT AN FX CONTROL — and that is why `fundingCleared`
 * switches it off (2026-09-17). Read the arm's own charter
 * (prds/remittance-mvp.md, "FX submission backstop", decided 2026-07-18): it
 * "caps the unbounded-slippage tail on transfers stuck behind a float-ceiling
 * trip / dry treasury / downed worker", and "fires ~never by design; the 50 bps
 * buffer prices the normal 15-min quote window". Both halves assumed the
 * instant-payout rail it was written for, where `funding_cleared` defaulted OFF
 * and a quote that outlived 15 minutes meant something was WRONG.
 *
 * `WAIT_FOR_CLEARING=true` on the live Stripe ACH rail broke that assumption.
 * Micro-deposit verification (1-2 business days) plus ACH settlement (~4) means
 * a transfer reaches this gate with a quote ~5.5 DAYS old on the happy path —
 * measured in prod 2026-09-17, the first real ACH: quote 7,866 minutes old,
 * drift 122 bps, comfortably inside FX_MAX_DRIFT_BPS. A 240-minute bound is not
 * merely tight on that rail, it is UNSATISFIABLE: every ACH-funded transfer
 * would hold on `fx_drift` forever, for doing exactly what it is supposed to do.
 *
 * So the age arm now asks its original question rather than a proxy for it.
 * Once the funding has cleared, the quote's age is settlement latency we CHOSE
 * to wait for — not evidence the transfer is stuck — and the thing age was
 * standing in for has its own detector now (jobs/stuck-watch.ts). An UNCLEARED
 * row that is old is still genuinely stuck, and still holds: that is the
 * float-ceiling / dry-treasury / downed-worker tail the charter names, intact.
 *
 * The FX exposure this leaves is bounded by the arm that actually measures it:
 * drift is re-read LIVE against FX_MAX_DRIFT_BPS on the same sweep, whatever
 * the quote's age. Age never bounded slippage on its own — it only ever
 * guessed that a stuck row might have drifted, and the line above it knows.
 *
 * Reversal cost, deliberately near zero: this is one predicate, no column, no
 * migration, no backfill. Re-arming the old behaviour is deleting `!fundingCleared`.
 */
export interface QuoteAgeVerdict {
  /** Past FX_MAX_QUOTE_AGE_MINUTES — the submit job will re-hold on this alone. */
  stale: boolean
  ageMinutes: number
  maxAgeMinutes: number
}

/**
 * @param fundingCleared The row's `transfers.funding_cleared`. REQUIRED and
 * positional on purpose: it is the difference between "old because stuck" and
 * "old because we waited for the money", every caller can answer it, and a new
 * caller that cannot must fail to compile rather than silently re-arm the arm
 * on a rail where it cannot be satisfied.
 */
export function assessQuoteAge(
  quoteCreatedAt: string,
  fundingCleared: boolean,
  nowMs: number = Date.now(),
): QuoteAgeVerdict {
  const createdMs = Date.parse(quoteCreatedAt)
  // Corrupt data, not a market condition: throwing keeps every caller failing
  // closed rather than treating an unparseable timestamp as "fresh".
  if (Number.isNaN(createdMs)) {
    throw new PayoutValidationError(`quote created_at is not a parseable timestamp`)
  }
  const ageMinutes = (nowMs - createdMs) / 60_000
  return {
    stale: !fundingCleared && ageMinutes > env.FX_MAX_QUOTE_AGE_MINUTES,
    ageMinutes,
    maxAgeMinutes: env.FX_MAX_QUOTE_AGE_MINUTES,
  }
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
