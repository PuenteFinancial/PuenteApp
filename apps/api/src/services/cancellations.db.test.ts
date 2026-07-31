// Integration tests against a real local Supabase stack (Docker).
// Gated: RUN_DB_TESTS=1. Proves the slice-7 PR6b cancellation-request record at
// the DATABASE level — the guarantees no mocked test can establish:
//
//   - record_cancellation_request writes the request AND stamps
//     transfers.cancellation_requested_at in one call, and computes
//     within_window atomically from the row's own cancelable_until (both sides
//     of the boundary, plus the null → in-window legal posture)
//   - a second call returns the SAME row: the statutory clock starts at the
//     FIRST ask and can never be restarted by a double tap / fresh key
//   - the partial unique index itself rejects a second pending row (raw
//     INSERT, not via the RPC — the index is the enforcement, the RPC's
//     pre-check only makes the conflict a normal return)
//   - a RESOLVED request does not block a new one, and the transfer's
//     first-ask stamp survives the second request
//   - moddatetime moves updated_at on resolve
//   - the RPC is service-role-only (privilege matrix + a live 42501)
//   - RLS: the owner reads their own requests via the transfers join; another
//     authenticated user sees nothing; writes are service-role-only
//
// Fixture idiom: FRESH uuids per run and NO cleanup beyond closing the
// connection. The ledger and transition tables are append-only (row triggers
// reject deletes), and a crashed run must not poison the next one — leftovers
// under random ids are inert, and `supabase db reset` is the janitor. Seeds
// mirror refund-tail.db.test.ts; quotes are single-use, one per transfer.
import crypto from 'node:crypto'
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { Client } from 'pg'
import {
  recordCancellationRequest,
  pendingCancellationFor,
  resolveCancellationRequest,
} from './cancellations.js'

const runDb = process.env.RUN_DB_TESTS === '1'

const DB_URL = process.env.TEST_DB_URL ?? 'postgresql://postgres:postgres@127.0.0.1:54322/postgres'

const USER = crypto.randomUUID()
const OTHER_USER = crypto.randomUUID()

const S = 19801
const FEE = 199

const RPC_SIGNATURE = 'public.record_cancellation_request(uuid, uuid, text)'

describe.skipIf(!runDb)('cancellation_requests (integration, local Supabase)', () => {
  let db: Client
  let destinationId: string

  // A transfer parked at a post-submission state with the Reg E window under
  // the test's control. Inserted directly (not walked): the record RPC keys on
  // existence + ownership + cancelable_until, and the walk is exercised by the
  // review-side db suite. minutes=null leaves cancelable_until NULL.
  const seedTransfer = async (opts: {
    state?: 'FUNDED' | 'SUBMITTED' | 'IN_FLIGHT'
    cancelableMinutes?: number | null
    userId?: string
  } = {}): Promise<string> => {
    const transferId = crypto.randomUUID()
    const userId = opts.userId ?? USER
    const minutes = opts.cancelableMinutes === undefined ? 30 : opts.cancelableMinutes
    const quote = await db.query(
      `insert into public.quotes (user_id, payout_destination_id, send_amount_minor, send_currency,
         receive_amount_minor, receive_currency, fee_amount_minor, fee_currency,
         fx_rate, source_rate, fx_rate_at, expires_at, status)
       values ($1, $2, ${S}, 'USD', 396014, 'MXN', ${FEE}, 'USD', 19.9997, 20.100251, now(),
         now() + interval '15 minutes', 'consumed') returning id`,
      [userId, destinationId],
    )
    await db.query(
      `insert into public.transfers (id, user_id, payout_destination_id, quote_id,
         send_amount_minor, send_currency, receive_amount_minor, receive_currency,
         fee_amount_minor, fee_currency, fx_rate, fx_rate_at, idempotency_key, state,
         funding_payment_ref, payment_at, cancelable_until)
       values ($1, $2, $3, $4, ${S}, 'USD', 396014, 'MXN', ${FEE}, 'USD', 19.9997, now(), $5,
         $6, $7, now(), $8)`,
      [
        transferId,
        userId,
        destinationId,
        quote.rows[0].id,
        `cancel-db-test-${transferId}`,
        opts.state ?? 'SUBMITTED',
        `mockpay_${transferId}`,
        minutes === null ? null : new Date(Date.now() + minutes * 60_000).toISOString(),
      ],
    )
    return transferId
  }

  beforeAll(async () => {
    db = new Client({ connectionString: DB_URL })
    await db.connect()
    // Fresh phone digits per run — auth.users(phone) is unique and this run's
    // rows are never deleted.
    for (const [id, phone] of [
      [USER, `1555${crypto.randomInt(1_000_000, 9_999_999)}`],
      [OTHER_USER, `1555${crypto.randomInt(1_000_000, 9_999_999)}`],
    ]) {
      await db.query(
        `insert into auth.users (id, phone) values ($1, $2) on conflict (id) do nothing`,
        [id, phone],
      )
    }
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
    destinationId = destination.rows[0].id
  })

  afterAll(async () => {
    await db.end()
  })

  const requestsFor = async (transferId: string) =>
    (
      await db.query(
        `select id, status, requested_at, requested_state, within_window
           from public.cancellation_requests where transfer_id = $1 order by created_at`,
        [transferId],
      )
    ).rows

  const stampOf = async (transferId: string): Promise<string | null> => {
    const res = await db.query(
      'select cancellation_requested_at from public.transfers where id = $1',
      [transferId],
    )
    return res.rows[0].cancellation_requested_at
  }

  it('records the request AND stamps the transfer in one call, timeliness frozen at record time', async () => {
    const transferId = await seedTransfer({ state: 'SUBMITTED', cancelableMinutes: 30 })

    const request = await recordCancellationRequest({
      transferId,
      userId: USER,
      state: 'SUBMITTED',
    })

    expect(request).toMatchObject({
      transfer_id: transferId,
      user_id: USER,
      requested_state: 'SUBMITTED',
      within_window: true,
      status: 'pending',
    })

    const rows = await requestsFor(transferId)
    expect(rows).toHaveLength(1)
    // The two writes the RPC exists to keep from drifting: a stamped transfer
    // with no request (or the reverse) is unexplainable to an auditor.
    const stamp = await stampOf(transferId)
    expect(stamp).not.toBeNull()
    expect(new Date(stamp!).toISOString()).toBe(new Date(request.requested_at).toISOString())
  })

  it('a second ask returns the SAME row — the statutory clock never restarts', async () => {
    const transferId = await seedTransfer({ state: 'IN_FLIGHT' })

    const first = await recordCancellationRequest({ transferId, userId: USER, state: 'IN_FLIGHT' })
    // A second tap arrives with a FRESH idempotency key, so the 24h replay
    // cache does not dedupe it — this return is the only thing that does.
    const second = await recordCancellationRequest({ transferId, userId: USER, state: 'IN_FLIGHT' })

    expect(second.id).toBe(first.id)
    expect(second.requested_at).toBe(first.requested_at)
    expect(await requestsFor(transferId)).toHaveLength(1)
  })

  it('the partial unique index itself rejects a second pending row', async () => {
    const transferId = await seedTransfer({ state: 'SUBMITTED' })
    await recordCancellationRequest({ transferId, userId: USER, state: 'SUBMITTED' })

    // Raw INSERT past the RPC's pre-check: the INDEX is the enforcement — two
    // concurrent recorders that both miss the pre-check must still collapse to
    // one open clock.
    await expect(
      db.query(
        `insert into public.cancellation_requests
           (transfer_id, user_id, requested_state, within_window)
         values ($1, $2, 'SUBMITTED', true)`,
        [transferId, USER],
      ),
    ).rejects.toMatchObject({ code: '23505' })
  })

  it('computes within_window on both sides of cancelable_until', async () => {
    const inWindow = await seedTransfer({ state: 'SUBMITTED', cancelableMinutes: 30 })
    const expired = await seedTransfer({ state: 'SUBMITTED', cancelableMinutes: -1 })

    const timely = await recordCancellationRequest({ transferId: inWindow, userId: USER, state: 'SUBMITTED' })
    const late = await recordCancellationRequest({ transferId: expired, userId: USER, state: 'SUBMITTED' })

    expect(timely.within_window).toBe(true)
    // Recorded, not refused: the 202 fires on state alone, and the frozen
    // false is what stops the delivery tail manufacturing a refund obligation.
    expect(late.within_window).toBe(false)
  })

  it('treats a NULL cancelable_until as in-window — we never deny a right we failed to bound', async () => {
    const transferId = await seedTransfer({ state: 'FUNDED', cancelableMinutes: null })

    const request = await recordCancellationRequest({ transferId, userId: USER, state: 'FUNDED' })

    expect(request.within_window).toBe(true)
  })

  it('a resolved request does not block a new one, and the FIRST ask keeps the transfer stamp', async () => {
    const transferId = await seedTransfer({ state: 'SUBMITTED' })

    const first = await recordCancellationRequest({ transferId, userId: USER, state: 'SUBMITTED' })
    expect(
      await resolveCancellationRequest({
        transferId,
        status: 'resolved_denied',
        resolution: 'denied — test fixture',
        resolvedBy: 'ops:db-test',
      }),
    ).toBe(true)

    const second = await recordCancellationRequest({ transferId, userId: USER, state: 'SUBMITTED' })
    expect(second.id).not.toBe(first.id)
    expect(second.status).toBe('pending')

    const rows = await requestsFor(transferId)
    expect(rows).toHaveLength(2)
    expect(rows.map((r) => r.status).sort()).toEqual(['pending', 'resolved_denied'])

    // coalesce in the RPC: the column answers "when did they FIRST ask" for
    // the read path; per-ask truth lives in cancellation_requests.
    const stamp = await stampOf(transferId)
    expect(new Date(stamp!).toISOString()).toBe(new Date(first.requested_at).toISOString())

    // and the pending lookup returns the OPEN one, not the resolved one
    const pending = await pendingCancellationFor(transferId)
    expect(pending?.id).toBe(second.id)
  })

  it('moddatetime moves updated_at when the request resolves', async () => {
    const transferId = await seedTransfer({ state: 'SUBMITTED' })
    const request = await recordCancellationRequest({ transferId, userId: USER, state: 'SUBMITTED' })

    const before = await db.query(
      'select created_at, updated_at from public.cancellation_requests where id = $1',
      [request.id],
    )
    expect(before.rows[0].updated_at).toEqual(before.rows[0].created_at)

    await resolveCancellationRequest({
      transferId,
      status: 'resolved_refunded',
      resolution: 'refunded — test fixture',
      resolvedBy: 'ops:db-test',
    })

    const after = await db.query(
      'select created_at, updated_at from public.cancellation_requests where id = $1',
      [request.id],
    )
    expect(new Date(after.rows[0].updated_at).getTime()).toBeGreaterThan(
      new Date(after.rows[0].created_at).getTime(),
    )
  })

  it('grants execute on the RPC to service_role only (slice-1 lesson)', async () => {
    const matrix = await db.query(
      `select has_function_privilege('service_role', '${RPC_SIGNATURE}', 'execute') as service_role,
              has_function_privilege('authenticated', '${RPC_SIGNATURE}', 'execute') as authenticated,
              has_function_privilege('anon', '${RPC_SIGNATURE}', 'execute') as anon`,
    )
    expect(matrix.rows[0]).toEqual({ service_role: true, authenticated: false, anon: false })
  })

  it('denies the RPC to a live authenticated session (42501), even for the owner', async () => {
    const transferId = await seedTransfer({ state: 'SUBMITTED' })
    await db.query('begin')
    try {
      await db.query('set local role authenticated')
      await db.query(`select set_config('request.jwt.claims', $1, true)`, [
        JSON.stringify({ sub: USER, role: 'authenticated' }),
      ])
      // Owner-scoping inside the function is NOT the auth boundary — the record
      // path runs as the service role and a client must not reach it directly.
      await expect(
        db.query(`select public.record_cancellation_request($1, $2, 'SUBMITTED')`, [
          transferId,
          USER,
        ]),
      ).rejects.toMatchObject({ code: '42501' })
    } finally {
      await db.query('rollback')
    }
  })

  it('RLS: the owner reads their own request via the transfers join; another user sees nothing', async () => {
    const transferId = await seedTransfer({ state: 'SUBMITTED' })
    const request = await recordCancellationRequest({ transferId, userId: USER, state: 'SUBMITTED' })

    const selectAs = async (sub: string) => {
      await db.query('begin')
      try {
        await db.query('set local role authenticated')
        await db.query(`select set_config('request.jwt.claims', $1, true)`, [
          JSON.stringify({ sub, role: 'authenticated' }),
        ])
        const res = await db.query(
          'select id from public.cancellation_requests where transfer_id = $1',
          [transferId],
        )
        return res.rows
      } finally {
        await db.query('rollback')
      }
    }

    expect((await selectAs(USER)).map((r) => r.id)).toEqual([request.id])
    // Not the owner of the joined transfer → the row does not exist for them.
    expect(await selectAs(OTHER_USER)).toEqual([])
  })

  it('RLS: an authenticated owner cannot write their own request rows', async () => {
    const transferId = await seedTransfer({ state: 'SUBMITTED' })
    const request = await recordCancellationRequest({ transferId, userId: USER, state: 'SUBMITTED' })

    await db.query('begin')
    try {
      await db.query('set local role authenticated')
      await db.query(`select set_config('request.jwt.claims', $1, true)`, [
        JSON.stringify({ sub: USER, role: 'authenticated' }),
      ])
      // No insert/update/delete policies exist, so RLS filters every write to
      // zero rows (or rejects outright) — resolution is the service's alone. A
      // sender must not be able to close their own statutory clock, forge
      // within_window, or open a second one.
      const forged = await db.query(
        `insert into public.cancellation_requests (transfer_id, user_id, requested_state, within_window)
         values ($1, $2, 'SUBMITTED', true)
         on conflict do nothing returning id`,
        [transferId, USER],
      ).catch((e: { code?: string }) => ({ rows: [], code: e.code }))
      expect(forged.rows).toHaveLength(0)

      const closed = await db.query(
        `update public.cancellation_requests set status = 'resolved_denied' where id = $1 returning id`,
        [request.id],
      ).catch((e: { code?: string }) => ({ rows: [], code: e.code }))
      expect(closed.rows).toHaveLength(0)
    } finally {
      await db.query('rollback')
    }
    // The row is untouched.
    expect((await requestsFor(transferId))[0].status).toBe('pending')
  })
})
