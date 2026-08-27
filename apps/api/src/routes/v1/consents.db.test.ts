// Integration tests against a real local Supabase stack (Docker).
// Gated: RUN_DB_TESTS=1 (see docs/runbooks/local-dev.md). Plain `pnpm test`
// skips them.
//
// Proves the consents table itself enforces what the API relies on: owner-only
// reads, no client writes, append-only immutability (forbid_mutation), the
// (user_id, type, version) uniqueness the idempotent upsert depends on, and
// the type/locale CHECKs.
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import { Client } from 'pg'

const runDb = process.env.RUN_DB_TESTS === '1'

const DB_URL = process.env.TEST_DB_URL ?? 'postgresql://postgres:postgres@127.0.0.1:54322/postgres'

const USER_A = '00000000-0000-4000-8000-00000000000a'
const USER_B = '00000000-0000-4000-8000-00000000000b'

describe.skipIf(!runDb)('consents (integration, local Supabase)', () => {
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

  const seedConsent = async (userId: string, type = 'esign', version = '2026-08-27') => {
    const res = await db.query(
      `insert into public.consents (user_id, type, version, locale, evidence)
       values ($1, $2, $3, 'en', '{"ip":"127.0.0.1"}') returning id`,
      [userId, type, version],
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
    await db.query('delete from public.consents where user_id in ($1, $2)', [USER_A, USER_B])
    await db.query('delete from auth.users where id in ($1, $2)', [USER_A, USER_B])
    await db.end()
  })

  beforeEach(async () => {
    await db.query('truncate table public.consents')
  })

  describe('row level security', () => {
    it('owner sees only their own consents; anon sees nothing', async () => {
      await seedConsent(USER_A)
      await seedConsent(USER_B)

      const asA = await asRole('authenticated', USER_A, 'select user_id from public.consents')
      expect(asA.rows).toEqual([{ user_id: USER_A }])

      const asAnon = await asRole('anon', null, 'select user_id from public.consents')
      expect(asAnon.rows).toEqual([])
    })

    it('clients cannot insert — grants only land through the API service role', async () => {
      await expect(
        asRole(
          'authenticated',
          USER_A,
          `insert into public.consents (user_id, type, version, locale) values ($1, 'esign', '2026-08-27', 'en')`,
          [USER_A],
        ),
      ).rejects.toThrow(/row-level security/)
    })
  })

  describe('append-only', () => {
    it('rejects UPDATE even as the service role', async () => {
      const id = await seedConsent(USER_A)
      await expect(
        db.query(`update public.consents set version = '2030-01-01' where id = $1`, [id]),
      ).rejects.toThrow(/append-only/)
    })

    it('rejects DELETE even as the service role', async () => {
      const id = await seedConsent(USER_A)
      await expect(db.query('delete from public.consents where id = $1', [id])).rejects.toThrow(
        /append-only/,
      )
    })
  })

  describe('constraints', () => {
    it('enforces one row per (user_id, type, version); DO NOTHING makes re-grants no-ops', async () => {
      await seedConsent(USER_A)
      await expect(seedConsent(USER_A)).rejects.toThrow(/duplicate key/)

      // The API's upsert path: conflict resolves to DO NOTHING, no error,
      // original row (and its evidence) untouched.
      const res = await db.query(
        `insert into public.consents (user_id, type, version, locale, evidence)
         values ($1, 'esign', '2026-08-27', 'es', '{"ip":"10.0.0.9"}')
         on conflict (user_id, type, version) do nothing
         returning id`,
        [USER_A],
      )
      expect(res.rows).toEqual([])
      const kept = await db.query(
        'select locale from public.consents where user_id = $1',
        [USER_A],
      )
      expect(kept.rows).toEqual([{ locale: 'en' }])
    })

    it('a new VERSION of the same type is a fresh row — re-consent after a doc bump', async () => {
      await seedConsent(USER_A, 'esign', '2026-08-27')
      await seedConsent(USER_A, 'esign', '2027-01-01')
      const res = await db.query(
        'select count(*)::int as n from public.consents where user_id = $1',
        [USER_A],
      )
      expect(res.rows[0].n).toBe(2)
    })

    it('rejects unknown consent types and locales', async () => {
      await expect(seedConsent(USER_A, 'made_up_type')).rejects.toThrow(/check constraint/)
      await expect(
        db.query(
          `insert into public.consents (user_id, type, version, locale) values ($1, 'esign', 'v1', 'fr')`,
          [USER_A],
        ),
      ).rejects.toThrow(/check constraint/)
    })
  })
})
