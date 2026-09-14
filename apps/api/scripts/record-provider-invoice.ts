// Record a provider invoice (Bridge, monthly) on the ledger.
//
// Bridge's per-transfer receipts report every fee as 0.0, but Bridge does charge
// per transaction — it bills MONTHLY, out of band. Until 2026-09-11 nothing in
// this system had ever seen one of those bills: `provider_fees` held zero
// entries in prod while invoice INV19341 ($10.30) sat in an inbox. The payout
// path now ACCRUES the predictable per-send part at submission; this script is
// the other half — it records the real invoice, posts the difference, and
// leaves the daily `provider_fee_accrual` check something to compare against.
//
// Three things happen, in order:
//
//   1. RECORD   the invoice into provider_invoices, with every line classified
//               (accruable / onboarding / other). An unrecognized label is a
//               hard stop — that is Bridge charging for something new, and it
//               is precisely the event that would otherwise eat margin in
//               silence. State the category on the line to proceed.
//   2. BOOK     the true-up:
//                 DR provider_onboarding_fees   one-time per-customer lines
//                 DR/CR provider_fees           unaccrued lines + variance
//                 CR bridge_fees_payable        the balancing liability
//   3. PAY      (--pay, when the money actually leaves):
//                 DR bridge_fees_payable / CR cash_clearing
//
// Run PAY only once the payment has actually settled. The ledger records what
// is true, and a payment booked against money still in flight overstates cash.
//
// Usage:
//   tsx scripts/record-provider-invoice.ts --file <invoice.json> [--confirm] [--pay]
//
//   --file <path>  the invoice transcribed to JSON (shape below)
//   --confirm      actually record + book; WITHOUT it this is a dry run
//   --pay          also post the cash payment leg (implies the invoice is paid)
//
// Invoice JSON — amounts are dollar strings, transcribed exactly as printed:
//
//   {
//     "provider": "bridge",
//     "invoiceNumber": "INV19341",
//     "periodStart": "2026-08-01",
//     "periodEnd": "2026-08-31",
//     "issuedAt": "2026-09-01",
//     "dueAt": "2026-09-30",
//     "total": "10.30",
//     "lines": [
//       { "label": "SPEI Fee",                     "quantity": "2",       "rate": "1.00",  "amount": "2.00" },
//       { "label": "Wallet Fee (active/created)",  "quantity": "2",       "rate": "0.25",  "amount": "0.50" },
//       { "label": "Orchestration Volume Fee",     "quantity": "118.05",  "rate": "0.25%", "amount": "0.30" },
//       { "label": "Next Day ACH Fee",             "quantity": "3",       "rate": "0.50",  "amount": "1.50" },
//       { "label": "Gas",                          "quantity": "0.006472","rate": "1.00",  "amount": "0.01" },
//       { "label": "Individual Compliance Fee (created accounts)", "quantity": "3", "rate": "2.00", "amount": "6.00" }
//     ]
//   }
//
// `total` is checked against the lines: a transcription slip in either
// direction corrupts the true-up, so it must reconcile before anything posts.
//
// This imports src/services/*, so config/env.ts validates the full environment:
//   doppler run -- pnpm exec tsx scripts/record-provider-invoice.ts …   (staging/prod)
//   node --env-file=.env --import tsx scripts/record-provider-invoice.ts …   (local)
//
// A script, not an HTTP surface — nothing here is reachable over the network.
import { readFileSync } from 'node:fs'
import { z } from 'zod'
import { formatMoney } from '@puente/shared'
import {
  bookInvoiceLedgerEntries,
  bookProviderInvoice,
  payInvoiceLedgerEntries,
  accruedInPeriod,
  classifyInvoice,
  findProviderInvoice,
  payProviderInvoice,
  recordProviderInvoice,
  type ProviderInvoiceLineInput,
} from '../src/services/provider-fees.js'
import { getAccountBalance } from '../src/services/ledger.js'
import type { LedgerEntryJson } from '../src/services/transfers.js'

const KNOWN_FLAGS = ['--file', '--confirm', '--pay']

// Dollars → minor units without float arithmetic (same rule as every other
// money path: IEEE-754 never touches an amount). Accepts an optional leading
// "$" because that is how the number is printed on the invoice.
export function parseUsdToMinor(input: string, field: string): number {
  const match = /^\$?(\d{1,12})(?:\.(\d{1,2}))?$/.exec(input.trim())
  if (!match) {
    throw new Error(`${field} must be dollars like 10.30, got "${input}"`)
  }
  const minor = BigInt(match[1]!) * 100n + BigInt((match[2] ?? '').padEnd(2, '0'))
  if (minor > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error(`${field} is implausibly large`)
  return Number(minor)
}

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'expected an ISO date (YYYY-MM-DD)')

const invoiceFileSchema = z.object({
  provider: z.literal('bridge'),
  invoiceNumber: z.string().min(1),
  periodStart: isoDate,
  periodEnd: isoDate,
  issuedAt: isoDate.optional(),
  dueAt: isoDate.optional(),
  total: z.string().min(1),
  lines: z
    .array(
      z.object({
        label: z.string().min(1),
        amount: z.string().min(1),
        quantity: z.string().optional(),
        rate: z.string().optional(),
        category: z.enum(['accruable', 'onboarding', 'other']).optional(),
      }),
    )
    .min(1),
})

export interface ParsedInvoiceFile {
  provider: 'bridge'
  invoiceNumber: string
  periodStart: string
  periodEnd: string
  issuedAt?: string
  dueAt?: string
  statedTotalMinor: number
  lines: ProviderInvoiceLineInput[]
}

export function parseInvoiceFile(raw: unknown): ParsedInvoiceFile {
  const parsed = invoiceFileSchema.parse(raw)
  if (parsed.periodEnd < parsed.periodStart) {
    throw new Error(`periodEnd ${parsed.periodEnd} is before periodStart ${parsed.periodStart}`)
  }
  return {
    provider: parsed.provider,
    invoiceNumber: parsed.invoiceNumber,
    periodStart: parsed.periodStart,
    periodEnd: parsed.periodEnd,
    ...(parsed.issuedAt && { issuedAt: parsed.issuedAt }),
    ...(parsed.dueAt && { dueAt: parsed.dueAt }),
    statedTotalMinor: parseUsdToMinor(parsed.total, 'total'),
    lines: parsed.lines.map((line) => ({
      label: line.label,
      amountMinor: parseUsdToMinor(line.amount, `line "${line.label}" amount`),
      ...(line.quantity !== undefined && { quantity: line.quantity }),
      ...(line.rate !== undefined && { rate: line.rate }),
      ...(line.category && { category: line.category }),
    })),
  }
}

export function parseArgs(argv: string[]): { file: string; confirm: boolean; pay: boolean } {
  for (const arg of argv) {
    if (arg.startsWith('--') && !KNOWN_FLAGS.includes(arg)) {
      throw new Error(`unknown flag ${arg}. Known: ${KNOWN_FLAGS.join(', ')}`)
    }
  }
  const i = argv.indexOf('--file')
  const file = i === -1 ? undefined : argv[i + 1]
  if (!file || file.startsWith('--')) throw new Error('--file is required')
  return { file, confirm: argv.includes('--confirm'), pay: argv.includes('--pay') }
}

const usd = (amountMinor: number): string => formatMoney({ amountMinor, currency: 'USD' })

function printEntries(entries: LedgerEntryJson[]): void {
  if (entries.length === 0) {
    console.log('  (nothing to post — the accrual already covered this invoice exactly)')
    return
  }
  for (const e of entries) {
    console.log(
      `  ${e.direction.toUpperCase().padEnd(6)} ${e.account_code.padEnd(26)} ${usd(e.amount_minor)}`,
    )
  }
}

async function main(): Promise<void> {
  const { file, confirm, pay } = parseArgs(process.argv.slice(2))
  const parsed = parseInvoiceFile(JSON.parse(readFileSync(file, 'utf8')))
  const classified = classifyInvoice(parsed.lines, parsed.statedTotalMinor)

  console.log(`${parsed.provider} invoice ${parsed.invoiceNumber}`)
  console.log(`period ${parsed.periodStart} → ${parsed.periodEnd}   total ${usd(classified.totalMinor)}\n`)
  for (const line of classified.lines) {
    const flag = line.categoryOverridden ? '  ← category stated by operator' : ''
    console.log(
      `  ${line.category.padEnd(11)} ${usd(line.amountMinor).padStart(9)}  ${line.label}${flag}`,
    )
  }
  console.log(
    `\n  accruable ${usd(classified.accruableMinor)} · onboarding ${usd(classified.onboardingMinor)} · other ${usd(classified.otherMinor)}`,
  )

  const existing = await findProviderInvoice(parsed.provider, parsed.invoiceNumber)
  if (existing?.booked_at) {
    console.log(
      `\nAlready booked ${existing.booked_at}${existing.paid_at ? ` and paid ${existing.paid_at}` : ''}.`,
    )
    if (!pay || existing.paid_at) return
  }

  // The dry run shows the ACTUAL postings, not a description of them — it uses
  // the same accrued-in-period SQL the real booking will, so what prints here
  // is what lands. That needs no recorded row, which is the point: the operator
  // sees the true-up before anything is written.
  const payableAccountCode = existing?.payable_account_code ?? 'bridge_fees_payable'
  if (!confirm) {
    const accruedMinor = await accruedInPeriod(
      parsed.periodStart,
      parsed.periodEnd,
      payableAccountCode,
    )
    console.log('\nWould record this invoice, then post the true-up:')
    console.log(
      `  accrued in period: ${usd(accruedMinor)}   variance: ${usd(classified.accruableMinor - accruedMinor)}`,
    )
    printEntries(
      bookInvoiceLedgerEntries({
        onboardingMinor: classified.onboardingMinor,
        otherMinor: classified.otherMinor,
        accruableMinor: classified.accruableMinor,
        accruedMinor,
        payableAccountCode,
      }),
    )
    if (pay) {
      console.log(`\nWould then pay:`)
      printEntries(payInvoiceLedgerEntries(classified.totalMinor, payableAccountCode))
    }
    console.log('\nDRY RUN — nothing recorded. Re-run with --confirm.')
    return
  }

  const { invoice, created } = await recordProviderInvoice({
    provider: parsed.provider,
    invoiceNumber: parsed.invoiceNumber,
    periodStart: parsed.periodStart,
    periodEnd: parsed.periodEnd,
    ...(parsed.issuedAt && { issuedAt: parsed.issuedAt }),
    ...(parsed.dueAt && { dueAt: parsed.dueAt }),
    lines: parsed.lines,
    statedTotalMinor: parsed.statedTotalMinor,
    recordedBy: process.env['USER'] ?? 'operator',
  })
  console.log(created ? `\nRecorded (${invoice.id}).` : `\nAlready recorded (${invoice.id}).`)

  const booked = await bookProviderInvoice(invoice)
  if (booked.alreadyBooked) {
    console.log('Already booked — no new posting.')
  } else {
    console.log('Booked the true-up:')
    printEntries(booked.entries)
  }

  if (pay) {
    const fresh = await findProviderInvoice(parsed.provider, parsed.invoiceNumber)
    if (!fresh) throw new Error('invoice vanished between booking and payment')
    const paid = await payProviderInvoice(fresh)
    console.log(paid.alreadyPaid ? 'Already paid — no new posting.' : 'Paid:')
    printEntries(paid.entries)
  }

  for (const code of ['provider_fees', 'provider_onboarding_fees', 'bridge_fees_payable']) {
    console.log(`${code.padEnd(26)} ${formatMoney(await getAccountBalance(code))}`)
  }
}

// Only run when invoked directly, so the parsers stay unit-testable.
if (process.argv[1]?.includes('record-provider-invoice')) {
  main().catch((err: unknown) => {
    console.error(err instanceof Error ? err.message : String(err))
    process.exit(1)
  })
}
