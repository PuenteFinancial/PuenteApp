import { env } from '../config/env.js'
import { postLedgerTransaction } from './ledger.js'
import { supabaseAdmin } from './supabase.js'
import type { LedgerEntryJson } from './transfers.js'

// Bridge's explicit per-transaction fees — the half of provider cost that the
// FX spread does NOT contain (docs/ledger-rules.md "FX & provider economics").
//
// The thing that makes this file necessary: Bridge's per-transfer receipts
// report developer_fee / exchange_fee / gas_fee all 0.0, so for a year the book
// read as though Bridge charged nothing per transfer. It charges plenty — it
// just bills MONTHLY, out of band (first invoice INV19341, 2026-09-11, $10.30
// against three completed transfers). Waiting for the invoice to recognize the
// cost would mean per-transfer margin is unknowable until the following month,
// and the flat $1.00 SPEI fee is the single biggest input to whether a send is
// profitable at all.
//
// So: ACCRUE what the transfer itself predicts, TRUE UP against the invoice.
//
//   at SUBMITTED   DR provider_fees        F     (estimate, from the contract)
//                  CR bridge_fees_payable  F
//   at invoice     reclassify + book the difference (bookInvoiceLedgerEntries)
//   at payment     DR bridge_fees_payable  T  /  CR cash_clearing  T
//
// The accrual is an ESTIMATE and is never revised per transfer — not even when
// the payout later fails and no SPEI ever executes. That is deliberate: the
// monthly true-up is the correction mechanism, and it catches over-accrual from
// failed payouts by exactly the same arithmetic that catches a Bridge price
// change. Reversing per transfer would add a posting key per refund path for an
// error the true-up already absorbs.
//
// All arithmetic is integer/BigInt — IEEE-754 never touches money.

const BPS_SCALE = 10_000n

/** Bad input to a pure provider-fee computation — a bug, never retryable. */
export class ProviderFeeError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ProviderFeeError'
  }
}

// ── Per-send accrual ───────────────────────────────────────────────────────

export interface BridgePerSendFee {
  /** Flat SPEI payout fee — the number that decides pricing; never amortizes. */
  speiMinor: number
  /** bps on volume. Basis unverified — see the env.ts note and the true-up. */
  orchestrationMinor: number
  totalMinor: number
}

/**
 * What Bridge will bill for one payout, from the contract rates in env.
 *
 * `principalMinor` is the quoted send principal S (send − margin) — the same
 * number the SUBMITTED batch debits to due_from_bridge, so the accrual and the
 * thing it is a cost of are measured on one basis.
 */
export function bridgePerSendFeeMinor(principalMinor: number): BridgePerSendFee {
  if (!Number.isSafeInteger(principalMinor) || principalMinor <= 0) {
    throw new ProviderFeeError(
      `principalMinor must be a positive integer, got ${principalMinor}`,
    )
  }
  const speiMinor = env.BRIDGE_SPEI_FEE_MINOR
  // Half-up at the cent, matching how the invoice rounds its own line
  // ($118.05 × 0.25% = $0.295125, invoiced $0.30). Per-transfer rounding and
  // invoice-total rounding cannot agree exactly; the difference is variance,
  // which is what the monthly check is for.
  const orchestrationMinor = Number(
    (BigInt(principalMinor) * BigInt(env.BRIDGE_ORCHESTRATION_BPS) + BPS_SCALE / 2n) / BPS_SCALE,
  )
  return { speiMinor, orchestrationMinor, totalMinor: speiMinor + orchestrationMinor }
}

/**
 * The accrual pair that rides inside the SUBMITTED batch: recognize the cost as
 * an expense now, owe it to Bridge until the invoice is paid.
 *
 * Returns [] when the accrual is zero (both knobs off, or a principal small
 * enough that bps rounds to nothing and the flat fee is disabled) — the ledger
 * rejects zero-amount entries, and an empty accrual leaves the rest of the
 * SUBMITTED batch balanced exactly as it was before this existed.
 */
export function accrualLedgerEntries(feeMinor: number): LedgerEntryJson[] {
  if (!Number.isSafeInteger(feeMinor) || feeMinor < 0) {
    throw new ProviderFeeError(`feeMinor must be a non-negative integer, got ${feeMinor}`)
  }
  if (feeMinor === 0) return []
  return [
    { account_code: 'provider_fees', direction: 'debit', amount_minor: feeMinor, currency: 'USD' },
    {
      account_code: 'bridge_fees_payable',
      direction: 'credit',
      amount_minor: feeMinor,
      currency: 'USD',
    },
  ]
}

// ── Invoice classification ─────────────────────────────────────────────────

/**
 * Which bucket an invoice line belongs to, and therefore which account books it.
 *
 *   accruable  — per-send cost we predicted at SUBMITTED. Compared against the
 *                accrual; only the difference posts at invoice time.
 *   onboarding — ONE-TIME PER CUSTOMER. Acquisition cost, not transfer cost:
 *                on the first invoice these were $6.50 of $10.30, and folding
 *                them into provider_fees would have charged 63% of the month's
 *                provider bill to whichever transfers happened to post that
 *                month. Books to provider_onboarding_fees.
 *   other      — real per-period cost we do NOT accrue because no transfer
 *                predicts it: the ACH fee attaches to treasury top-ups rather
 *                than sends, and gas is unpredictable. Books to provider_fees
 *                at invoice time — unaccrued, never unbooked.
 */
export type ProviderFeeCategory = 'accruable' | 'onboarding' | 'other'

export const PROVIDER_FEE_CATEGORIES: readonly ProviderFeeCategory[] = [
  'accruable',
  'onboarding',
  'other',
]

// Matched against the invoice label, lowercased. Substrings, because Bridge
// decorates its labels with parentheticals ("Wallet Fee (active/created)",
// "Individual Compliance Fee (created accounts)") that are not stable.
const LINE_PATTERNS: ReadonlyArray<{ match: string; category: ProviderFeeCategory }> = [
  { match: 'spei fee', category: 'accruable' },
  { match: 'orchestration volume fee', category: 'accruable' },
  { match: 'individual compliance fee', category: 'onboarding' },
  { match: 'wallet fee', category: 'onboarding' },
  { match: 'next day ach fee', category: 'other' },
  { match: 'gas', category: 'other' },
]

/**
 * Classify one invoice line by its label, or null when we do not recognize it.
 *
 * Null is the POINT, not a shortcoming: an unrecognized line is Bridge charging
 * for something new, which is exactly the silent-margin-erosion event this
 * whole slice exists to surface. The recorder refuses such an invoice until a
 * human states the category explicitly.
 */
export function classifyInvoiceLine(label: string): ProviderFeeCategory | null {
  const normalized = label.trim().toLowerCase()
  if (!normalized) return null
  for (const { match, category } of LINE_PATTERNS) {
    if (normalized.includes(match)) return category
  }
  return null
}

export interface ProviderInvoiceLineInput {
  label: string
  amountMinor: number
  /** Verbatim from the invoice, for the record — never used in arithmetic. */
  quantity?: string
  rate?: string
  /** Explicit override when the label is new. Recorded as stated. */
  category?: ProviderFeeCategory
}

export interface ClassifiedInvoiceLine extends ProviderInvoiceLineInput {
  category: ProviderFeeCategory
  /**
   * True when the recorded category is NOT what this label classifies to —
   * either because we did not recognize the label at all, or because the
   * operator deliberately overrode our reading of one we did. Both are a human
   * decision about where real money lands, and both belong on the record.
   */
  categoryOverridden: boolean
}

export interface ClassifiedInvoice {
  lines: ClassifiedInvoiceLine[]
  accruableMinor: number
  onboardingMinor: number
  otherMinor: number
  totalMinor: number
  /** Provider-side sub-cent rounding absorbed into `other`; usually 0. */
  roundingMinor: number
}

/**
 * The provider's OWN sub-cent rounding, in minor units, that the classified
 * buckets may absorb before a line-sum mismatch counts as a transcription error.
 *
 * INV19341 is the worked case and the reason this is not zero. Its printed
 * lines sum to $10.31; it bills $10.30, because Bridge rounds the TOTAL, not
 * each line:
 *
 *   2.00 + 0.50 + 0.295125 + 1.50 + 0.006472 + 6.00 = 10.301597 → $10.30
 *              (orchestration)      (gas)
 *
 * The invoice total is what we will actually pay, so it is authoritative and
 * the difference books to `other`. Five cents is far below any plausible
 * mistyped or dropped line, so the guard still does its real job — catching a
 * transcription error before it corrupts the true-up.
 */
export const INVOICE_ROUNDING_TOLERANCE_MINOR = 5

/** Marks the synthetic line that carries the provider's rounding difference. */
export const ROUNDING_LINE_LABEL = '(provider sub-cent rounding)'

/**
 * Classify every line and roll the buckets up against the invoice's stated
 * total. Throws on an unrecognized label with no explicit category, and on a
 * line sum that misses the stated total by more than the provider's own
 * rounding — either would corrupt the true-up.
 */
export function classifyInvoice(
  lines: ProviderInvoiceLineInput[],
  statedTotalMinor?: number,
): ClassifiedInvoice {
  if (lines.length === 0) throw new ProviderFeeError('an invoice needs at least one line')

  const classified: ClassifiedInvoiceLine[] = lines.map((line) => {
    if (!Number.isSafeInteger(line.amountMinor) || line.amountMinor < 0) {
      throw new ProviderFeeError(
        `line "${line.label}": amountMinor must be a non-negative integer, got ${line.amountMinor}`,
      )
    }
    if (line.category) {
      if (!PROVIDER_FEE_CATEGORIES.includes(line.category)) {
        throw new ProviderFeeError(
          `line "${line.label}": unknown category "${line.category}"; expected one of ${PROVIDER_FEE_CATEGORIES.join(', ')}`,
        )
      }
      return {
        ...line,
        category: line.category,
        categoryOverridden: classifyInvoiceLine(line.label) !== line.category,
      }
    }
    const category = classifyInvoiceLine(line.label)
    if (!category) {
      throw new ProviderFeeError(
        `unrecognized invoice line "${line.label}" — Bridge is billing for something new. ` +
          `Decide what it is and state its category (${PROVIDER_FEE_CATEGORIES.join(' | ')}) on the line, ` +
          `then add it to LINE_PATTERNS so the next invoice classifies itself.`,
      )
    }
    return { ...line, category, categoryOverridden: false }
  })

  const sumOf = (category: ProviderFeeCategory): number =>
    classified.reduce((sum, l) => (l.category === category ? sum + l.amountMinor : sum), 0)

  const accruableMinor = sumOf('accruable')
  const onboardingMinor = sumOf('onboarding')
  const lineOtherMinor = sumOf('other')
  const lineTotalMinor = accruableMinor + onboardingMinor + lineOtherMinor

  if (statedTotalMinor === undefined) {
    return {
      lines: classified,
      accruableMinor,
      onboardingMinor,
      otherMinor: lineOtherMinor,
      totalMinor: lineTotalMinor,
      roundingMinor: 0,
    }
  }

  const roundingMinor = statedTotalMinor - lineTotalMinor
  if (Math.abs(roundingMinor) > INVOICE_ROUNDING_TOLERANCE_MINOR) {
    throw new ProviderFeeError(
      `invoice lines sum to ${lineTotalMinor} minor units but the invoice states ${statedTotalMinor} — ` +
        `a difference of ${roundingMinor} is too large to be the provider's sub-cent rounding ` +
        `(tolerance ${INVOICE_ROUNDING_TOLERANCE_MINOR}); a line is missing or mistyped`,
    )
  }
  const otherMinor = lineOtherMinor + roundingMinor
  if (otherMinor < 0) {
    throw new ProviderFeeError(
      `the provider's rounding difference (${roundingMinor}) exceeds the unaccrued lines it would ` +
        `book against (${lineOtherMinor}); record the invoice without a stated total and reconcile by hand`,
    )
  }
  const recordedLines =
    roundingMinor === 0
      ? classified
      : [
          ...classified,
          {
            label: ROUNDING_LINE_LABEL,
            amountMinor: roundingMinor,
            category: 'other' as const,
            categoryOverridden: false,
          },
        ]
  return {
    lines: recordedLines,
    accruableMinor,
    onboardingMinor,
    otherMinor,
    totalMinor: statedTotalMinor,
    roundingMinor,
  }
}

// ── Invoice postings ───────────────────────────────────────────────────────

export interface BookInvoiceInput {
  onboardingMinor: number
  otherMinor: number
  /** Invoiced total of the accruable lines. */
  accruableMinor: number
  /** What we already accrued for this period (credits to the payable). */
  accruedMinor: number
  payableAccountCode: string
}

/**
 * The true-up batch. Everything already accrued is already expensed and already
 * owed; this posts only what the accrual did not cover:
 *
 *   DR provider_onboarding_fees   onboarding
 *   DR provider_fees              other + variance      (variance = invoiced
 *   CR provider_fees              |other + variance|     accruable − accrued;
 *                                                        credit when we
 *                                                        over-accrued)
 *   CR bridge_fees_payable        onboarding + other + variance
 *
 * Nets to zero for every sign of every term, including an over-accrual large
 * enough to flip the payable line to a debit. Returns [] when there is nothing
 * to post — the accrual matched exactly and the invoice had no onboarding or
 * unaccrued lines — which is a fully booked invoice, not an unbooked one (see
 * provider_invoices.booked_at).
 */
export function bookInvoiceLedgerEntries(input: BookInvoiceInput): LedgerEntryJson[] {
  const { onboardingMinor, otherMinor, accruableMinor, accruedMinor, payableAccountCode } = input
  for (const [name, value] of Object.entries({
    onboardingMinor,
    otherMinor,
    accruableMinor,
    accruedMinor,
  })) {
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new ProviderFeeError(`${name} must be a non-negative integer, got ${value}`)
    }
  }

  const varianceMinor = accruableMinor - accruedMinor
  const feesDelta = otherMinor + varianceMinor
  const payableDelta = onboardingMinor + feesDelta

  const entries: LedgerEntryJson[] = []
  const push = (account: string, delta: number, normal: 'debit' | 'credit'): void => {
    if (delta === 0) return
    const opposite = normal === 'debit' ? 'credit' : 'debit'
    entries.push({
      account_code: account,
      direction: delta > 0 ? normal : opposite,
      amount_minor: Math.abs(delta),
      currency: 'USD',
    })
  }
  push('provider_onboarding_fees', onboardingMinor, 'debit')
  push('provider_fees', feesDelta, 'debit')
  push(payableAccountCode, payableDelta, 'credit')

  // One non-zero delta cannot balance: the three deltas satisfy
  // payable = onboarding + fees by construction, so exactly one non-zero is
  // arithmetically impossible. Assert rather than post an unbalanced batch.
  if (entries.length === 1) {
    throw new ProviderFeeError(
      `invoice booking produced a single unbalanced entry (onboarding=${onboardingMinor}, other=${otherMinor}, variance=${varianceMinor})`,
    )
  }
  return entries
}

/** Paying the invoice: the liability is discharged in cash. */
export function payInvoiceLedgerEntries(
  totalMinor: number,
  payableAccountCode: string,
): LedgerEntryJson[] {
  if (!Number.isSafeInteger(totalMinor) || totalMinor <= 0) {
    throw new ProviderFeeError(`totalMinor must be a positive integer, got ${totalMinor}`)
  }
  return [
    {
      account_code: payableAccountCode,
      direction: 'debit',
      amount_minor: totalMinor,
      currency: 'USD',
    },
    { account_code: 'cash_clearing', direction: 'credit', amount_minor: totalMinor, currency: 'USD' },
  ]
}

// ── Persistence ────────────────────────────────────────────────────────────

export interface ProviderInvoiceRow {
  id: string
  provider: string
  invoice_number: string
  period_start: string
  period_end: string
  issued_at: string | null
  due_at: string | null
  currency: string
  total_minor: number
  accruable_minor: number
  onboarding_minor: number
  other_minor: number
  lines: ClassifiedInvoiceLine[]
  payable_account_code: string
  booked_at: string | null
  booked_transaction_id: string | null
  paid_at: string | null
  paid_transaction_id: string | null
  recorded_by: string
}

export interface RecordProviderInvoiceInput {
  provider: 'bridge'
  invoiceNumber: string
  periodStart: string
  periodEnd: string
  issuedAt?: string
  dueAt?: string
  lines: ProviderInvoiceLineInput[]
  statedTotalMinor?: number
  recordedBy: string
  payableAccountCode?: string
}

/**
 * Record a received invoice. Idempotent on (provider, invoice_number): a
 * re-run returns the existing row rather than duplicating the bill, so the
 * operator CLI is safe to re-run mid-incident.
 */
export async function recordProviderInvoice(
  input: RecordProviderInvoiceInput,
): Promise<{ invoice: ProviderInvoiceRow; created: boolean }> {
  const classified = classifyInvoice(input.lines, input.statedTotalMinor)

  const existing = await findProviderInvoice(input.provider, input.invoiceNumber)
  if (existing) return { invoice: existing, created: false }

  const { data, error } = await supabaseAdmin
    .from('provider_invoices')
    .insert({
      provider: input.provider,
      invoice_number: input.invoiceNumber,
      period_start: input.periodStart,
      period_end: input.periodEnd,
      issued_at: input.issuedAt ?? null,
      due_at: input.dueAt ?? null,
      total_minor: classified.totalMinor,
      accruable_minor: classified.accruableMinor,
      onboarding_minor: classified.onboardingMinor,
      other_minor: classified.otherMinor,
      lines: classified.lines,
      recorded_by: input.recordedBy,
      ...(input.payableAccountCode && { payable_account_code: input.payableAccountCode }),
    })
    .select('*')
    .single()
  if (error) throw new Error(`provider invoice insert failed: ${error.message}`)
  return { invoice: data as ProviderInvoiceRow, created: true }
}

export async function findProviderInvoice(
  provider: string,
  invoiceNumber: string,
): Promise<ProviderInvoiceRow | null> {
  const { data, error } = await supabaseAdmin
    .from('provider_invoices')
    .select('*')
    .eq('provider', provider)
    .eq('invoice_number', invoiceNumber)
    .maybeSingle()
  if (error) throw new Error(`provider invoice read failed: ${error.message}`)
  return (data as ProviderInvoiceRow | null) ?? null
}

/**
 * What we accrued inside a service period — the number an invoice is trued up
 * against. One SQL function serves both callers (the reconciliation check joins
 * it per recorded invoice; the recorder's dry run calls it for a period that has
 * no row yet), so the cron and the CLI can never disagree about the variance.
 */
export async function accruedInPeriod(
  periodStart: string,
  periodEnd: string,
  payableAccountCode = 'bridge_fees_payable',
): Promise<number> {
  const { data, error } = await supabaseAdmin.rpc('provider_fee_accrued_in_period', {
    p_account_code: payableAccountCode,
    p_from: periodStart,
    p_to: periodEnd,
  })
  if (error) throw new Error(`provider_fee_accrued_in_period failed: ${error.message}`)
  return Number(data ?? 0)
}

export interface AccrualReconciliationRow {
  invoice_id: string
  invoice_number: string
  provider: string
  period_start: string
  period_end: string
  total_minor: number
  accruable_minor: number
  onboarding_minor: number
  other_minor: number
  accrued_minor: number
  variance_minor: number
  booked: boolean
  paid: boolean
}

export async function readAccrualReconciliation(): Promise<AccrualReconciliationRow[]> {
  const { data, error } = await supabaseAdmin.rpc('reconcile_provider_fee_accrual')
  if (error) throw new Error(`reconcile_provider_fee_accrual failed: ${error.message}`)
  return (data ?? []) as AccrualReconciliationRow[]
}

export interface UnbilledAccrualRow {
  earliest_day: string
  latest_day: string
  accrued_minor: number
  day_count: number
}

export async function readUnbilledAccruals(
  payableAccountCode = 'bridge_fees_payable',
): Promise<UnbilledAccrualRow | null> {
  const { data, error } = await supabaseAdmin.rpc('reconcile_provider_fee_unbilled', {
    p_account_code: payableAccountCode,
  })
  if (error) throw new Error(`reconcile_provider_fee_unbilled failed: ${error.message}`)
  const rows = (data ?? []) as UnbilledAccrualRow[]
  return rows[0] ?? null
}

/**
 * Post the true-up for a recorded invoice and stamp it booked.
 *
 * Idempotent twice over: the ledger dedupes on `provider_invoice:<id>:booked`,
 * and a re-run against an already-booked row short-circuits before posting.
 * That pairing also makes the crash between the two steps self-healing — the
 * reconciliation check flags the unstamped row, and re-running recomputes the
 * same entries (the service period is closed, so its accrual total cannot move)
 * against the same key, which posts nothing and stamps.
 *
 * The read-then-post is not transactional, which only matters for an invoice
 * covering a period that is still OPEN: an accrual landing between the two
 * would not be in the variance. Invoices arrive after their period closes, and
 * a stale variance on a deliberately early booking shows up as next month's
 * finding rather than as a wrong ledger — the postings themselves stay exact.
 */
export async function bookProviderInvoice(
  invoice: ProviderInvoiceRow,
): Promise<{ posted: boolean; alreadyBooked: boolean; entries: LedgerEntryJson[] }> {
  if (invoice.booked_at) return { posted: false, alreadyBooked: true, entries: [] }

  const accruedMinor = await accruedInPeriod(
    invoice.period_start,
    invoice.period_end,
    invoice.payable_account_code,
  )
  const entries = bookInvoiceLedgerEntries({
    onboardingMinor: invoice.onboarding_minor,
    otherMinor: invoice.other_minor,
    accruableMinor: invoice.accruable_minor,
    accruedMinor,
    payableAccountCode: invoice.payable_account_code,
  })

  let transactionId: string | null = null
  if (entries.length > 0) {
    const tx = await postLedgerTransaction({
      idempotencyKey: `provider_invoice:${invoice.id}:booked`,
      description: `${invoice.provider} invoice ${invoice.invoice_number} — true-up against accruals`,
      entries: entries.map(toLedgerEntryInput),
    })
    transactionId = tx.id
  }

  await stampInvoice(invoice.id, {
    booked_at: new Date().toISOString(),
    booked_transaction_id: transactionId,
  })
  return { posted: entries.length > 0, alreadyBooked: false, entries }
}

/** Post the cash payment for a booked invoice and stamp it paid. */
export async function payProviderInvoice(
  invoice: ProviderInvoiceRow,
): Promise<{ posted: boolean; alreadyPaid: boolean; entries: LedgerEntryJson[] }> {
  if (!invoice.booked_at) {
    throw new ProviderFeeError(
      `invoice ${invoice.invoice_number} has not been booked — paying it would debit a payable the book never recognized`,
    )
  }
  if (invoice.paid_at) return { posted: false, alreadyPaid: true, entries: [] }

  const entries = payInvoiceLedgerEntries(invoice.total_minor, invoice.payable_account_code)
  const tx = await postLedgerTransaction({
    idempotencyKey: `provider_invoice:${invoice.id}:paid`,
    description: `${invoice.provider} invoice ${invoice.invoice_number} — paid`,
    entries: entries.map(toLedgerEntryInput),
  })
  await stampInvoice(invoice.id, {
    paid_at: new Date().toISOString(),
    paid_transaction_id: tx.id,
  })
  return { posted: true, alreadyPaid: false, entries }
}

function toLedgerEntryInput(entry: LedgerEntryJson): {
  accountCode: string
  direction: 'debit' | 'credit'
  money: { amountMinor: number; currency: 'USD' }
} {
  return {
    accountCode: entry.account_code,
    direction: entry.direction,
    money: { amountMinor: entry.amount_minor, currency: entry.currency },
  }
}

async function stampInvoice(id: string, patch: Record<string, unknown>): Promise<void> {
  const { error } = await supabaseAdmin.from('provider_invoices').update(patch).eq('id', id)
  if (error) throw new Error(`provider invoice stamp failed: ${error.message}`)
}
