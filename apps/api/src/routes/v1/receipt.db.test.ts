// Integration tests against a real local Supabase stack (Docker).
// Gated: RUN_DB_TESTS=1. Proves the slice-6 PR-3 receipt at the DATABASE level:
// the new UNIQUE (transfer_id, type) makes the receipt upsert idempotent
// (ON CONFLICT DO NOTHING → one receipt, and — crucially — the no-op insert
// never trips the disclosures append-only trigger), a receipt coexists with the
// prepayment (the constraint is per type), the receipt stays append-only, and
// RLS scopes the read to the transfer's owner.
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import { Client } from 'pg'

const runDb = process.env.RUN_DB_TESTS === '1'

const DB_URL = process.env.TEST_DB_URL ?? 'postgresql://postgres:postgres@127.0.0.1:54322/postgres'

const USER_A = '00000000-0000-4000-8000-00000000009a'
const USER_B = '00000000-0000-4000-8000-00000000009b'

const RECEIPT_CONTENT = JSON.stringify({
  version: 1,
  amounts: { totalMinor: 20000, receiveMinor: 396014 },
  en: { title: 'Prepayment disclosure' },
  es: { title: 'Divulgación previa al pago' },
})

describe.skipIf(!runDb)('receipt disclosure (integration, local Supabase)', () => {
  let db: Client
  let transferId: string

  const asRole = async (
    role: 'authenticated' | 'anon',
    sub: string | null,
    sql: string,
    params: unknown[] = [],
  ) => {
    await db.query('begin')
    try {
      await db.query(`set local role ${role}`)
      if (sub) {
        await db.query(`select set_config('request.jwt.claims', $1, true)`, [
          JSON.stringify({ sub, role }),
        ])
      }
      return await db.query(sql, params)
    } finally {
      await db.query('rollback')
    }
  }

  // create_transfer_from_quote seeds a transfer + its prepayment disclosure.
  const seedTransfer = async (userId: string): Promise<string> => {
    const recipient = await db.query(
      `insert into public.recipients (user_id, first_name, last_name, relationship, country)
       values ($1, 'Ana', 'García López', 'mother', 'MX') returning id`,
      [userId],
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
         now() + interval '15 minutes', 'active') returning id`,
      [userId, destination.rows[0].id],
    )
    const created = await db.query(
      `select public.create_transfer_from_quote($1, $2, $3, 'es', '{"version":1}'::jsonb) as result`,
      [quote.rows[0].id, userId, `receipt-test-${quote.rows[0].id}`],
    )
    return (created.rows[0].result as { transfer: { id: string } }).transfer.id
  }

  const insertReceipt = (locale = 'es', onConflict = false) =>
    db.query(
      `insert into public.disclosures (transfer_id, type, locale, content)
       values ($1, 'receipt', $2, $3::jsonb)${onConflict ? ' on conflict (transfer_id, type) do nothing' : ''}`,
      [transferId, locale, RECEIPT_CONTENT],
    )

  const receiptCount = async (): Promise<number> => {
    const res = await db.query(
      `select count(*)::int as n from public.disclosures where transfer_id = $1 and type = 'receipt'`,
      [transferId],
    )
    return res.rows[0].n as number
  }

  beforeAll(async () => {
    db = new Client({ connectionString: DB_URL })
    await db.connect()
    await db.query(
      `insert into auth.users (id, phone) values ($1, '15550000091'), ($2, '15550000092')
       on conflict (id) do nothing`,
      [USER_A, USER_B],
    )
  })

  afterAll(async () => {
    await db.query(
      `truncate table public.ledger_entries, public.ledger_transactions, public.payment_events,
       public.disputes, public.disclosures, public.transfer_transitions, public.transfers,
       public.quotes, public.payout_destinations, public.recipients`,
    )
    await db.query('delete from auth.users where id in ($1, $2)', [USER_A, USER_B])
    await db.end()
  })

  beforeEach(async () => {
    await db.query(
      `truncate table public.ledger_entries, public.ledger_transactions, public.payment_events,
       public.disputes, public.disclosures, public.transfer_transitions, public.transfers,
       public.quotes, public.payout_destinations, public.recipients`,
    )
    transferId = await seedTransfer(USER_A)
  })

  it('upsert ON CONFLICT (transfer_id, type) DO NOTHING is idempotent — one receipt, no append-only trip', async () => {
    await insertReceipt('es', true)
    // a replay/catch-up re-runs the upsert; DO NOTHING skips the row (no UPDATE),
    // so it must neither duplicate nor raise the append-only trigger.
    await expect(insertReceipt('en', true)).resolves.toBeDefined()
    expect(await receiptCount()).toBe(1)
  })

  it('the UNIQUE constraint blocks a second receipt (plain insert → 23505)', async () => {
    await insertReceipt()
    await expect(insertReceipt('en')).rejects.toMatchObject({ code: '23505' })
  })

  it('a receipt coexists with the prepayment (constraint is per (transfer_id, type))', async () => {
    await insertReceipt()
    const types = await db.query(
      `select type from public.disclosures where transfer_id = $1 order by type`,
      [transferId],
    )
    expect(types.rows.map((r) => r.type)).toEqual(['prepayment', 'receipt'])
  })

  it('the receipt is append-only (update/delete forbidden)', async () => {
    await insertReceipt()
    await expect(
      db.query(`update public.disclosures set locale = 'en' where transfer_id = $1 and type = 'receipt'`, [
        transferId,
      ]),
    ).rejects.toThrow('append-only')
    await expect(
      db.query(`delete from public.disclosures where transfer_id = $1 and type = 'receipt'`, [transferId]),
    ).rejects.toThrow('append-only')
  })

  it('RLS: the owner reads their receipt; another user and anon see nothing', async () => {
    await insertReceipt()
    const asA = await asRole('authenticated', USER_A, `select type from public.disclosures where type = 'receipt'`)
    expect(asA.rows).toEqual([{ type: 'receipt' }])
    const asB = await asRole('authenticated', USER_B, `select type from public.disclosures where type = 'receipt'`)
    expect(asB.rows).toEqual([])
    const asAnon = await asRole('anon', null, `select type from public.disclosures where type = 'receipt'`)
    expect(asAnon.rows).toEqual([])
  })
})
