// Integration tests against a real local Supabase stack (Docker).
// Gated: RUN_DB_TESTS=1. Proves the ops_actions schema (migration
// 20260908171500) at the DATABASE level: a well-formed row lands; the CHECKs
// hold (action pinned to the known set, note ≤ 500, before/after must be
// objects, actor non-empty); the table is append-only (UPDATE and DELETE raise
// through forbid_mutation); a transfer with an action cannot be deleted
// (RESTRICT); and no client role reads or writes a row (deny-all RLS).
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { Client } from 'pg'

const runDb = process.env.RUN_DB_TESTS === '1'

const DB_URL = process.env.TEST_DB_URL ?? 'postgresql://postgres:postgres@127.0.0.1:54322/postgres'

// Fixed UUIDs in the …007x block — no collisions with the other db tests.
const OWNER = '00000000-0000-4000-8000-00000000007a'
const T_HELD = '00000000-0000-4000-8000-000000000071'
const ACTOR = 'ops:00000000-0000-4000-8000-00000000007f'

const ROW = {
  actor: ACTOR,
  action: 'hold_release',
  transfer_id: T_HELD,
  reason: 'velocity_review',
  note: 'Verified with the sender; both sends today are legitimate.',
  before: { payoutHoldReason: 'velocity_review', payoutHeldAt: '2026-09-08T11:00:00.000Z' },
  after: { payoutHoldReason: null, payoutHeldAt: null },
  request_id: 'req-db-1',
}

function insertSql(overrides: Partial<Record<keyof typeof ROW, unknown>> = {}) {
  const row = { ...ROW, ...overrides }
  return {
    text: `insert into public.ops_actions
      (actor, action, transfer_id, reason, note, before, after, request_id)
      values ($1, $2, $3, $4, $5, $6::jsonb, $7::jsonb, $8) returning id`,
    values: [
      row.actor,
      row.action,
      row.transfer_id,
      row.reason,
      row.note,
      JSON.stringify(row.before),
      JSON.stringify(row.after),
      row.request_id,
    ],
  }
}

describe.skipIf(!runDb)('ops_actions schema (integration, local Supabase)', () => {
  let db: Client

  beforeAll(async () => {
    db = new Client({ connectionString: DB_URL })
    await db.connect()
    await db.query(`insert into auth.users (id, phone) values ($1, $2) on conflict (id) do nothing`, [
      OWNER,
      '15550000071',
    ])
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
      [T_HELD, OWNER, destination.rows[0].id, quote.rows[0].id, `ops-actions-db-${T_HELD}`],
    )
  })

  afterAll(async () => {
    // truncate bypasses the append-only row trigger (precedent: every other
    // db test does the same for transfer_transitions).
    await db.query('truncate table public.ops_actions')
    await db.query('delete from public.transfers where user_id = $1', [OWNER])
    await db.query('delete from public.quotes where user_id = $1', [OWNER])
    await db.query(
      `delete from public.payout_destinations where recipient_id in
       (select id from public.recipients where user_id = $1)`,
      [OWNER],
    )
    await db.query('delete from public.recipients where user_id = $1', [OWNER])
    await db.query('delete from auth.users where id = $1', [OWNER])
    await db.end()
  })

  const asRole = async (role: 'anon' | 'authenticated', sql: string, values: unknown[] = []) => {
    await db.query('begin')
    try {
      await db.query(`set local role ${role}`)
      if (role === 'authenticated') {
        await db.query(`select set_config('request.jwt.claims', $1, true)`, [
          JSON.stringify({ sub: OWNER, role: 'authenticated' }),
        ])
      }
      return await db.query(sql, values)
    } finally {
      await db.query('rollback')
    }
  }

  it('accepts a well-formed transfer-scoped row and a treasury row with no transfer', async () => {
    const held = await db.query(insertSql())
    expect(held.rows[0].id).toEqual(expect.any(String))
    const treasury = await db.query(
      insertSql({ action: 'float_topup', transfer_id: null, reason: null, note: null, before: {}, after: { amountMinor: 1 } }),
    )
    expect(treasury.rows[0].id).toEqual(expect.any(String))
    const back = await db.query('select action, transfer_id, before, after from public.ops_actions where id = $1', [
      held.rows[0].id,
    ])
    expect(back.rows[0]).toEqual({
      action: 'hold_release',
      transfer_id: T_HELD,
      before: ROW.before,
      after: ROW.after,
    })
  })

  it.each([
    ['an action outside the pinned set', { action: 'delete_everything' }],
    ['an empty actor', { actor: '' }],
    ['a note longer than 500 chars', { note: 'x'.repeat(501) }],
    ['an empty note', { note: '' }],
    ['a non-object before', { before: [] }],
    ['a non-object after', { after: 'nope' }],
  ])('rejects %s (CHECK)', async (_label, overrides) => {
    await expect(db.query(insertSql(overrides))).rejects.toMatchObject({ code: '23514' })
  })

  it('is append-only: UPDATE and DELETE raise', async () => {
    const { rows } = await db.query(insertSql({ request_id: 'req-db-mut' }))
    const id = rows[0].id
    await expect(db.query(`update public.ops_actions set note = 'edited' where id = $1`, [id])).rejects.toThrow(
      /append-only/,
    )
    await expect(db.query(`delete from public.ops_actions where id = $1`, [id])).rejects.toThrow(/append-only/)
  })

  it('RESTRICT: a transfer with an ops action cannot be deleted', async () => {
    await db.query(insertSql({ request_id: 'req-db-fk' }))
    await expect(db.query('delete from public.transfers where id = $1', [T_HELD])).rejects.toMatchObject({
      code: '23503',
    })
  })

  // Two mechanisms yield the same posture and both are acceptable: a table
  // GRANT plus the deny-all policy (hosted default privileges → zero rows), or
  // no client GRANT at all (the local stack's default → 42501 on the read).
  // What must never happen is a row coming back.
  const clientReadCount = async (role: 'anon' | 'authenticated'): Promise<number> => {
    try {
      const r = await asRole(role, 'select count(*)::int as n from public.ops_actions')
      return r.rows[0].n
    } catch (err) {
      expect(err).toMatchObject({ code: '42501' })
      return 0
    }
  }

  it('RLS: neither anon nor an authenticated user reads or writes a row', async () => {
    await db.query(insertSql({ request_id: 'req-db-rls' }))
    expect(await clientReadCount('anon')).toBe(0)
    expect(await clientReadCount('authenticated')).toBe(0)
    await expect(asRole('authenticated', insertSql().text, insertSql().values)).rejects.toMatchObject({
      code: '42501',
    })
  })
})
