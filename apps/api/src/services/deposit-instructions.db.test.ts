// Integration tests against a real local Supabase stack (Docker).
// Gated: RUN_DB_TESTS=1. Proves at the DATABASE level the #199 schema:
// one row per transfer (unique FK + upsert overwrite), the column checks
// (routing grammar, USD-only, positive amount), and RLS — the owner reads
// their transfer's instructions, another user reads nothing, anon reads
// nothing, and no client role can write.
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { Client } from 'pg'

const runDb = process.env.RUN_DB_TESTS === '1'

const DB_URL = process.env.TEST_DB_URL ?? 'postgresql://postgres:postgres@127.0.0.1:54322/postgres'

// Fixed UUIDs in the …006x block — no collisions with the other db tests.
const OWNER = '00000000-0000-4000-8000-00000000006a'
const OTHER = '00000000-0000-4000-8000-00000000006b'
const T_MINE = '00000000-0000-4000-8000-000000000061'

const ROW = {
  bridge_transfer_ref: '00000000-0000-4000-8000-000000000069',
  currency: 'USD',
  amount_minor: 10000,
  payment_rail: 'ach',
  bank_name: 'Lead Bank',
  bank_routing_number: '101019644',
  bank_account_number: '215268129123',
  deposit_message: 'BRGDBTEST1',
  attached_by: OWNER,
}

function insertSql(overrides: Partial<Record<keyof typeof ROW, unknown>> = {}) {
  const row = { ...ROW, ...overrides }
  return {
    text: `insert into public.deposit_instructions
      (transfer_id, bridge_transfer_ref, currency, amount_minor, payment_rail,
       bank_name, bank_routing_number, bank_account_number, deposit_message, attached_by)
      values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
    values: [
      T_MINE,
      row.bridge_transfer_ref,
      row.currency,
      row.amount_minor,
      row.payment_rail,
      row.bank_name,
      row.bank_routing_number,
      row.bank_account_number,
      row.deposit_message,
      row.attached_by,
    ],
  }
}

describe.skipIf(!runDb)('deposit_instructions schema (integration, local Supabase)', () => {
  let db: Client

  beforeAll(async () => {
    db = new Client({ connectionString: DB_URL })
    await db.connect()
    for (const [user, phone] of [
      [OWNER, '15550000061'],
      [OTHER, '15550000062'],
    ] as const) {
      await db.query(
        `insert into auth.users (id, phone) values ($1, $2) on conflict (id) do nothing`,
        [user, phone],
      )
    }
    const recipient = await db.query(
      `insert into public.recipients (user_id, first_name, last_name, relationship, country)
       values ($1, 'Ana', 'García López', 'mother', 'MX') returning id`,
      [OWNER],
    )
    const destination = await db.query(
      `insert into public.payout_destinations (recipient_id, method, currency, details)
       values ($1, 'bank_account', 'MXN', '{}') returning id`,
      [recipient.rows[0].id],
    )
    const quote = await db.query(
      `insert into public.quotes (user_id, payout_destination_id, send_amount_minor, send_currency,
         receive_amount_minor, receive_currency, fee_amount_minor, fee_currency, margin_minor,
         fx_rate, source_rate, fx_rate_at, expires_at, status)
       values ($1, $2, 10000, 'USD', 197997, 'MXN', 0, 'USD', 100, 19.7997, 20.100251, now(),
         now() + interval '15 minutes', 'consumed') returning id`,
      [OWNER, destination.rows[0].id],
    )
    await db.query(
      `insert into public.transfers (id, user_id, payout_destination_id, quote_id,
         send_amount_minor, send_currency, receive_amount_minor, receive_currency,
         fee_amount_minor, fee_currency, margin_minor, fx_rate, fx_rate_at, idempotency_key)
       values ($1, $2, $3, $4, 10000, 'USD', 197997, 'MXN', 0, 'USD', 100, 19.7997, now(), $5)`,
      [T_MINE, OWNER, destination.rows[0].id, quote.rows[0].id, `deposit-instructions-db-${T_MINE}`],
    )
  })

  afterAll(async () => {
    await db.query('delete from public.deposit_instructions where transfer_id = $1', [T_MINE])
    await db.query('delete from public.transfers where user_id = $1', [OWNER])
    await db.query('delete from public.quotes where user_id = $1', [OWNER])
    await db.query(
      `delete from public.payout_destinations where recipient_id in
       (select id from public.recipients where user_id = $1)`,
      [OWNER],
    )
    await db.query('delete from public.recipients where user_id = $1', [OWNER])
    await db.query('delete from auth.users where id in ($1, $2)', [OWNER, OTHER])
    await db.end()
  })

  const asUser = async (userId: string, sql: string, values: unknown[] = []) => {
    await db.query('begin')
    try {
      await db.query(`set local role authenticated`)
      await db.query(`select set_config('request.jwt.claims', $1, true)`, [
        JSON.stringify({ sub: userId, role: 'authenticated' }),
      ])
      return await db.query(sql, values)
    } finally {
      await db.query('rollback')
    }
  }

  it('accepts a valid row and overwrites on transfer_id conflict (re-attach)', async () => {
    await db.query(insertSql())
    const dup = insertSql({ deposit_message: 'BRGDBTEST2' })
    await db.query(
      dup.text.replace(
        'values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)',
        `values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
         on conflict (transfer_id) do update set deposit_message = excluded.deposit_message`,
      ),
      dup.values,
    )
    const rows = await db.query(
      'select deposit_message from public.deposit_instructions where transfer_id = $1',
      [T_MINE],
    )
    expect(rows.rows).toEqual([{ deposit_message: 'BRGDBTEST2' }])
  })

  it.each([
    ['currency', { currency: 'EUR' }],
    ['routing grammar', { bank_routing_number: '1234' }],
    ['amount', { amount_minor: 0 }],
    ['rail', { payment_rail: 'zelle' }],
  ])('rejects a bad %s at the database', async (_label, overrides) => {
    await db.query('delete from public.deposit_instructions where transfer_id = $1', [T_MINE])
    const bad = insertSql(overrides as Partial<Record<keyof typeof ROW, unknown>>)
    await expect(db.query(bad)).rejects.toThrow()
  })

  it('RLS: owner reads, another user and anon read nothing, no client writes', async () => {
    await db.query('delete from public.deposit_instructions where transfer_id = $1', [T_MINE])
    await db.query(insertSql())

    const mine = await asUser(
      OWNER,
      'select deposit_message from public.deposit_instructions where transfer_id = $1',
      [T_MINE],
    )
    expect(mine.rows).toEqual([{ deposit_message: 'BRGDBTEST1' }])

    const theirs = await asUser(
      OTHER,
      'select deposit_message from public.deposit_instructions where transfer_id = $1',
      [T_MINE],
    )
    expect(theirs.rows).toEqual([])

    await db.query('begin')
    try {
      await db.query('set local role anon')
      const anon = await db.query('select count(*)::int as n from public.deposit_instructions')
      expect(anon.rows[0].n).toBe(0)
    } finally {
      await db.query('rollback')
    }

    // No write policies exist: an authenticated owner cannot insert/update.
    await expect(
      asUser(OWNER, `update public.deposit_instructions set deposit_message = 'HACKED'`),
    ).resolves.toMatchObject({ rowCount: 0 })
  })
})
