// Integration tests against a real local Supabase stack (Docker).
// Gated: RUN_DB_TESTS=1.
//
// Proves the 2026-09-11 provider-fee slice end to end at the DATABASE level:
// the SUBMITTED batch's accrual pair posts, a real Bridge invoice records and
// trues up, the payment discharges the liability, and — the part no unit test
// can reach — the two reconciliation SQL functions actually window, exclude,
// and classify the way the check believes they do.
//
// The accrual batches are posted through post_ledger_transaction directly with
// entries built by the REAL submittedLedgerEntries. That is the same DB
// function transition_transfer hands its p_ledger_entries to, so the net-zero
// triggers and account-code resolution are exercised identically, without
// re-seeding a whole transfer walk (payout-ledger.db.test.ts owns that).
import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from 'vitest'
import { Client } from 'pg'

const runDb = process.env.RUN_DB_TESTS === '1'
const DB_URL = process.env.TEST_DB_URL ?? 'postgresql://postgres:postgres@127.0.0.1:54322/postgres'

// The contract rates, pinned for the test rather than read from the ambient
// environment: the arithmetic below is only meaningful against known knobs.
vi.stubEnv('BRIDGE_SPEI_FEE_MINOR', '100')
vi.stubEnv('BRIDGE_ORCHESTRATION_BPS', '25')

const { submittedLedgerEntries } = await import('./payouts.js')
const { postLedgerTransaction, getAccountBalance } = await import('./ledger.js')
const {
  recordProviderInvoice,
  bookProviderInvoice,
  payProviderInvoice,
  findProviderInvoice,
  readAccrualReconciliation,
  readUnbilledAccruals,
  accruedInPeriod,
} = await import('./provider-fees.js')

// The real invoice, as printed. Lines sum to $10.31; it bills $10.30.
const INV_LINES = [
  { label: 'SPEI Fee', quantity: '2', rate: '1.00', amountMinor: 200 },
  { label: 'Wallet Fee (active/created)', quantity: '2', rate: '0.25', amountMinor: 50 },
  { label: 'Orchestration Volume Fee', quantity: '118.05', rate: '0.25%', amountMinor: 30 },
  { label: 'Next Day ACH Fee', quantity: '3', rate: '0.50', amountMinor: 150 },
  { label: 'Gas', quantity: '0.006472', rate: '1.00', amountMinor: 1 },
  {
    label: 'Individual Compliance Fee (created accounts)',
    quantity: '3',
    rate: '2.00',
    amountMinor: 600,
  },
]
const INV_TOTAL = 1030

describe.skipIf(!runDb)('provider fee accrual + invoice (integration, local Supabase)', () => {
  let db: Client
  // UTC today — accruals post at now(), and the SQL matches them to an invoice
  // period by their UTC date, so a single-day period is the exact window.
  const today = new Date().toISOString().slice(0, 10)

  /** One payout's worth of SUBMITTED postings, accrual included. */
  const postSubmitted = async (key: string, principalMinor: number, drawMinor: number) => {
    const entries = submittedLedgerEntries({
      sendAmountMinor: principalMinor,
      actualSourceAmountMinor: drawMinor,
    })
    await postLedgerTransaction({
      idempotencyKey: key,
      description: `test payout ${key}`,
      entries: entries.map((e) => ({
        accountCode: e.account_code,
        direction: e.direction,
        money: { amountMinor: e.amount_minor, currency: e.currency },
      })),
    })
    return entries
  }

  const recordAndBook = async (invoiceNumber: string, periodStart: string, periodEnd: string) => {
    const { invoice } = await recordProviderInvoice({
      provider: 'bridge',
      invoiceNumber,
      periodStart,
      periodEnd,
      issuedAt: today,
      dueAt: today,
      lines: INV_LINES,
      statedTotalMinor: INV_TOTAL,
      recordedBy: 'db-test',
    })
    const booked = await bookProviderInvoice(invoice)
    return { invoice, booked }
  }

  beforeAll(async () => {
    db = new Client({ connectionString: DB_URL })
    await db.connect()
    // Local-CLI quirk (docs/runbooks/local-dev.md): migrations apply without
    // the grants the hosted platform adds, and PostgREST caches its schema.
    await db.query(
      `grant select, insert, update, delete on public.provider_invoices to service_role, authenticated, anon`,
    )
    await db.query(`notify pgrst, 'reload schema'`)
    await new Promise((r) => setTimeout(r, 500))
  })

  beforeEach(async () => {
    await db.query('delete from public.provider_invoices')
    await db.query('truncate table public.ledger_entries, public.ledger_transactions cascade')
  })

  afterAll(async () => {
    // Leave nothing behind: the float ceiling and the balance checks read
    // GLOBAL account balances, so a leaked accrual is another suite's flake.
    await db.query('delete from public.provider_invoices')
    await db.query('truncate table public.ledger_entries, public.ledger_transactions cascade')
    await db.end()
  })

  const balances = async (): Promise<Record<string, number>> => {
    const res = await db.query(
      `select a.code,
              coalesce(sum(case when e.direction = a.normal_balance
                                then e.amount_minor else -e.amount_minor end), 0)::bigint as amount
         from public.ledger_accounts a
         left join public.ledger_entries e on e.account_id = a.id
        group by a.code`,
    )
    return Object.fromEntries(res.rows.map((r) => [r.code, Number(r.amount)]))
  }

  it('the SUBMITTED batch posts the accrual pair and still nets to zero', async () => {
    // $400.00 principal, $400.06 drawn: 6 slippage, 100 SPEI + 100 bps accrual.
    const entries = await postSubmitted('test:submitted:1', 40_000, 40_006)
    expect(entries.map((e) => e.account_code)).toContain('bridge_fees_payable')

    const after = await balances()
    expect(after['provider_fees']).toBe(200)
    expect(after['bridge_fees_payable']).toBe(200)
    expect(after['fx_slippage']).toBe(6)

    const net = await db.query(
      `select sum(case when direction = 'debit' then amount_minor else -amount_minor end)::bigint as net
         from public.ledger_entries`,
    )
    expect(Number(net.rows[0].net)).toBe(0)
  })

  it('a replayed submission cannot double-accrue', async () => {
    await postSubmitted('test:submitted:replay', 40_000, 40_000)
    await postSubmitted('test:submitted:replay', 40_000, 40_000)
    expect((await balances())['bridge_fees_payable']).toBe(200)
  })

  it('books the true-up, splitting acquisition cost out of transfer cost', async () => {
    // Two payouts at $40.00 principal: 2 × ($1.00 + $0.10) = $2.20 accrued,
    // against $2.30 of invoiced accruable lines.
    await postSubmitted('test:submitted:a', 4_000, 4_000)
    await postSubmitted('test:submitted:b', 4_000, 4_000)
    expect((await balances())['bridge_fees_payable']).toBe(220)

    const { invoice, booked } = await recordAndBook('INV19341', today, today)
    expect(invoice.accruable_minor).toBe(230)
    expect(invoice.onboarding_minor).toBe(650)
    expect(invoice.other_minor).toBe(150) // ACH 150 + gas 1 + Bridge's −1 rounding
    expect(invoice.total_minor).toBe(INV_TOTAL)
    expect(booked.posted).toBe(true)

    const after = await balances()
    // provider_fees = accrued 220 + unaccrued other 150 + variance 10
    expect(after['provider_fees']).toBe(380)
    // the $6.50 of per-customer cost is NOT in transfer cost
    expect(after['provider_onboarding_fees']).toBe(650)
    // the whole invoice is now owed
    expect(after['bridge_fees_payable']).toBe(INV_TOTAL)
    expect((after['provider_fees'] ?? 0) + (after['provider_onboarding_fees'] ?? 0)).toBe(INV_TOTAL)
  })

  it('paying it discharges the liability out of cash', async () => {
    await postSubmitted('test:submitted:c', 4_000, 4_000)
    await recordAndBook('INV19341', today, today)

    const before = await balances()
    const invoice = await findProviderInvoice('bridge', 'INV19341')
    const paid = await payProviderInvoice(invoice!)
    expect(paid.posted).toBe(true)

    const after = await balances()
    expect(after['bridge_fees_payable']).toBe(0)
    expect(after['cash_clearing']).toBe((before['cash_clearing'] ?? 0) - INV_TOTAL)

    // Idempotent: the stamped row short-circuits, and so would the ledger key.
    const again = await payProviderInvoice((await findProviderInvoice('bridge', 'INV19341'))!)
    expect(again.alreadyPaid).toBe(true)
    expect((await balances())['bridge_fees_payable']).toBe(0)
  })

  it('refuses to pay an invoice the book never recognized', async () => {
    const { invoice } = await recordProviderInvoice({
      provider: 'bridge',
      invoiceNumber: 'INV-UNBOOKED',
      periodStart: today,
      periodEnd: today,
      lines: INV_LINES,
      statedTotalMinor: INV_TOTAL,
      recordedBy: 'db-test',
    })
    await expect(payProviderInvoice(invoice)).rejects.toThrow(/has not been booked/)
  })

  it('reconcile_provider_fee_accrual measures the variance the check pages on', async () => {
    await postSubmitted('test:submitted:d', 4_000, 4_000) // accrues 110
    await recordAndBook('INV19341', today, today)

    const rows = await readAccrualReconciliation()
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({
      invoice_number: 'INV19341',
      accrued_minor: 110,
      accruable_minor: 230,
      variance_minor: 120, // we under-accrued by one payout's worth
      booked: true,
      paid: false,
    })
  })

  it('the booking postings do not inflate the number they are measured against', async () => {
    // The trap this SQL exists to avoid: the true-up itself CREDITS the
    // payable, so a naive sum would count the correction as more accrual and
    // report zero variance forever.
    await postSubmitted('test:submitted:e', 4_000, 4_000)
    await recordAndBook('INV19341', today, today)
    await payProviderInvoice((await findProviderInvoice('bridge', 'INV19341'))!)

    const rows = await readAccrualReconciliation()
    expect(rows[0]?.accrued_minor).toBe(110)
    expect(rows[0]?.variance_minor).toBe(120)
    expect(rows[0]?.paid).toBe(true)
  })

  it('accruedInPeriod answers for a period with no recorded invoice — the dry-run path', async () => {
    // The recorder previews the true-up BEFORE writing anything, so the window
    // query cannot depend on the invoice row existing.
    await postSubmitted('test:submitted:dry1', 4_000, 4_000)
    await postSubmitted('test:submitted:dry2', 4_000, 4_000)
    expect(await accruedInPeriod(today, today)).toBe(220)
    expect(await accruedInPeriod('2026-01-01', '2026-01-31')).toBe(0)

    // And it agrees with the reconciliation view once the invoice exists —
    // one SQL function, so the CLI and the cron cannot drift apart.
    await recordAndBook('INV19341', today, today)
    const rows = await readAccrualReconciliation()
    expect(rows[0]?.accrued_minor).toBe(await accruedInPeriod(today, today))
  })

  it('accruals outside every invoice period surface as unbilled', async () => {
    await postSubmitted('test:submitted:f', 4_000, 4_000)

    const before = await readUnbilledAccruals()
    expect(before).toMatchObject({ earliest_day: today, latest_day: today, accrued_minor: 110 })

    // An invoice for a DIFFERENT period must not cover today's accruals.
    await recordAndBook('INV-OTHER', '2026-01-01', '2026-01-31')
    expect(await readUnbilledAccruals()).toMatchObject({ accrued_minor: 110 })

    // One that covers today does.
    await recordAndBook('INV19341', today, today)
    expect(await readUnbilledAccruals()).toBeNull()
  })

  it('a booked invoice is immutable — corrections are new records, not edits', async () => {
    await postSubmitted('test:submitted:g', 4_000, 4_000)
    const { invoice } = await recordAndBook('INV19341', today, today)
    await expect(
      db.query('update public.provider_invoices set total_minor = 9999 where id = $1', [invoice.id]),
    ).rejects.toThrow(/already booked/)
  })

  it('the classified buckets must reconstruct the total — enforced in the DB', async () => {
    await expect(
      db.query(
        `insert into public.provider_invoices
           (provider, invoice_number, period_start, period_end, total_minor,
            accruable_minor, onboarding_minor, other_minor, lines, recorded_by)
         values ('bridge', 'INV-BAD', $1, $1, 1030, 230, 650, 0, '[]'::jsonb, 'db-test')`,
        [today],
      ),
    ).rejects.toThrow(/provider_invoices_classification_totals/)
  })

  it('records one invoice number once, however many times the CLI is re-run', async () => {
    const first = await recordProviderInvoice({
      provider: 'bridge',
      invoiceNumber: 'INV19341',
      periodStart: today,
      periodEnd: today,
      lines: INV_LINES,
      statedTotalMinor: INV_TOTAL,
      recordedBy: 'db-test',
    })
    const second = await recordProviderInvoice({
      provider: 'bridge',
      invoiceNumber: 'INV19341',
      periodStart: today,
      periodEnd: today,
      lines: INV_LINES,
      statedTotalMinor: INV_TOTAL,
      recordedBy: 'db-test',
    })
    expect(first.created).toBe(true)
    expect(second.created).toBe(false)
    expect(second.invoice.id).toBe(first.invoice.id)
  })

  it('getAccountBalance sees the two new accounts', async () => {
    await postSubmitted('test:submitted:h', 4_000, 4_000)
    expect(await getAccountBalance('bridge_fees_payable')).toEqual({
      amountMinor: 110,
      currency: 'USD',
    })
    expect(await getAccountBalance('provider_onboarding_fees')).toEqual({
      amountMinor: 0,
      currency: 'USD',
    })
  })
})
