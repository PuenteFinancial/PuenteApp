// Integration tests against a real local Supabase stack (Docker).
// Gated: RUN_DB_TESTS=1. Proves the sender_notices schema (migration
// 20260910200000) at the DATABASE level: a well-formed notice lands; the CHECKs
// hold (kind/language/channel/status each pinned to their known set, subject and
// body bounded); the table is append-only (UPDATE and DELETE raise through
// forbid_mutation); a user or transfer with a notice cannot be deleted
// (RESTRICT — the record that we notified someone outlives them); and no client
// role reads or writes a row (deny-all RLS).
//
// Also pins the 20260910200100 half: 'sender_unfreeze' is now a legal
// ops_actions action, which is what makes the unfreeze auditable at all.
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { Client } from 'pg'

// The SERVICE, not a hand-built statement. Everything else in this file runs as
// the `postgres` superuser over raw pg, which is exactly why it could not see
// the bug below.
const { recordAccountFrozenNotice, renderAccountFrozenNotice } = await import('./sender-notices.js')
const { supabaseAdmin } = await import('./supabase.js')

const runDb = process.env.RUN_DB_TESTS === '1'

const DB_URL = process.env.TEST_DB_URL ?? 'postgresql://postgres:postgres@127.0.0.1:54322/postgres'

// Fixed UUIDs in the …009x block — no collisions with the other db tests.
const OWNER = '00000000-0000-4000-8000-00000000009a'
const T_FROZEN = '00000000-0000-4000-8000-000000000091'

const BODY =
  'Your Puente account is on hold while we look into a problem with a payment used to fund a recent transfer.'

const ROW = {
  user_id: OWNER,
  transfer_id: T_FROZEN,
  kind: 'account_frozen',
  language: 'en',
  channel: 'manual',
  status: 'pending',
  subject: 'Your Puente account is on hold',
  body: BODY,
}

function insertSql(overrides: Partial<Record<keyof typeof ROW, unknown>> = {}) {
  const row = { ...ROW, ...overrides }
  return {
    text: `insert into public.sender_notices
      (user_id, transfer_id, kind, language, channel, status, subject, body)
      values ($1, $2, $3, $4, $5, $6, $7, $8) returning id`,
    values: [
      row.user_id,
      row.transfer_id,
      row.kind,
      row.language,
      row.channel,
      row.status,
      row.subject,
      row.body,
    ],
  }
}

describe.skipIf(!runDb)('sender_notices schema (integration, local Supabase)', () => {
  let db: Client

  beforeAll(async () => {
    db = new Client({ connectionString: DB_URL })
    await db.connect()
    await db.query(`insert into auth.users (id, phone) values ($1, $2) on conflict (id) do nothing`, [
      OWNER,
      '15550000091',
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
      [T_FROZEN, OWNER, destination.rows[0].id, quote.rows[0].id, `sender-notices-db-${T_FROZEN}`],
    )
  })

  afterAll(async () => {
    // truncate bypasses the append-only row trigger (precedent: every other
    // db test does the same for transfer_transitions).
    await db.query('truncate table public.sender_notices')
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

  it('accepts a transfer-scoped notice and an account-level one with no transfer', async () => {
    const scoped = await db.query(insertSql())
    expect(scoped.rows[0].id).toEqual(expect.any(String))
    const accountLevel = await db.query(insertSql({ transfer_id: null }))
    expect(accountLevel.rows[0].id).toEqual(expect.any(String))

    const back = await db.query(
      'select kind, language, channel, status, subject, body from public.sender_notices where id = $1',
      [scoped.rows[0].id],
    )
    // The rendered text is stored, so "what did we tell this person" survives a
    // later copy change.
    expect(back.rows[0]).toEqual({
      kind: 'account_frozen',
      language: 'en',
      channel: 'manual',
      status: 'pending',
      subject: ROW.subject,
      body: BODY,
    })
  })

  it('stores the Spanish rendering under the same shape', async () => {
    const es = await db.query(
      insertSql({ language: 'es', subject: 'Tu cuenta de Puente está en revisión', body: 'Tu cuenta está en revisión.' }),
    )
    expect(es.rows[0].id).toEqual(expect.any(String))
  })

  it.each([
    ['a kind outside the pinned set', { kind: 'account_closed' }],
    ['a language the app does not ship', { language: 'pt' }],
    ['a channel that does not exist yet', { channel: 'email' }],
    ['a status outside the pinned set', { status: 'delivered' }],
    ['an empty subject', { subject: '' }],
    ['a subject longer than 200 chars', { subject: 'x'.repeat(201) }],
    ['an empty body', { body: '' }],
    ['a body longer than 2000 chars', { body: 'x'.repeat(2001) }],
  ])('rejects %s (CHECK)', async (_label, overrides) => {
    await expect(db.query(insertSql(overrides))).rejects.toMatchObject({ code: '23514' })
  })

  it('is append-only: UPDATE and DELETE raise', async () => {
    // The row is the record of what was said and when. An editable notice is
    // not evidence of anything.
    const { rows } = await db.query(insertSql())
    const id = rows[0].id
    await expect(
      db.query(`update public.sender_notices set status = 'sent' where id = $1`, [id]),
    ).rejects.toThrow(/append-only/)
    await expect(db.query(`delete from public.sender_notices where id = $1`, [id])).rejects.toThrow(/append-only/)
  })

  it('RESTRICT on both foreign keys: the proof outlives the transfer and the user', async () => {
    await db.query(insertSql())
    await expect(db.query('delete from public.transfers where id = $1', [T_FROZEN])).rejects.toMatchObject({
      code: '23503',
    })
    await expect(db.query('delete from public.users where id = $1', [OWNER])).rejects.toMatchObject({
      code: '23503',
    })
  })

  // Same two acceptable mechanisms as ops_actions: a GRANT plus deny-all
  // (zero rows) or no client GRANT at all (42501). A row must never come back.
  const clientReadCount = async (role: 'anon' | 'authenticated'): Promise<number> => {
    try {
      const r = await asRole(role, 'select count(*)::int as n from public.sender_notices')
      return r.rows[0].n
    } catch (err) {
      expect(err).toMatchObject({ code: '42501' })
      return 0
    }
  }

  it('RLS: neither anon nor the sender themselves reads or writes a row', async () => {
    // Even the subject of the notice has no direct path to it: the web tier has
    // no Supabase access, so every read is the API's.
    await db.query(insertSql())
    expect(await clientReadCount('anon')).toBe(0)
    expect(await clientReadCount('authenticated')).toBe(0)
    await expect(asRole('authenticated', insertSql().text, insertSql().values)).rejects.toMatchObject({
      code: '42501',
    })
  })

  it('the API can actually write one: service_role holds the grants', async () => {
    // THE REGRESSION THIS FILE ONCE MISSED. Every other test here runs as the
    // `postgres` superuser over raw pg, so all of them passed against a table
    // that service_role could not touch: applying the migration with
    // `supabase migration up` produced no privileges for it at all (the other
    // tables inherited theirs from `alter default privileges`, which depends on
    // which role ran the migration). The API's first insert came back 42501,
    // and only driving the real service against the stack revealed it. A
    // missing notice pages and is otherwise invisible, so the grant is explicit
    // in the migration now and this is the test that holds it there.
    const log = { info: () => {}, error: () => {} }
    const wrote = await recordAccountFrozenNotice(
      { userId: OWNER, transferId: T_FROZEN, language: 'es' },
      log,
    )
    expect(wrote).toBe(true)

    // Matched on the rendered body, not on `language` alone: an earlier test in
    // this file also inserts an es row, by hand, with different text.
    const { data, error } = await supabaseAdmin
      .from('sender_notices')
      .select('language, channel, status, body')
      .eq('user_id', OWNER)
      .eq('body', renderAccountFrozenNotice('es').body)
    expect(error).toBeNull()
    expect(data).toEqual([
      {
        language: 'es',
        channel: 'manual',
        status: 'pending',
        body: renderAccountFrozenNotice('es').body,
      },
    ])
  })

  it("ops_actions accepts 'sender_unfreeze' — the decision half of the freeze pair", async () => {
    const { rows } = await db.query(
      `insert into public.ops_actions (actor, action, transfer_id, reason, note, before, after, request_id)
       values ($1, 'sender_unfreeze', null, 'operator_review', $2, $3::jsonb, $4::jsonb, null) returning id`,
      [
        'ops:00000000-0000-4000-8000-00000000009f',
        'Sender repaid the returned debit; bank confirmed by phone.',
        JSON.stringify({ status: 'suspended' }),
        JSON.stringify({ status: 'active' }),
      ],
    )
    expect(rows[0].id).toEqual(expect.any(String))
  })
})
