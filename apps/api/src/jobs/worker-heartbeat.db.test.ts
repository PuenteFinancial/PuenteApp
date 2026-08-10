// Integration test for the worker_heartbeat DDL against a real local Supabase
// stack. Gated like every *.db.test.ts: RUN_DB_TESTS=1 + local env — see
// docs/runbooks/local-dev.md.
//
// This is the only place the migration's trigger is actually exercised, and the
// whole liveness design rests on it: `updated_at` must be written by the
// DATABASE on every beat, and must NOT be forgeable by the process being
// monitored. A worker with a skewed clock that could stamp its own beat would
// report itself alive while dead — the one direction this signal must never
// fail in. "We wrote a trigger" and "the trigger fires" are different claims;
// these tests assert the second.
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import { Client } from 'pg'

const runDb = process.env.RUN_DB_TESTS === '1'

const DB_URL = process.env.TEST_DB_URL ?? 'postgresql://postgres:postgres@127.0.0.1:54322/postgres'

const TEST_WORKER = 'db-test-worker'

describe.skipIf(!runDb)('worker_heartbeat (integration, local Supabase)', () => {
  let db: Client

  beforeAll(async () => {
    db = new Client({ connectionString: DB_URL })
    await db.connect()
  })

  beforeEach(async () => {
    await db.query('delete from public.worker_heartbeat where worker = $1', [TEST_WORKER])
  })

  afterAll(async () => {
    await db.query('delete from public.worker_heartbeat where worker = $1', [TEST_WORKER])
    await db.end()
  })

  it('advances updated_at when the upsert rewrites a non-key column with the SAME value', async () => {
    // The exact shape the job produces: `instance` is written on every beat and
    // is usually unchanged (same deploy). Postgres fires BEFORE UPDATE triggers
    // even when no value differs — if that ever stopped being true, every beat
    // after the first would silently stop advancing and the worker would look
    // dead while healthy. This test is the guard on that assumption.
    await db.query(
      `insert into public.worker_heartbeat (worker, instance) values ($1, 'abc1234')`,
      [TEST_WORKER],
    )
    const before = await db.query(
      'select created_at, updated_at from public.worker_heartbeat where worker = $1',
      [TEST_WORKER],
    )
    expect(before.rows[0].created_at.getTime()).toBe(before.rows[0].updated_at.getTime())

    await db.query('select pg_sleep(0.05)')
    await db.query(`update public.worker_heartbeat set instance = 'abc1234' where worker = $1`, [
      TEST_WORKER,
    ])

    const after = await db.query(
      'select created_at, updated_at from public.worker_heartbeat where worker = $1',
      [TEST_WORKER],
    )
    expect(after.rows[0].updated_at.getTime()).toBeGreaterThan(
      after.rows[0].created_at.getTime(),
    )
  })

  it('overwrites a supplied updated_at — the worker cannot forge its own beat', async () => {
    await db.query(
      `insert into public.worker_heartbeat (worker, instance) values ($1, 'abc1234')`,
      [TEST_WORKER],
    )
    await db.query(
      `update public.worker_heartbeat set instance = 'abc1234', updated_at = '2099-01-01T00:00:00Z'
       where worker = $1`,
      [TEST_WORKER],
    )
    const res = await db.query(
      'select updated_at from public.worker_heartbeat where worker = $1',
      [TEST_WORKER],
    )
    // moddatetime replaces the supplied value with now(); a future-dated beat
    // would otherwise keep a dead worker looking alive indefinitely.
    expect(res.rows[0].updated_at.getFullYear()).toBeLessThan(2030)
  })

  it('has RLS enabled with a deny-all policy (no client access at all)', async () => {
    const rls = await db.query(
      `select relrowsecurity from pg_class where relname = 'worker_heartbeat'`,
    )
    expect(rls.rows[0].relrowsecurity).toBe(true)

    const policies = await db.query(
      `select polname, pg_get_expr(polqual, polrelid) as using_expr
       from pg_policy where polrelid = 'public.worker_heartbeat'::regclass`,
    )
    expect(policies.rows).toHaveLength(1)
    expect(policies.rows[0].using_expr).toBe('false')
  })

  it('is upsert-in-place — deliberately NOT append-only like reconciliation_runs', async () => {
    // reconciliation_runs carries ledger_forbid_mutation + a revoke of
    // update/delete because it is an audit record. This table is the current
    // state of the world and must stay mutable; inheriting that posture by
    // copy-paste would break every beat after the first.
    const triggers = await db.query(
      `select tgname from pg_trigger
       where tgrelid = 'public.worker_heartbeat'::regclass and not tgisinternal`,
    )
    const names = triggers.rows.map((r) => r.tgname as string)
    expect(names).toContain('handle_worker_heartbeat_updated_at')
    expect(names).not.toContain('worker_heartbeat_append_only')
  })
})
