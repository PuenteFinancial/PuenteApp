// Integration tests against a real local Supabase stack (Docker).
// Gated: RUN_DB_TESTS=1. Proves at the DATABASE level the slice-5 PR-1 schema:
// payment_events dedupe, transition_transfer v2 (provider_transfer_ref +
// replay no-op), payout hold/claim columns outside the frozen-terms trigger,
// and the claim-vs-claim guarded UPDATE (exactly one winner).
//
// Transfers are inserted directly with fixed ids in the state each test needs
// (the frozen-terms trigger fires only on UPDATE, so a direct FUNDED insert is
// legal here) — the RPC creation path is already covered by transfers.db.test.ts.
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import { Client } from 'pg'

const runDb = process.env.RUN_DB_TESTS === '1'

const DB_URL = process.env.TEST_DB_URL ?? 'postgresql://postgres:postgres@127.0.0.1:54322/postgres'

// Fixed UUIDs in the …005x block — no collisions with the other db tests
// (…0001, …000a/b, …001a-c, …002a, …003a/b, …004a, …00aa/bb/ee/ff)
const USER = '00000000-0000-4000-8000-00000000005a'
const T_SUBMIT = '00000000-0000-4000-8000-000000000051'
const T_HOLD = '00000000-0000-4000-8000-000000000052'
const T_CLAIM = '00000000-0000-4000-8000-000000000053'

const BRIDGE_REF = 'bridge_xfer_db_test_1'

describe.skipIf(!runDb)('payout schema (integration, local Supabase)', () => {
  let db: Client

  // One quote per transfer (transfers.quote_id is UNIQUE)
  const seedFundedTransfer = async (transferId: string, destinationId: string) => {
    const quote = await db.query(
      `insert into public.quotes (user_id, payout_destination_id, send_amount_minor, send_currency,
         receive_amount_minor, receive_currency, fee_amount_minor, fee_currency,
         fx_rate, source_rate, fx_rate_at, expires_at, status)
       values ($1, $2, 19801, 'USD', 396014, 'MXN', 199, 'USD', 19.9997, 20.100251, now(),
         now() + interval '15 minutes', 'consumed') returning id`,
      [USER, destinationId],
    )
    await db.query(
      `insert into public.transfers (id, user_id, payout_destination_id, quote_id,
         send_amount_minor, send_currency, receive_amount_minor, receive_currency,
         fee_amount_minor, fee_currency, fx_rate, fx_rate_at, idempotency_key, state)
       values ($1, $2, $3, $4, 19801, 'USD', 396014, 'MXN', 199, 'USD', 19.9997, now(), $5, 'FUNDED')`,
      [transferId, USER, destinationId, quote.rows[0].id, `payout-schema-test-${transferId}`],
    )
  }

  beforeAll(async () => {
    db = new Client({ connectionString: DB_URL })
    await db.connect()
    await db.query(
      `insert into auth.users (id, phone) values ($1, '15550000051') on conflict (id) do nothing`,
      [USER],
    )
    const recipient = await db.query(
      `insert into public.recipients (user_id, first_name, last_name, relationship, country)
       values ($1, 'Ana', 'García López', 'mother', 'MX') returning id`,
      [USER],
    )
    const destination = await db.query(
      `insert into public.payout_destinations (recipient_id, method, currency, details)
       values ($1, 'bank_account', 'MXN', '{}') returning id`,
      [recipient.rows[0].id],
    )
    for (const id of [T_SUBMIT, T_HOLD, T_CLAIM]) {
      await seedFundedTransfer(id, destination.rows[0].id)
    }
  })

  afterAll(async () => {
    // TRUNCATE skips row-level triggers — the sanctioned path past the
    // append-only guard on transfer_transitions (files run serialized under
    // RUN_DB_TESTS, so truncating the shared table is safe)
    await db.query('truncate table public.payment_events, public.transfer_transitions')
    await db.query('delete from public.transfers where user_id = $1', [USER])
    await db.query('delete from public.quotes where user_id = $1', [USER])
    await db.query(
      `delete from public.payout_destinations where recipient_id in
       (select id from public.recipients where user_id = $1)`,
      [USER],
    )
    await db.query('delete from public.recipients where user_id = $1', [USER])
    await db.query('delete from auth.users where id = $1', [USER])
    await db.end()
  })

  beforeEach(async () => {
    await db.query('truncate table public.payment_events')
  })

  const insertEvent = (source: string, externalEventId: string) =>
    db.query(
      `insert into public.payment_events (source, external_event_id, event_type, transfer_id, payload)
       values ($1, $2, 'payment_processed', $3, '{"raw": true}'::jsonb)
       on conflict (source, external_event_id) do nothing`,
      [source, externalEventId, T_SUBMIT],
    )

  describe('payment_events', () => {
    it('dedupes on (source, external_event_id): second insert is a no-op', async () => {
      const first = await insertEvent('bridge', 'evt_dedupe_1')
      const replay = await insertEvent('bridge', 'evt_dedupe_1')
      expect(first.rowCount).toBe(1)
      expect(replay.rowCount).toBe(0)

      const count = await db.query('select count(*)::int as n from public.payment_events')
      expect(count.rows[0].n).toBe(1)
    })

    it('scopes the dedupe per source: same external id under bridge_poll still inserts', async () => {
      await insertEvent('bridge', 'evt_scoped_1')
      const poll = await insertEvent('bridge_poll', 'evt_scoped_1')
      expect(poll.rowCount).toBe(1)
    })

    it('rejects a status outside the lifecycle check', async () => {
      await insertEvent('bridge', 'evt_status_1')
      await expect(
        db.query(
          `update public.payment_events set status = 'reticulating' where external_event_id = 'evt_status_1'`,
        ),
      ).rejects.toMatchObject({ code: '23514' })
    })

    it('rejects an unknown source', async () => {
      await expect(insertEvent('carrier_pigeon', 'evt_source_1')).rejects.toMatchObject({
        code: '23514',
      })
    })
  })

  describe('transition_transfer v2 (provider_transfer_ref)', () => {
    const submit = (providerRef: string | null) =>
      db.query(
        `select public.transition_transfer($1, 'FUNDED', 'SUBMITTED', 'worker:payout',
           'payout submitted', '{}'::jsonb, null, null, null, null, null, $2)`,
        [T_SUBMIT, providerRef],
      )

    it('sets provider_transfer_ref on FUNDED→SUBMITTED; replay is a no-op', async () => {
      await submit(BRIDGE_REF)

      const row = await db.query(
        'select state, provider_transfer_ref from public.transfers where id = $1',
        [T_SUBMIT],
      )
      expect(row.rows[0]).toEqual({ state: 'SUBMITTED', provider_transfer_ref: BRIDGE_REF })

      // replay with a null ref: returns the row, appends nothing, and the
      // coalesce keeps the already-recorded ref
      const replay = await submit(null)
      expect(replay.rows).toHaveLength(1)

      const after = await db.query(
        'select state, provider_transfer_ref from public.transfers where id = $1',
        [T_SUBMIT],
      )
      expect(after.rows[0]).toEqual({ state: 'SUBMITTED', provider_transfer_ref: BRIDGE_REF })

      const transitions = await db.query(
        `select count(*)::int as n from public.transfer_transitions
         where transfer_id = $1 and to_state = 'SUBMITTED'`,
        [T_SUBMIT],
      )
      expect(transitions.rows[0].n).toBe(1)
    })
  })

  describe('payout hold/claim lifecycle columns', () => {
    it('updates without tripping the frozen-terms trigger', async () => {
      await db.query(
        `update public.transfers
            set payout_hold_reason = 'fx_drift',
                payout_held_at = now(),
                submit_attempted_at = now()
          where id = $1`,
        [T_HOLD],
      )
      const row = await db.query(
        `select payout_hold_reason, payout_held_at, submit_attempted_at
           from public.transfers where id = $1`,
        [T_HOLD],
      )
      expect(row.rows[0].payout_hold_reason).toBe('fx_drift')
      expect(row.rows[0].payout_held_at).not.toBeNull()
      expect(row.rows[0].submit_attempted_at).not.toBeNull()
    })

    it("rejects 'float_ceiling' — deliberately not a hold reason (self-healing backpressure)", async () => {
      await expect(
        db.query(
          `update public.transfers set payout_hold_reason = 'float_ceiling' where id = $1`,
          [T_HOLD],
        ),
      ).rejects.toMatchObject({ code: '23514' })
    })
  })

  describe('claim-vs-claim concurrency', () => {
    it('exactly one of two concurrent guarded claims wins', async () => {
      const db2 = new Client({ connectionString: DB_URL })
      await db2.connect()
      try {
        // the submit job's atomic claim: the loser sees 0 rows, not an error
        const claim = (client: Client) =>
          client.query(
            `update public.transfers
                set submit_attempted_at = now()
              where id = $1 and state = 'FUNDED'
                and payout_hold_reason is null and submit_attempted_at is null`,
            [T_CLAIM],
          )
        const results = await Promise.all([claim(db), claim(db2)])
        expect(results.map((r) => r.rowCount).sort()).toEqual([0, 1])
      } finally {
        await db2.end()
      }
    })
  })
})
