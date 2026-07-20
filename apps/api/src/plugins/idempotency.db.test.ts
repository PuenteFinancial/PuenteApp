// Gated: RUN_DB_TESTS=1. Proves the UNIQUE(user_id, endpoint, key) claim is
// race-safe with two real connections and that jsonb responses round-trip.
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import { Client } from 'pg'

const runDb = process.env.RUN_DB_TESTS === '1'

const DB_URL = process.env.TEST_DB_URL ?? 'postgresql://postgres:postgres@127.0.0.1:54322/postgres'

const USER = '00000000-0000-4000-8000-00000000004a'

describe.skipIf(!runDb)('idempotency_keys (integration, local Supabase)', () => {
  let db: Client

  beforeAll(async () => {
    db = new Client({ connectionString: DB_URL })
    await db.connect()
    await db.query(
      `insert into auth.users (id, phone) values ($1, '15550000041') on conflict (id) do nothing`,
      [USER],
    )
  })

  afterAll(async () => {
    await db.query('truncate table public.idempotency_keys')
    await db.query('delete from auth.users where id = $1', [USER])
    await db.end()
  })

  beforeEach(async () => {
    await db.query('truncate table public.idempotency_keys')
  })

  it('lets exactly one of two concurrent claims win', async () => {
    const db2 = new Client({ connectionString: DB_URL })
    await db2.connect()
    try {
      const claim = (client: Client) =>
        client
          .query(
            `insert into public.idempotency_keys (key, user_id, endpoint, request_hash)
             values ('race-key', $1, 'POST /v1/transfers', 'h1') returning id`,
            [USER],
          )
          .then(() => 'won')
          .catch((e: { code?: string }) => e.code ?? 'error')

      const results = await Promise.all([claim(db), claim(db2)])
      expect(results.sort()).toEqual(['23505', 'won'])

      const count = await db.query('select count(*)::int as n from public.idempotency_keys')
      expect(count.rows[0].n).toBe(1)
    } finally {
      await db2.end()
    }
  })

  it('scopes uniqueness to (user, endpoint, key) — same key on another endpoint is fine', async () => {
    await db.query(
      `insert into public.idempotency_keys (key, user_id, endpoint, request_hash)
       values ('k', $1, 'POST /v1/transfers', 'h1')`,
      [USER],
    )
    await db.query(
      `insert into public.idempotency_keys (key, user_id, endpoint, request_hash)
       values ('k', $1, 'POST /v1/transfers/:id/confirm', 'h1')`,
      [USER],
    )
    const count = await db.query('select count(*)::int as n from public.idempotency_keys')
    expect(count.rows[0].n).toBe(2)
  })

  it('round-trips jsonb responses and defaults expiry to ~24h out', async () => {
    const body = { id: 'tr-1', totalAmount: { amountMinor: 20000, currency: 'USD' } }
    await db.query(
      `insert into public.idempotency_keys (key, user_id, endpoint, request_hash, response_status, response_body)
       values ('k2', $1, 'POST /v1/transfers', 'h1', 201, $2::jsonb)`,
      [USER, JSON.stringify(body)],
    )
    const row = await db.query(
      `select response_status, response_body,
              expires_at between now() + interval '23 hours' and now() + interval '25 hours' as sane_expiry
       from public.idempotency_keys where key = 'k2'`,
    )
    expect(row.rows[0].response_status).toBe(201)
    expect(row.rows[0].response_body).toEqual(body)
    expect(row.rows[0].sane_expiry).toBe(true)
  })
})
