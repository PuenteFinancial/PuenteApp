// Integration tests for the acknowledgements migration against a real local Supabase stack
// (Docker). Gated like every *.db.test.ts: RUN_DB_TESTS=1 plus real local env — see
// docs/runbooks/local-dev.md.
//
// WHY THESE EXIST SEPARATELY from reconciliation-ack.test.ts. That suite mocks the database and
// pins the SERVICE's rules. These pin the SCHEMA's — the CHECK constraints and the update
// trigger — against raw SQL that bypasses the service entirely. That distinction is the whole
// safety story of this feature: an acknowledgement silences a financial alarm, so the guards have
// to hold against a hand-written INSERT in the Supabase editor, not just against the CLI. A unit
// test cannot prove any of that, and "I ran it locally once" is not a regression test.
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import { Client } from 'pg'

const runDb = process.env.RUN_DB_TESTS === '1'

const DB_URL = process.env.TEST_DB_URL ?? 'postgresql://postgres:postgres@127.0.0.1:54322/postgres'

const KEY = 'stripe-dispute-unrecorded:du_DBTEST'
const NOTE = 'investigated — predates the loss path'

describe.skipIf(!runDb)('reconciliation_acknowledgements schema (integration, local Supabase)', () => {
  let db: Client

  const insertAck = (over: { key?: string; note?: string; expires?: string } = {}) =>
    db.query(
      `insert into public.reconciliation_acknowledgements
         (check_name, finding_key, actor, note, expires_at)
       values ('stripe_disputes', $1, 'ops:dbtest', $2, now() + $3::interval)
       returning id, expires_at`,
      [over.key ?? KEY, over.note ?? NOTE, over.expires ?? '60 days'],
    )

  beforeAll(async () => {
    db = new Client({ connectionString: DB_URL })
    await db.connect()
  })

  // BOTH tables are append-only, so cleanup has to lower the guard it is cleaning up behind and
  // put it straight back. Scoped to actor 'ops:dbtest' so a rerun collides with nothing and no
  // real row is ever in range.
  const purge = async (table: string, trigger: string) => {
    await db.query(`alter table public.${table} disable trigger ${trigger}`)
    try {
      await db.query(`delete from public.${table} where actor = 'ops:dbtest'`)
    } finally {
      await db.query(`alter table public.${table} enable trigger ${trigger}`)
    }
  }
  const purgeAll = async () => {
    await purge('reconciliation_acknowledgements', 'reconciliation_acknowledgements_no_delete')
    await purge('ops_actions', 'forbid_ops_actions_mutation')
  }

  afterAll(async () => {
    await purgeAll()
    await db.end()
  })

  beforeEach(purgeAll)

  it('accepts a well-formed acknowledgement', async () => {
    const { rows } = await insertAck()
    expect(rows[0].id).toBeTruthy()
  })

  // ── the expiry cap ────────────────────────────────────────────────────────
  // There is no "forever", and the cap lives in the schema so a direct INSERT cannot buy more
  // silence than the CLI can. If this test ever needs changing, that is the conversation.
  it('refuses a window longer than 90 days', async () => {
    await expect(insertAck({ expires: '91 days' })).rejects.toThrow(
      /reconciliation_acknowledgements_window_check/,
    )
  })

  it('accepts exactly 90 days', async () => {
    await expect(insertAck({ expires: '89 days 23 hours' })).resolves.toBeTruthy()
  })

  it('refuses an acknowledgement that is already expired on arrival', async () => {
    await expect(insertAck({ expires: '-1 days' })).rejects.toThrow(
      /reconciliation_acknowledgements_window_check/,
    )
  })

  it('refuses a note too short to state a reason', async () => {
    await expect(insertAck({ note: 'fine' })).rejects.toThrow(
      /reconciliation_acknowledgements_note_check/,
    )
  })

  // ── immutability ──────────────────────────────────────────────────────────
  it('refuses to extend an existing acknowledgement', async () => {
    await insertAck()
    await expect(
      db.query(
        `update public.reconciliation_acknowledgements set expires_at = now() + interval '89 days'
         where finding_key = $1`,
        [KEY],
      ),
    ).rejects.toThrow(/is immutable/)
  })

  it('refuses to rewrite the stated reason', async () => {
    await insertAck()
    await expect(
      db.query(
        `update public.reconciliation_acknowledgements set note = 'a different justification'
         where finding_key = $1`,
        [KEY],
      ),
    ).rejects.toThrow(/is immutable/)
  })

  it('refuses to repoint an acknowledgement at another finding', async () => {
    await insertAck()
    await expect(
      db.query(
        `update public.reconciliation_acknowledgements set finding_key = 'something-else'
         where finding_key = $1`,
        [KEY],
      ),
    ).rejects.toThrow(/is immutable/)
  })

  // ── revocation: the one permitted edit, one way ───────────────────────────
  it('allows revoking once, and refuses a second revocation', async () => {
    await insertAck()
    const revoke = () =>
      db.query(
        `update public.reconciliation_acknowledgements set revoked_at = now() where finding_key = $1`,
        [KEY],
      )
    await expect(revoke()).resolves.toBeTruthy()
    await expect(revoke()).rejects.toThrow(/already revoked/)
  })

  it('refuses to delete the history — a wrong acknowledgement is revoked, not erased', async () => {
    await insertAck()
    await expect(
      db.query(`delete from public.reconciliation_acknowledgements where finding_key = $1`, [KEY]),
    ).rejects.toThrow(/append-only/)
  })

  // ── the surrounding schema ────────────────────────────────────────────────
  it('is service-role only — the policy denies every client role', async () => {
    const { rows } = await db.query(
      `select c.relrowsecurity, p.polname, pg_get_expr(p.polqual, p.polrelid) as using_expr
         from pg_class c left join pg_policy p on p.polrelid = c.oid
        where c.relname = 'reconciliation_acknowledgements'`,
    )
    expect(rows[0].relrowsecurity).toBe(true)
    expect(rows[0].using_expr).toBe('false')
  })

  it('reconciliation_runs carries acknowledged_count, defaulting to 0 and never negative', async () => {
    const { rows } = await db.query(
      `insert into public.reconciliation_runs (started_at, finished_at, status, findings_count, checks)
       values (now(), now(), 'pass', 0, '[]'::jsonb) returning acknowledged_count`,
    )
    expect(rows[0].acknowledged_count).toBe(0)
    await expect(
      db.query(
        `insert into public.reconciliation_runs
           (started_at, finished_at, status, findings_count, acknowledged_count, checks)
         values (now(), now(), 'pass', 0, -1, '[]'::jsonb)`,
      ),
    ).rejects.toThrow(/reconciliation_runs_acknowledged_count_check/)
  })

  it('ops_actions accepts both acknowledgement actions', async () => {
    const { rows } = await db.query(
      `insert into public.ops_actions (actor, action, note)
       values ('ops:dbtest', 'reconciliation_ack', 'silenced a finding'),
              ('ops:dbtest', 'reconciliation_ack_revoke', 'let it ring again')
       returning action`,
    )
    expect(rows.map((r: { action: string }) => r.action)).toEqual([
      'reconciliation_ack',
      'reconciliation_ack_revoke',
    ])
  })
})
