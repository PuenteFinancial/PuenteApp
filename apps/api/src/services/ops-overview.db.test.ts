// Integration test for the 8.5-v1 ops migration against a real local Supabase
// stack. Gated like every *.db.test.ts: RUN_DB_TESTS=1 + local env — see
// docs/runbooks/local-dev.md.
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { Client } from 'pg'
import { supabaseAdmin } from './supabase.js'

const runDb = process.env.RUN_DB_TESTS === '1'

const DB_URL = process.env.TEST_DB_URL ?? 'postgresql://postgres:postgres@127.0.0.1:54322/postgres'

const OPS_USER = '00000000-0000-4000-8000-0000000000d1'

describe.skipIf(!runDb)('ops_transfer_state_counts (integration, local Supabase)', () => {
  let db: Client

  beforeAll(async () => {
    db = new Client({ connectionString: DB_URL })
    await db.connect()
    await db.query(
      `insert into auth.users (id, phone) values ($1, '15550000051') on conflict (id) do nothing`,
      [OPS_USER],
    )
    const recipient = await db.query(
      `insert into public.recipients (user_id, first_name, last_name, relationship, country)
       values ($1, 'Ana', 'García', 'mother', 'MX') returning id`,
      [OPS_USER],
    )
    const destination = await db.query(
      `insert into public.payout_destinations (recipient_id, method, currency, details)
       values ($1, 'bank_account', 'MXN', '{}') returning id`,
      [recipient.rows[0].id],
    )
    const seed = async (state: string, n: number) => {
      const quote = await db.query(
        `insert into public.quotes (user_id, payout_destination_id, send_amount_minor, send_currency,
           receive_amount_minor, receive_currency, fee_amount_minor, fee_currency,
           fx_rate, source_rate, fx_rate_at, expires_at, status)
         values ($1, $2, 19801, 'USD', 396014, 'MXN', 199, 'USD', 19.9997, 20.1, now(),
           now() + interval '15 minutes', 'consumed') returning id`,
        [OPS_USER, destination.rows[0].id],
      )
      await db.query(
        `insert into public.transfers (user_id, payout_destination_id, quote_id,
           send_amount_minor, send_currency, receive_amount_minor, receive_currency,
           fee_amount_minor, fee_currency, fx_rate, fx_rate_at, idempotency_key, state)
         values ($1, $2, $3, 19801, 'USD', 396014, 'MXN', 199, 'USD', 19.9997, now(), $4, $5)`,
        [OPS_USER, destination.rows[0].id, quote.rows[0].id, `ops-test-${state}-${n}`, state],
      )
    }
    await seed('FUNDED', 1)
    await seed('FUNDED', 2)
    await seed('COMPLETED', 1)
  })

  afterAll(async () => {
    await db.query('delete from public.transfers where user_id = $1', [OPS_USER])
    await db.query('delete from public.quotes where user_id = $1', [OPS_USER])
    await db.query(
      `delete from public.payout_destinations where recipient_id in
         (select id from public.recipients where user_id = $1)`,
      [OPS_USER],
    )
    await db.query('delete from public.recipients where user_id = $1', [OPS_USER])
    await db.query('delete from auth.users where id = $1', [OPS_USER])
    await db.end()
  })

  it('groups all transfers by state through the production rpc path', async () => {
    const { data, error } = await supabaseAdmin.rpc('ops_transfer_state_counts')
    expect(error).toBeNull()
    const rows = data as Array<{ state: string; count: number }>
    const byState = Object.fromEntries(rows.map((r) => [r.state, Number(r.count)]))
    // >= because other suites' rows may coexist; ours guarantee the floor.
    expect(byState['FUNDED']).toBeGreaterThanOrEqual(2)
    expect(byState['COMPLETED']).toBeGreaterThanOrEqual(1)
  })

  it('denies execute to anon and authenticated (service-role only)', async () => {
    for (const role of ['anon', 'authenticated']) {
      const res = await db.query(
        `select has_function_privilege($1, 'public.ops_transfer_state_counts()', 'execute') as ok`,
        [role],
      )
      expect(res.rows[0].ok).toBe(false)
    }
  })
})
