// Integration tests for the O2 reconciliation migration against a real local
// Supabase stack (Docker). Gated like every *.db.test.ts: RUN_DB_TESTS=1 plus
// real local env — see docs/runbooks/local-dev.md.
//
// Two connections, same split as ledger.db.test.ts:
//  - supabaseAdmin RPCs — the production path the reconcile job uses
//  - a raw pg client to seed states the service layer refuses to produce
//    (a FUNDED transfer with no postings) and to prove the append-only
//    trigger on reconciliation_runs holds against raw SQL
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { Client } from 'pg'
import { supabaseAdmin } from './supabase.js'
import { postLedgerTransaction } from './ledger.js'

const runDb = process.env.RUN_DB_TESTS === '1'

const DB_URL = process.env.TEST_DB_URL ?? 'postgresql://postgres:postgres@127.0.0.1:54322/postgres'

// Fixed ids so cleanup is deterministic and reruns collide with nothing.
const RECON_USER = '00000000-0000-4000-8000-0000000000b1'
const T_CLEAN_PENDING = '00000000-0000-4000-8000-0000000000b2' // PENDING_PAYMENT, no postings — silent
const T_FUNDED_UNPOSTED = '00000000-0000-4000-8000-0000000000b3' // FUNDED, book missing — violation
const T_FUNDED_POSTED = '00000000-0000-4000-8000-0000000000b4' // FUNDED with its batch — silent
const T_PENDING_POSTED = '00000000-0000-4000-8000-0000000000b5' // PENDING_PAYMENT with postings — violation
const T_SUBMITTED_MISSING = '00000000-0000-4000-8000-0000000000b6' // SUBMITTED, FUNDED posted but no SUBMITTED batch — violation
const T_REFUNDED_VIA_CANCEL = '00000000-0000-4000-8000-0000000000b7' // REFUNDED via CANCELED (no REFUNDED batch) — silent

describe.skipIf(!runDb)('reconciliation migration (integration, local Supabase)', () => {
  let db: Client

  beforeAll(async () => {
    db = new Client({ connectionString: DB_URL })
    await db.connect()
    await db.query(
      `insert into auth.users (id, phone) values ($1, '15550000031') on conflict (id) do nothing`,
      [RECON_USER],
    )
    const recipient = await db.query(
      `insert into public.recipients (user_id, first_name, last_name, relationship, country)
       values ($1, 'Ana', 'García López', 'mother', 'MX') returning id`,
      [RECON_USER],
    )
    const destination = await db.query(
      `insert into public.payout_destinations (recipient_id, method, currency, details)
       values ($1, 'bank_account', 'MXN', '{}') returning id`,
      [recipient.rows[0].id],
    )
    // One consumed quote per transfer (quote_id is unique on transfers).
    const seedTransfer = async (id: string, state: string) => {
      const quote = await db.query(
        `insert into public.quotes (user_id, payout_destination_id, send_amount_minor, send_currency,
           receive_amount_minor, receive_currency, fee_amount_minor, fee_currency,
           fx_rate, source_rate, fx_rate_at, expires_at, status)
         values ($1, $2, 19801, 'USD', 396014, 'MXN', 199, 'USD', 19.9997, 20.100251, now(),
           now() + interval '15 minutes', 'consumed') returning id`,
        [RECON_USER, destination.rows[0].id],
      )
      await db.query(
        `insert into public.transfers (id, user_id, payout_destination_id, quote_id,
           send_amount_minor, send_currency, receive_amount_minor, receive_currency,
           fee_amount_minor, fee_currency, fx_rate, fx_rate_at, idempotency_key, state)
         values ($1, $2, $3, $4, 19801, 'USD', 396014, 'MXN', 199, 'USD', 19.9997, now(), $5, $6)`,
        [id, RECON_USER, destination.rows[0].id, quote.rows[0].id, `recon-test-${id}`, state],
      )
    }
    await seedTransfer(T_CLEAN_PENDING, 'PENDING_PAYMENT')
    await seedTransfer(T_FUNDED_UNPOSTED, 'FUNDED')
    await seedTransfer(T_FUNDED_POSTED, 'FUNDED')
    await seedTransfer(T_PENDING_POSTED, 'PENDING_PAYMENT')
    await seedTransfer(T_SUBMITTED_MISSING, 'SUBMITTED')
    await seedTransfer(T_REFUNDED_VIA_CANCEL, 'REFUNDED')

    // The healthy FUNDED book (production posting path).
    await postLedgerTransaction({
      transferId: T_FUNDED_POSTED,
      transition: 'FUNDED',
      description: 'recon test — funded batch',
      entries: [
        { accountCode: 'funding_receivable', direction: 'debit', money: { amountMinor: 20000, currency: 'USD' } },
        { accountCode: 'transfer_payable', direction: 'credit', money: { amountMinor: 19801, currency: 'USD' } },
        { accountCode: 'fee_revenue', direction: 'credit', money: { amountMinor: 199, currency: 'USD' } },
      ],
    })
    // A posting against a transfer still in PENDING_PAYMENT (state/book split).
    await postLedgerTransaction({
      transferId: T_PENDING_POSTED,
      transition: 'FUNDED',
      description: 'recon test — posting the state machine never reached',
      entries: [
        { accountCode: 'funding_receivable', direction: 'debit', money: { amountMinor: 20000, currency: 'USD' } },
        { accountCode: 'transfer_payable', direction: 'credit', money: { amountMinor: 20000, currency: 'USD' } },
      ],
    })
    // SUBMITTED state whose SUBMITTED batch never posted (FUNDED did).
    await postLedgerTransaction({
      transferId: T_SUBMITTED_MISSING,
      transition: 'FUNDED',
      description: 'recon test — funded batch only',
      entries: [
        { accountCode: 'funding_receivable', direction: 'debit', money: { amountMinor: 20000, currency: 'USD' } },
        { accountCode: 'transfer_payable', direction: 'credit', money: { amountMinor: 20000, currency: 'USD' } },
      ],
    })
    // The CANCELED→REFUNDED door: FUNDED + CANCELED postings and NO REFUNDED
    // batch is the correct, silent shape (the reversal already zeroed the book).
    await postLedgerTransaction({
      transferId: T_REFUNDED_VIA_CANCEL,
      transition: 'FUNDED',
      description: 'recon test — funded batch',
      entries: [
        { accountCode: 'funding_receivable', direction: 'debit', money: { amountMinor: 20000, currency: 'USD' } },
        { accountCode: 'transfer_payable', direction: 'credit', money: { amountMinor: 20000, currency: 'USD' } },
      ],
    })
    await postLedgerTransaction({
      transferId: T_REFUNDED_VIA_CANCEL,
      transition: 'CANCELED',
      description: 'recon test — canceled reversal',
      entries: [
        { accountCode: 'transfer_payable', direction: 'debit', money: { amountMinor: 20000, currency: 'USD' } },
        { accountCode: 'funding_receivable', direction: 'credit', money: { amountMinor: 20000, currency: 'USD' } },
      ],
    })
  })

  afterAll(async () => {
    // TRUNCATE skips row-level triggers — the sanctioned cleanup for the
    // append-only tables, reconciliation_runs included.
    await db.query(
      'truncate table public.ledger_entries, public.ledger_transactions, public.reconciliation_runs',
    )
    await db.query('delete from public.transfers where user_id = $1', [RECON_USER])
    await db.query('delete from public.quotes where user_id = $1', [RECON_USER])
    await db.query(
      `delete from public.payout_destinations where recipient_id in
         (select id from public.recipients where user_id = $1)`,
      [RECON_USER],
    )
    await db.query('delete from public.recipients where user_id = $1', [RECON_USER])
    await db.query('delete from auth.users where id = $1', [RECON_USER])
    await db.end()
  })

  describe('ledger self-check functions', () => {
    it('net-zero and min-entries return no rows on a book written through the service', async () => {
      const netZero = await supabaseAdmin.rpc('reconcile_ledger_net_zero')
      expect(netZero.error).toBeNull()
      expect(netZero.data).toEqual([])

      const minEntries = await supabaseAdmin.rpc('reconcile_ledger_min_entries')
      expect(minEntries.error).toBeNull()
      expect(minEntries.data).toEqual([])
      // The violating arms are unit-tested with mocked RPCs: the deferred
      // constraint triggers make an unbalanced or entry-less transaction
      // UNSEEDABLE here — which is itself the invariant these functions audit.
    })

    it('reconcile_account_balances snapshots the whole chart in one pass', async () => {
      const { data, error } = await supabaseAdmin.rpc('reconcile_account_balances')
      expect(error).toBeNull()
      const rows = data as Array<{ code: string; amount_minor: number; currency: string }>
      expect(rows).toHaveLength(11)
      const byCode = Object.fromEntries(rows.map((r) => [r.code, Number(r.amount_minor)]))
      // Four seeded FUNDED batches (20000 each) minus the CANCELED reversal.
      expect(byCode['funding_receivable']).toBe(60000)
      expect(byCode['transfer_payable']).toBe(19801 + 20000 + 20000)
      expect(byCode['fee_revenue']).toBe(199)
      expect(byCode['due_from_bridge']).toBe(0)
    })
  })

  describe('reconcile_state_postings', () => {
    it('flags the state/book splits and stays silent on healthy rows', async () => {
      const { data, error } = await supabaseAdmin.rpc('reconcile_state_postings')
      expect(error).toBeNull()
      const rows = data as Array<{ transfer_id: string; state: string; problem: string }>
      const ours = rows.filter((r) =>
        [
          T_CLEAN_PENDING,
          T_FUNDED_UNPOSTED,
          T_FUNDED_POSTED,
          T_PENDING_POSTED,
          T_SUBMITTED_MISSING,
          T_REFUNDED_VIA_CANCEL,
        ].includes(r.transfer_id),
      )
      expect(ours).toEqual(
        expect.arrayContaining([
          { transfer_id: T_FUNDED_UNPOSTED, state: 'FUNDED', problem: 'missing_FUNDED_posting' },
          {
            transfer_id: T_PENDING_POSTED,
            state: 'PENDING_PAYMENT',
            problem: 'unexpected_postings_before_funding',
          },
          {
            transfer_id: T_SUBMITTED_MISSING,
            state: 'SUBMITTED',
            problem: 'missing_SUBMITTED_posting',
          },
        ]),
      )
      // …and exactly these: the healthy FUNDED row, the clean PENDING row, and
      // the REFUNDED-via-CANCELED row must all stay silent.
      expect(ours).toHaveLength(3)
    })
  })

  describe('reconciliation_runs', () => {
    it('accepts a run row through the production insert path', async () => {
      const { error } = await supabaseAdmin.from('reconciliation_runs').insert({
        started_at: new Date().toISOString(),
        finished_at: new Date().toISOString(),
        status: 'pass',
        findings_count: 0,
        checks: [{ name: 'ledger_net_zero', status: 'pass', findings_count: 0 }],
        balances: { funding_receivable: { amount_minor: 0, currency: 'USD' } },
      })
      expect(error).toBeNull()
    })

    it('rejects an unknown status', async () => {
      const { error } = await supabaseAdmin.from('reconciliation_runs').insert({
        started_at: new Date().toISOString(),
        finished_at: new Date().toISOString(),
        status: 'partial',
        findings_count: 0,
        checks: [],
      })
      expect(error?.message).toMatch(/reconciliation_runs_status_check/)
    })

    it('is append-only even against raw SQL', async () => {
      const inserted = await db.query(
        `insert into public.reconciliation_runs (started_at, finished_at, status, findings_count, checks)
         values (now(), now(), 'pass', 0, '[]'::jsonb) returning id`,
      )
      const id = inserted.rows[0].id
      await expect(
        db.query(`update public.reconciliation_runs set status = 'error' where id = $1`, [id]),
      ).rejects.toThrow(/append-only/)
      await expect(
        db.query(`delete from public.reconciliation_runs where id = $1`, [id]),
      ).rejects.toThrow(/append-only/)
    })
  })
})
