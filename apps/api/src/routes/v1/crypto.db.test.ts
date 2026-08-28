// Integration tests against a real local Supabase stack (Docker).
// Gated: RUN_DB_TESTS=1. Plain `pnpm test` skips them.
//
// Proves what the API relies on for stripe_link_tokens: deny-all RLS (the
// row holds a live credential — no client role may even see it exists),
// one-row-per-user, and the moddatetime trigger. Plus the users crypto
// columns' uniqueness.
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import { Client } from 'pg'

const runDb = process.env.RUN_DB_TESTS === '1'

const DB_URL = process.env.TEST_DB_URL ?? 'postgresql://postgres:postgres@127.0.0.1:54322/postgres'

const USER_A = '00000000-0000-4000-8000-00000000000a'
const USER_B = '00000000-0000-4000-8000-00000000000b'

describe.skipIf(!runDb)('stripe_link_tokens (integration, local Supabase)', () => {
  let db: Client

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

  beforeAll(async () => {
    db = new Client({ connectionString: DB_URL })
    await db.connect()
    await db.query(
      `insert into auth.users (id, phone) values ($1, '15550000001'), ($2, '15550000002')
       on conflict (id) do nothing`,
      [USER_A, USER_B],
    )
  })

  afterAll(async () => {
    await db.query('delete from public.stripe_link_tokens where user_id in ($1, $2)', [USER_A, USER_B])
    await db.query('delete from auth.users where id in ($1, $2)', [USER_A, USER_B])
    await db.end()
  })

  beforeEach(async () => {
    await db.query('truncate table public.stripe_link_tokens')
  })

  it('deny-all RLS: the owner cannot even see their own credential row', async () => {
    await db.query(
      `insert into public.stripe_link_tokens (user_id, refresh_token_enc) values ($1, 'v1.x.y.z')`,
      [USER_A],
    )

    // Hosted projects grant table privileges and RLS (no policy) yields zero
    // rows; a local `supabase migration up` stack may lack the DML grants
    // entirely (known local CLI quirk) and throw permission-denied instead.
    // Either way the property holds: no client role reads a credential row.
    const rows = await asRole(
      'authenticated',
      USER_A,
      'select user_id from public.stripe_link_tokens',
    ).then(
      (r) => r.rows,
      (e: Error) => {
        expect(e.message).toMatch(/permission denied/)
        return []
      },
    )
    expect(rows).toEqual([])

    await expect(
      asRole(
        'authenticated',
        USER_A,
        `insert into public.stripe_link_tokens (user_id, refresh_token_enc) values ($1, 'v1.a.b.c')`,
        [USER_A],
      ),
    ).rejects.toThrow(/row-level security|permission denied/)
  })

  it('one Link identity per user; token column may be null until exchange', async () => {
    await db.query(
      `insert into public.stripe_link_tokens (user_id, auth_intent_id) values ($1, 'lai_1')`,
      [USER_A],
    )
    await expect(
      db.query(`insert into public.stripe_link_tokens (user_id, auth_intent_id) values ($1, 'lai_2')`, [
        USER_A,
      ]),
    ).rejects.toThrow(/duplicate key/)

    const row = await db.query(
      'select refresh_token_enc from public.stripe_link_tokens where user_id = $1',
      [USER_A],
    )
    expect(row.rows[0].refresh_token_enc).toBeNull()
  })

  it('moddatetime keeps updated_at current on token rotation', async () => {
    await db.query(
      `insert into public.stripe_link_tokens (user_id, refresh_token_enc, updated_at)
       values ($1, 'v1.old', now() - interval '1 hour')`,
      [USER_A],
    )
    await db.query(
      `update public.stripe_link_tokens set refresh_token_enc = 'v1.new' where user_id = $1`,
      [USER_A],
    )
    const row = await db.query(
      `select updated_at > now() - interval '1 minute' as fresh from public.stripe_link_tokens where user_id = $1`,
      [USER_A],
    )
    expect(row.rows[0].fresh).toBe(true)
  })

  it('users.stripe_crypto_customer_id is unique — one crc_ can never map to two users', async () => {
    await db.query(`update public.users set stripe_crypto_customer_id = 'crc_dup' where id = $1`, [
      USER_A,
    ])
    await expect(
      db.query(`update public.users set stripe_crypto_customer_id = 'crc_dup' where id = $1`, [USER_B]),
    ).rejects.toThrow(/duplicate key/)
    await db.query(`update public.users set stripe_crypto_customer_id = null where id = $1`, [USER_A])
  })
})
