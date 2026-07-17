// Integration tests against a real local Supabase stack (Docker).
// Gated: RUN_DB_TESTS=1 (see docs/runbooks/local-dev.md). Plain `pnpm test`
// skips them.
//
// Everything here BYPASSES the API on purpose: a raw pg client proves the
// database itself enforces ownership (RLS), write denial, and the CHECK/FK
// constraints even if the service layer is compromised or buggy.
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import { Client } from 'pg'

const runDb = process.env.RUN_DB_TESTS === '1'

const DB_URL = process.env.TEST_DB_URL ?? 'postgresql://postgres:postgres@127.0.0.1:54322/postgres'

const USER_A = '00000000-0000-4000-8000-00000000000a'
const USER_B = '00000000-0000-4000-8000-00000000000b'

describe.skipIf(!runDb)('recipients + payout_destinations (integration, local Supabase)', () => {
  let db: Client

  // Runs a query as a Supabase client role with auth.uid() = sub. Everything
  // happens in a rolled-back transaction so role/claims never leak between
  // tests and denied writes leave no residue.
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

  const seedRecipient = async (userId: string, firstName: string): Promise<string> => {
    const res = await db.query(
      `insert into public.recipients (user_id, first_name, last_name, relationship, country)
       values ($1, $2, 'García López', 'mother', 'MX') returning id`,
      [userId, firstName],
    )
    return res.rows[0].id
  }

  const seedDestination = async (recipientId: string, providerRef: string): Promise<string> => {
    const res = await db.query(
      `insert into public.payout_destinations (recipient_id, method, currency, details, provider_account_ref)
       values ($1, 'bank_account', 'MXN', '{"clabe_ciphertext":"v1.x.y.z","clabe_last4":"0006"}', $2)
       returning id`,
      [recipientId, providerRef],
    )
    return res.rows[0].id
  }

  beforeAll(async () => {
    db = new Client({ connectionString: DB_URL })
    await db.connect()
    // The on_auth_user_created trigger creates the public.users rows.
    await db.query(
      `insert into auth.users (id, phone) values ($1, '15550000001'), ($2, '15550000002')
       on conflict (id) do nothing`,
      [USER_A, USER_B],
    )
  })

  afterAll(async () => {
    await db.query('delete from auth.users where id in ($1, $2)', [USER_A, USER_B])
    await db.end()
  })

  beforeEach(async () => {
    await db.query('truncate table public.payout_destinations, public.recipients')
  })

  describe('row level security', () => {
    it('owner sees only their own recipients; anon sees nothing', async () => {
      await seedRecipient(USER_A, 'Ana')
      await seedRecipient(USER_B, 'Beto')

      const asA = await asRole('authenticated', USER_A, 'select first_name from public.recipients')
      expect(asA.rows).toEqual([{ first_name: 'Ana' }])

      const asB = await asRole('authenticated', USER_B, 'select first_name from public.recipients')
      expect(asB.rows).toEqual([{ first_name: 'Beto' }])

      const asAnon = await asRole('anon', null, 'select first_name from public.recipients')
      expect(asAnon.rows).toEqual([])
    })

    it('destination visibility traverses the recipient (EXISTS policy)', async () => {
      const recipientA = await seedRecipient(USER_A, 'Ana')
      const recipientB = await seedRecipient(USER_B, 'Beto')
      await seedDestination(recipientA, 'ea_a')
      await seedDestination(recipientB, 'ea_b')

      const asA = await asRole(
        'authenticated',
        USER_A,
        'select provider_account_ref from public.payout_destinations',
      )
      expect(asA.rows).toEqual([{ provider_account_ref: 'ea_a' }])

      const asAnon = await asRole(
        'anon',
        null,
        'select provider_account_ref from public.payout_destinations',
      )
      expect(asAnon.rows).toEqual([])
    })

    it('authenticated INSERT is rejected on both tables (no write policies)', async () => {
      await expect(
        asRole(
          'authenticated',
          USER_A,
          `insert into public.recipients (user_id, first_name, last_name, relationship, country)
           values ($1, 'Mal', 'Icioso', 'self', 'MX')`,
          [USER_A],
        ),
      ).rejects.toMatchObject({ code: '42501' })

      const recipientA = await seedRecipient(USER_A, 'Ana')
      await expect(
        asRole(
          'authenticated',
          USER_A,
          `insert into public.payout_destinations (recipient_id, method, currency, details)
           values ($1, 'bank_account', 'MXN', '{}')`,
          [recipientA],
        ),
      ).rejects.toMatchObject({ code: '42501' })
    })

    it('authenticated UPDATE/DELETE match zero rows (no write policies)', async () => {
      const recipientA = await seedRecipient(USER_A, 'Ana')
      await seedDestination(recipientA, 'ea_a')

      // even the OWNER cannot write directly — writes go through the API
      const upd = await asRole(
        'authenticated',
        USER_A,
        `update public.recipients set relationship = 'hacked' where id = $1`,
        [recipientA],
      )
      expect(upd.rowCount).toBe(0)

      const del = await asRole(
        'authenticated',
        USER_A,
        'delete from public.payout_destinations',
      )
      expect(del.rowCount).toBe(0)
    })
  })

  describe('constraints', () => {
    it.each([
      ['bad recipient status', `insert into public.recipients (user_id, first_name, last_name, relationship, country, status) values ('${USER_A}', 'A', 'B', 'mother', 'MX', 'deleted')`],
      ['3-letter country', `insert into public.recipients (user_id, first_name, last_name, relationship, country) values ('${USER_A}', 'A', 'B', 'mother', 'MEX')`],
      ['lowercase country', `insert into public.recipients (user_id, first_name, last_name, relationship, country) values ('${USER_A}', 'A', 'B', 'mother', 'mx')`],
      ['empty first_name', `insert into public.recipients (user_id, first_name, last_name, relationship, country) values ('${USER_A}', '', 'B', 'mother', 'MX')`],
    ])('%s raises 23514', async (_name, sql) => {
      await expect(db.query(sql)).rejects.toMatchObject({ code: '23514' })
    })

    it('bad method / verification_status / currency raise 23514', async () => {
      const recipientId = await seedRecipient(USER_A, 'Ana')
      const base = (cols: string, vals: string) =>
        `insert into public.payout_destinations (recipient_id, details, ${cols}) values ('${recipientId}', '{}', ${vals})`

      await expect(
        db.query(base(`method, currency`, `'paypal', 'MXN'`)),
      ).rejects.toMatchObject({ code: '23514' })
      await expect(
        db.query(base(`method, currency`, `'bank_account', 'mxn'`)),
      ).rejects.toMatchObject({ code: '23514' })
      await expect(
        db.query(base(`method, currency, verification_status`, `'bank_account', 'MXN', 'maybe'`)),
      ).rejects.toMatchObject({ code: '23514' })
    })

    it('duplicate provider_account_ref raises 23505; multiple NULLs are fine', async () => {
      const recipientId = await seedRecipient(USER_A, 'Ana')
      await seedDestination(recipientId, 'ea_dup')
      await expect(seedDestination(recipientId, 'ea_dup')).rejects.toMatchObject({ code: '23505' })

      // unregistered destinations (NULL ref) must not collide
      await db.query(
        `insert into public.payout_destinations (recipient_id, method, currency, details)
         values ($1, 'bank_account', 'MXN', '{}'), ($1, 'bank_account', 'MXN', '{}')`,
        [recipientId],
      )
    })

    it('deleting a recipient cascades to its destinations', async () => {
      const recipientId = await seedRecipient(USER_A, 'Ana')
      await seedDestination(recipientId, 'ea_cascade')

      await db.query('delete from public.recipients where id = $1', [recipientId])
      const rest = await db.query('select count(*)::int as n from public.payout_destinations')
      expect(rest.rows[0].n).toBe(0)
    })

    it('moddatetime advances updated_at on update', async () => {
      const recipientId = await seedRecipient(USER_A, 'Ana')
      const before = await db.query(
        'select updated_at from public.recipients where id = $1',
        [recipientId],
      )
      await new Promise((resolve) => setTimeout(resolve, 10))
      await db.query(`update public.recipients set relationship = 'aunt' where id = $1`, [
        recipientId,
      ])
      const after = await db.query(
        'select updated_at from public.recipients where id = $1',
        [recipientId],
      )
      expect(new Date(after.rows[0].updated_at).getTime()).toBeGreaterThan(
        new Date(before.rows[0].updated_at).getTime(),
      )
    })
  })
})
