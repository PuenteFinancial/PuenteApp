// Integration tests against a real local Supabase stack (Docker).
// Gated: they run only with RUN_DB_TESTS=1 plus real local env
// (SUPABASE_URL + legacy service-role key — see docs/runbooks/local-dev.md,
// including the post-reset grants step). Plain `pnpm test` skips them.
//
// Two connections on purpose:
//  - the ledger service via supabaseAdmin (the real production path, PostgREST rpc)
//  - a raw pg client, to BYPASS the service and prove the database itself
//    enforces the invariants (net-zero, min entries, append-only)
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import { Client } from 'pg'
import { moneyFromMinorUnits } from '@puente/shared'
import { postLedgerTransaction, getAccountBalance, type LedgerEntryInput } from './ledger.js'
import { submittedLedgerEntries } from './payouts.js'
import { supabaseAdmin } from './supabase.js'

const runDb = process.env.RUN_DB_TESTS === '1'

const DB_URL = process.env.TEST_DB_URL ?? 'postgresql://postgres:postgres@127.0.0.1:54322/postgres'

const usd = (amountMinor: number) => moneyFromMinorUnits(amountMinor, 'USD')
const entry = (
  accountCode: string,
  direction: 'debit' | 'credit',
  amountMinor: number,
): LedgerEntryInput => ({ accountCode, direction, money: usd(amountMinor) })

const T1 = '00000000-0000-4000-8000-000000000001'

const CHART = {
  cash_clearing: 'debit',
  bridge_wallet_float: 'debit',
  funding_receivable: 'debit',
  due_from_bridge: 'debit',
  transfer_payable: 'credit',
  refunds_payable: 'credit',
  fee_revenue: 'credit',
  provider_fees: 'debit',
  fx_slippage: 'debit',
  loss_funding_reversed: 'debit',
} as const

describe.skipIf(!runDb)('ledger core (integration, local Supabase)', () => {
  let db: Client

  // Since slice 4, ledger_transactions.transfer_id is a real FK — postings
  // against T1 need an actual transfers row (and its quote/destination chain).
  const LEDGER_USER = '00000000-0000-4000-8000-00000000002a'

  beforeAll(async () => {
    db = new Client({ connectionString: DB_URL })
    await db.connect()
    await db.query(
      `insert into auth.users (id, phone) values ($1, '15550000021') on conflict (id) do nothing`,
      [LEDGER_USER],
    )
    const recipient = await db.query(
      `insert into public.recipients (user_id, first_name, last_name, relationship, country)
       values ($1, 'Ana', 'García López', 'mother', 'MX') returning id`,
      [LEDGER_USER],
    )
    const destination = await db.query(
      `insert into public.payout_destinations (recipient_id, method, currency, details)
       values ($1, 'bank_account', 'MXN', '{}') returning id`,
      [recipient.rows[0].id],
    )
    const quote = await db.query(
      `insert into public.quotes (user_id, payout_destination_id, send_amount_minor, send_currency,
         receive_amount_minor, receive_currency, fee_amount_minor, fee_currency,
         fx_rate, source_rate, fx_rate_at, expires_at, status)
       values ($1, $2, 19801, 'USD', 396014, 'MXN', 199, 'USD', 19.9997, 20.100251, now(),
         now() + interval '15 minutes', 'consumed') returning id`,
      [LEDGER_USER, destination.rows[0].id],
    )
    await db.query(
      `insert into public.transfers (id, user_id, payout_destination_id, quote_id,
         send_amount_minor, send_currency, receive_amount_minor, receive_currency,
         fee_amount_minor, fee_currency, fx_rate, fx_rate_at, idempotency_key)
       values ($1, $2, $3, $4, 19801, 'USD', 396014, 'MXN', 199, 'USD', 19.9997, now(), $5)
       on conflict (id) do nothing`,
      [T1, LEDGER_USER, destination.rows[0].id, quote.rows[0].id, `ledger-test-${T1}`],
    )
  })

  afterAll(async () => {
    await db.query('truncate table public.ledger_entries, public.ledger_transactions')
    await db.query('delete from public.transfers where id = $1', [T1])
    await db.query('delete from auth.users where id = $1', [LEDGER_USER])
    await db.end()
  })

  beforeEach(async () => {
    // TRUNCATE skips row-level triggers — the sanctioned test-cleanup path.
    await db.query('truncate table public.ledger_entries, public.ledger_transactions')
  })

  const accountId = async (code: string): Promise<string> => {
    const res = await db.query('select id from public.ledger_accounts where code = $1', [code])
    return res.rows[0].id
  }

  describe('seeded chart of accounts', () => {
    it('has exactly the 10 accounts from ledger-rules.md with correct normal balances', async () => {
      const res = await db.query(
        'select code, normal_balance, type, currency from public.ledger_accounts order by code',
      )
      expect(res.rows).toHaveLength(10)
      const byCode = Object.fromEntries(res.rows.map((r) => [r.code, r.normal_balance]))
      expect(byCode).toEqual(CHART)
      for (const row of res.rows) expect(row.currency.trim()).toBe('USD')
    })
  })

  describe('posting via the service (production path)', () => {
    it('posts the FUNDED batch and persists transaction + entries', async () => {
      const record = await postLedgerTransaction({
        transferId: T1,
        transition: 'FUNDED',
        description: 'transfer funded',
        entries: [
          entry('funding_receivable', 'debit', 10000),
          entry('transfer_payable', 'credit', 9800),
          entry('fee_revenue', 'credit', 200),
        ],
      })
      expect(record.id).toMatch(/^[0-9a-f-]{36}$/)
      expect(record.idempotencyKey).toBe(`${T1}:FUNDED`)

      const tx = await db.query('select * from public.ledger_transactions')
      expect(tx.rows).toHaveLength(1)
      expect(tx.rows[0].transfer_id).toBe(T1)
      expect(tx.rows[0].transition).toBe('FUNDED')

      const entries = await db.query(
        `select a.code, e.direction, e.amount_minor
           from public.ledger_entries e join public.ledger_accounts a on a.id = e.account_id
          order by e.amount_minor desc`,
      )
      expect(
        entries.rows.map((r) => [r.code, r.direction, Number(r.amount_minor)]),
      ).toEqual([
        ['funding_receivable', 'debit', 10000],
        ['transfer_payable', 'credit', 9800],
        ['fee_revenue', 'credit', 200],
      ])
    })

    it('rejects an unknown account code (function-level)', async () => {
      await expect(
        postLedgerTransaction({
          transferId: T1,
          transition: 'FUNDED',
          description: 'bad account',
          entries: [entry('not_an_account', 'debit', 100), entry('fee_revenue', 'credit', 100)],
        }),
      ).rejects.toThrow(/unknown ledger account code/)
      const tx = await db.query('select count(*)::int as n from public.ledger_transactions')
      expect(tx.rows[0].n).toBe(0) // failed post never burns the idempotency key
    })

    it('rejects an entry whose currency does not match the account currency', async () => {
      await expect(
        postLedgerTransaction({
          transferId: T1,
          transition: 'FUNDED',
          description: 'currency mismatch',
          entries: [
            { accountCode: 'funding_receivable', direction: 'debit', money: moneyFromMinorUnits(100, 'MXN') },
            { accountCode: 'transfer_payable', direction: 'credit', money: moneyFromMinorUnits(100, 'MXN') },
          ],
        }),
      ).rejects.toThrow(/does not match account/)
    })
  })

  describe('database-level enforcement with the service bypassed (raw SQL)', () => {
    it('rejects a transaction row with no entries at commit', async () => {
      await expect(
        db.query(
          `insert into public.ledger_transactions (idempotency_key, description)
           values ('bypass:no-entries', 'headless transaction')`,
        ),
      ).rejects.toThrow(/at least 2 entries/)
    })

    it('rejects an unbalanced batch at COMMIT of an explicit transaction', async () => {
      await db.query('begin')
      await db.query(
        `insert into public.ledger_transactions (id, idempotency_key, description)
         values ('00000000-0000-4000-8000-0000000000aa', 'bypass:unbalanced', 'unbalanced')`,
      )
      await db.query(
        `insert into public.ledger_entries (ledger_transaction_id, account_id, direction, amount_minor, currency)
         values ('00000000-0000-4000-8000-0000000000aa', $1, 'debit', 5000, 'USD'),
                ('00000000-0000-4000-8000-0000000000aa', $2, 'credit', 4999, 'USD')`,
        [await accountId('cash_clearing'), await accountId('fee_revenue')],
      )
      await expect(db.query('commit')).rejects.toThrow(/does not net to zero/)
      const tx = await db.query('select count(*)::int as n from public.ledger_transactions')
      expect(tx.rows[0].n).toBe(0)
    })

    it('accepts the balanced equivalent', async () => {
      await db.query('begin')
      await db.query(
        `insert into public.ledger_transactions (id, idempotency_key, description)
         values ('00000000-0000-4000-8000-0000000000bb', 'bypass:balanced', 'balanced')`,
      )
      await db.query(
        `insert into public.ledger_entries (ledger_transaction_id, account_id, direction, amount_minor, currency)
         values ('00000000-0000-4000-8000-0000000000bb', $1, 'debit', 5000, 'USD'),
                ('00000000-0000-4000-8000-0000000000bb', $2, 'credit', 5000, 'USD')`,
        [await accountId('cash_clearing'), await accountId('fee_revenue')],
      )
      await db.query('commit')
      const tx = await db.query('select count(*)::int as n from public.ledger_transactions')
      expect(tx.rows[0].n).toBe(1)
    })
  })

  describe('idempotent replay', () => {
    const post = () =>
      postLedgerTransaction({
        transferId: T1,
        transition: 'FUNDED',
        description: 'transfer funded',
        entries: [
          entry('funding_receivable', 'debit', 10000),
          entry('transfer_payable', 'credit', 9800),
          entry('fee_revenue', 'credit', 200),
        ],
      })

    it('same key posts exactly once and returns the original transaction', async () => {
      const first = await post()
      const replay = await post()
      expect(replay).toEqual(first)

      // Even a direct rpc with DIFFERENT entries must not post again.
      const { data, error } = await supabaseAdmin.rpc('post_ledger_transaction', {
        p_idempotency_key: `${T1}:FUNDED`,
        p_description: 'different payload',
        p_transfer_id: T1,
        p_transition: 'FUNDED',
        p_entries: [
          { account_code: 'cash_clearing', direction: 'debit', amount_minor: 1, currency: 'USD' },
          { account_code: 'fee_revenue', direction: 'credit', amount_minor: 1, currency: 'USD' },
        ],
      })
      expect(error).toBeNull()
      expect((Array.isArray(data) ? data[0] : data).id).toBe(first.id)

      const tx = await db.query('select count(*)::int as n from public.ledger_transactions')
      const en = await db.query('select count(*)::int as n from public.ledger_entries')
      expect(tx.rows[0].n).toBe(1)
      expect(en.rows[0].n).toBe(3)
    })

    it('enforces UNIQUE(transfer_id, transition) independently of the key convention', async () => {
      await post()
      const { error } = await supabaseAdmin.rpc('post_ledger_transaction', {
        p_idempotency_key: 'some-other-key',
        p_description: 'same transition, different key',
        p_transfer_id: T1,
        p_transition: 'FUNDED',
        p_entries: [
          { account_code: 'cash_clearing', direction: 'debit', amount_minor: 1, currency: 'USD' },
          { account_code: 'fee_revenue', direction: 'credit', amount_minor: 1, currency: 'USD' },
        ],
      })
      expect(error?.message).toMatch(/duplicate key|unique/i)
    })
  })

  describe('append-only', () => {
    it.each([
      ['update', 'update public.ledger_transactions set description = $$tampered$$'],
      ['delete', 'delete from public.ledger_transactions'],
    ])('%s on ledger_transactions raises even as superuser', async (_op, sql) => {
      await postLedgerTransaction({
        transferId: T1,
        transition: 'FUNDED',
        description: 'transfer funded',
        entries: [entry('cash_clearing', 'debit', 100), entry('fee_revenue', 'credit', 100)],
      })
      await expect(db.query(sql)).rejects.toThrow(/append-only/)
    })

    it.each([
      ['update', 'update public.ledger_entries set amount_minor = 1'],
      ['delete', 'delete from public.ledger_entries'],
    ])('%s on ledger_entries raises even as superuser', async (_op, sql) => {
      await postLedgerTransaction({
        transferId: T1,
        transition: 'FUNDED',
        description: 'transfer funded',
        entries: [entry('cash_clearing', 'debit', 100), entry('fee_revenue', 'credit', 100)],
      })
      await expect(db.query(sql)).rejects.toThrow(/append-only/)
    })
  })

  describe('the worked example from ledger-rules.md ($100 send, all cents)', () => {
    const runWorkedExample = async () => {
      await postLedgerTransaction({
        transferId: T1,
        transition: 'FUNDED',
        description: 'ACH initiated: recognize obligation + fee',
        entries: [
          entry('funding_receivable', 'debit', 10000),
          entry('transfer_payable', 'credit', 9800),
          entry('fee_revenue', 'credit', 200),
        ],
      })
      // SUBMITTED batch comes straight from the shipped production helper
      // (payouts.ts) so this worked example can never drift from the real
      // fx_slippage form again (same guard as payout-ledger.db.test.ts).
      // S = 9800 quoted send, A = 9808 actual USDC draw ⇒ D = 8 books to
      // fx_slippage — matches ledger-rules.md. No provider_fees line: Bridge
      // charges no explicit per-transfer fee.
      await postLedgerTransaction({
        transferId: T1,
        transition: 'SUBMITTED',
        description: 'payout drawn from treasury wallet',
        entries: submittedLedgerEntries({ sendAmountMinor: 9800, actualSourceAmountMinor: 9808 }).map(
          (e) => ({ accountCode: e.account_code, direction: e.direction, money: usd(e.amount_minor) }),
        ),
      })
      await postLedgerTransaction({
        idempotencyKey: 'replenishment:test:1',
        description: 'treasury wallet top-up',
        entries: [
          entry('bridge_wallet_float', 'debit', 50000),
          entry('cash_clearing', 'credit', 50000),
        ],
      })
      await postLedgerTransaction({
        transferId: T1,
        transition: 'COMPLETED',
        description: 'Bridge confirmed delivery',
        entries: [entry('transfer_payable', 'debit', 9800), entry('due_from_bridge', 'credit', 9800)],
      })
      await postLedgerTransaction({
        transferId: T1,
        transition: 'FUNDING_CLEARED',
        description: 'sender ACH settled',
        entries: [entry('cash_clearing', 'debit', 10000), entry('funding_receivable', 'credit', 10000)],
      })
    }

    it('ends with the exact balances and the conservation invariant', async () => {
      await runWorkedExample()

      expect(await getAccountBalance('funding_receivable')).toEqual(usd(0))
      expect(await getAccountBalance('transfer_payable')).toEqual(usd(0))
      expect(await getAccountBalance('due_from_bridge')).toEqual(usd(0))
      expect(await getAccountBalance('fee_revenue')).toEqual(usd(200))
      expect(await getAccountBalance('fx_slippage')).toEqual(usd(8))

      // Cash is split across two locations since bridge_wallet_float adoption:
      const cash = await getAccountBalance('cash_clearing')
      const walletFloat = await getAccountBalance('bridge_wallet_float')
      expect(cash).toEqual(usd(-40000))
      expect(walletFloat).toEqual(usd(40192))
      // Conservation: cash gained = fee_revenue − fx_slippage
      expect(cash.amountMinor + walletFloat.amountMinor).toBe(200 - 8)
    })

    it('every posted batch nets to zero (ledger-skill invariant)', async () => {
      await runWorkedExample()
      const res = await db.query(
        `select ledger_transaction_id,
                sum(case when direction = 'debit' then amount_minor else -amount_minor end)::bigint as net
           from public.ledger_entries group by ledger_transaction_id`,
      )
      expect(res.rows).toHaveLength(5)
      for (const row of res.rows) expect(Number(row.net)).toBe(0)
    })
  })

  describe('balance signs', () => {
    it('reads positive for net debits on a debit-normal account and mirrors for credit-normal', async () => {
      await postLedgerTransaction({
        idempotencyKey: 'signs:1',
        description: 'sign check',
        entries: [entry('cash_clearing', 'debit', 500), entry('fee_revenue', 'credit', 500)],
      })
      expect(await getAccountBalance('cash_clearing')).toEqual(usd(500)) // debit-normal, net debit
      expect(await getAccountBalance('fee_revenue')).toEqual(usd(500)) // credit-normal, net credit
    })

    it('goes negative when an account moves against its normal balance', async () => {
      await postLedgerTransaction({
        idempotencyKey: 'signs:2',
        description: 'against normal balance',
        entries: [entry('fee_revenue', 'debit', 300), entry('cash_clearing', 'credit', 300)],
      })
      expect(await getAccountBalance('cash_clearing')).toEqual(usd(-300))
      expect(await getAccountBalance('fee_revenue')).toEqual(usd(-300))
    })

    it('returns zero for an account with no entries and errors on an unknown code', async () => {
      expect(await getAccountBalance('loss_funding_reversed')).toEqual(usd(0))
      await expect(getAccountBalance('nope')).rejects.toThrow(/unknown ledger account code/)
    })
  })
})
