// Integration tests against a real local Supabase stack (Docker).
// Gated: RUN_DB_TESTS=1 (see docs/runbooks/local-dev.md). Plain `pnpm test`
// skips them.
//
// Everything here BYPASSES the API on purpose: a raw pg client proves the
// database itself enforces ownership (RLS), write denial, the domain CHECKs,
// and the quote-terms immutability trigger even if the service layer is
// compromised or buggy.
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import { Client } from 'pg'

const runDb = process.env.RUN_DB_TESTS === '1'

const DB_URL = process.env.TEST_DB_URL ?? 'postgresql://postgres:postgres@127.0.0.1:54322/postgres'

const USER_A = '00000000-0000-4000-8000-00000000001a'
const USER_B = '00000000-0000-4000-8000-00000000001b'
const USER_C = '00000000-0000-4000-8000-00000000001c'

describe.skipIf(!runDb)('quotes (integration, local Supabase)', () => {
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

  const seedDestination = async (userId: string): Promise<string> => {
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
    return destination.rows[0].id
  }

  const seedQuote = async (
    userId: string,
    destinationId: string,
    overrides: Record<string, string> = {},
  ): Promise<string> => {
    const cols: Record<string, string> = {
      send_amount_minor: '19801',
      send_currency: `'USD'`,
      receive_amount_minor: '396014',
      receive_currency: `'MXN'`,
      fee_amount_minor: '199',
      fee_currency: `'USD'`,
      fx_rate: '19.9997',
      source_rate: '20.10025100',
      fx_rate_at: 'now()',
      expires_at: `now() + interval '15 minutes'`,
      ...overrides,
    }
    const res = await db.query(
      `insert into public.quotes (user_id, payout_destination_id, ${Object.keys(cols).join(', ')})
       values ('${userId}', '${destinationId}', ${Object.values(cols).join(', ')}) returning id`,
    )
    return res.rows[0].id
  }

  beforeAll(async () => {
    db = new Client({ connectionString: DB_URL })
    await db.connect()
    await db.query(
      `insert into auth.users (id, phone) values ($1, '15550000011'), ($2, '15550000012'), ($3, '15550000013')
       on conflict (id) do nothing`,
      [USER_A, USER_B, USER_C],
    )
  })

  afterAll(async () => {
    await db.query('delete from auth.users where id in ($1, $2, $3)', [USER_A, USER_B, USER_C])
    await db.end()
  })

  beforeEach(async () => {
    await db.query('truncate table public.quotes, public.payout_destinations, public.recipients')
  })

  describe('row level security', () => {
    it('owner sees only their own quotes; anon sees nothing', async () => {
      await seedQuote(USER_A, await seedDestination(USER_A))
      await seedQuote(USER_B, await seedDestination(USER_B))

      const asA = await asRole('authenticated', USER_A, 'select user_id from public.quotes')
      expect(asA.rows).toEqual([{ user_id: USER_A }])

      const asAnon = await asRole('anon', null, 'select user_id from public.quotes')
      expect(asAnon.rows).toEqual([])
    })

    it('authenticated INSERT is rejected; UPDATE matches zero rows (no write policies)', async () => {
      const destinationId = await seedDestination(USER_A)
      await expect(
        asRole(
          'authenticated',
          USER_A,
          `insert into public.quotes (user_id, payout_destination_id, send_amount_minor, send_currency,
             receive_amount_minor, receive_currency, fee_amount_minor, fee_currency,
             fx_rate, source_rate, fx_rate_at, expires_at)
           values ($1, $2, 100, 'USD', 2000, 'MXN', 0, 'USD', 19.9997, 20.1, now(), now() + interval '15 minutes')`,
          [USER_A, destinationId],
        ),
      ).rejects.toMatchObject({ code: '42501' })

      const quoteId = await seedQuote(USER_A, destinationId)
      const upd = await asRole(
        'authenticated',
        USER_A,
        `update public.quotes set status = 'consumed' where id = $1`,
        [quoteId],
      )
      expect(upd.rowCount).toBe(0)
    })
  })

  describe('domain constraints', () => {
    it.each([
      ['non-USD send currency', { send_currency: `'MXN'` }],
      ['non-MXN receive currency', { receive_currency: `'USD'` }],
      ['non-USD fee currency', { fee_currency: `'MXN'` }],
      ['zero send amount', { send_amount_minor: '0' }],
      ['zero receive amount', { receive_amount_minor: '0' }],
      ['negative fee', { fee_amount_minor: '-1' }],
      ['zero fx_rate', { fx_rate: '0' }],
      ['zero source_rate', { source_rate: '0' }],
      ['unknown status', { status: `'pending'` }],
      ['expiry before creation', { expires_at: `now() - interval '1 second'` }],
    ])('%s raises 23514', async (_name, overrides) => {
      const destinationId = await seedDestination(USER_A)
      await expect(seedQuote(USER_A, destinationId, overrides)).rejects.toMatchObject({
        code: '23514',
      })
    })
  })

  describe('terms immutability', () => {
    it('rejects updates to pricing terms, even for the table owner role', async () => {
      const quoteId = await seedQuote(USER_A, await seedDestination(USER_A))

      for (const mutation of [
        `fx_rate = 21.0000`,
        `send_amount_minor = 1`,
        `fee_amount_minor = 0`,
        `receive_amount_minor = 1`,
        `expires_at = now() + interval '1 year'`,
        `status = 'consumed', fx_rate = 21.0000`,
      ]) {
        await expect(
          db.query(`update public.quotes set ${mutation} where id = $1`, [quoteId]),
        ).rejects.toMatchObject({ code: 'P0001' })
      }
    })

    it('allows the status lifecycle and advances updated_at', async () => {
      const quoteId = await seedQuote(USER_A, await seedDestination(USER_A))
      const before = await db.query('select updated_at from public.quotes where id = $1', [quoteId])

      await new Promise((resolve) => setTimeout(resolve, 10))
      await db.query(`update public.quotes set status = 'consumed' where id = $1`, [quoteId])

      const after = await db.query('select status, updated_at from public.quotes where id = $1', [
        quoteId,
      ])
      expect(after.rows[0].status).toBe('consumed')
      expect(new Date(after.rows[0].updated_at).getTime()).toBeGreaterThan(
        new Date(before.rows[0].updated_at).getTime(),
      )
    })
  })

  describe('referential behavior', () => {
    it('preserves quote history: deleting a recipient with quoted destinations is blocked', async () => {
      const destinationId = await seedDestination(USER_A)
      await seedQuote(USER_A, destinationId)

      await expect(db.query('delete from public.recipients')).rejects.toMatchObject({
        code: '23503',
      })
    })

    it('deleting the auth user cascades away their quotes', async () => {
      await seedQuote(USER_C, await seedDestination(USER_C))

      await db.query('delete from auth.users where id = $1', [USER_C])
      const rest = await db.query('select count(*)::int as n from public.quotes')
      expect(rest.rows[0].n).toBe(0)
    })

    it('stores fx_rate at fixed scale 4 and source_rate at full precision', async () => {
      const quoteId = await seedQuote(USER_A, await seedDestination(USER_A))
      const row = await db.query('select fx_rate, source_rate from public.quotes where id = $1', [
        quoteId,
      ])
      expect(row.rows[0].fx_rate).toBe('19.9997')
      expect(row.rows[0].source_rate).toBe('20.10025100')
    })
  })
})
