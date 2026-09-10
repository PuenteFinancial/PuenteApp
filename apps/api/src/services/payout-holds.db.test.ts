// Integration tests against a real local Supabase stack (Docker).
// Gated: RUN_DB_TESTS=1. Proves releaseDestinationPayabilityHolds at the
// DATABASE level — the guarantees the mocked-chain unit tests cannot reach.
//
// Those unit tests pin the ARGUMENTS the service passes. They cannot tell you
// that PostgREST accepts `update().eq().eq().eq().in().select()`, that the
// filter actually narrows, or that the ops_actions row survives that table's
// CHECK constraints and its append-only trigger. A wrong filter chain here
// fails SILENTLY — it returns no rows, the hold stays, and every mocked test
// still passes. Hence this suite.
//
// What it establishes, all from ONE release pass over a deliberately mixed
// fixture set:
//   - the FUNDED payability hold on a destination this pass registered is
//     cleared, and the row's other columns are untouched
//   - a payability hold on a destination NOT in the pass survives (the
//     narrowing that keeps the other three payability causes held)
//   - a hold on the SAME destination under a different reason survives (the
//     compare-and-swap guard)
//   - another sender's payability hold survives even when their destination id
//     is passed in (the defence-in-depth user_id filter)
//   - a non-FUNDED row survives (the state guard)
//   - an unheld row is not touched and gets no provenance row
//   - exactly one ops_actions row lands, with the real CHECK constraints
//     applied to actor / action / reason and jsonb-object before/after
//   - a second pass releases nothing (the CAS from the other side)
//
// Fixture idiom follows cancellations.db.test.ts: FRESH uuids per run and no
// cleanup beyond closing the connection. ops_actions is append-only and holds
// an FK to transfers, so nothing here deletes; leftovers under random ids are
// inert and `supabase db reset` is the janitor.
import crypto from 'node:crypto'
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import { Client } from 'pg'

const runDb = process.env.RUN_DB_TESTS === '1'

const DB_URL = process.env.TEST_DB_URL ?? 'postgresql://postgres:postgres@127.0.0.1:54322/postgres'

// pg-boss is latency-only on this path (the 1-min sweep resubmits anyway) and
// has its own db test. Everything else is real.
const enqueuePayoutSubmit = vi.hoisted(() => vi.fn())
vi.mock('./queue.js', () => ({
  enqueuePayoutSubmit: (...args: unknown[]) => enqueuePayoutSubmit(...args),
}))

const { releaseDestinationPayabilityHolds } = await import('./payout-holds.js')

const SENDER_A = crypto.randomUUID()
const SENDER_B = crypto.randomUUID()
const REQUEST_ID = `req-db-${crypto.randomUUID().slice(0, 8)}`

const S = 19801
const FEE = 199

const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() }

describe.skipIf(!runDb)('releaseDestinationPayabilityHolds (integration, local Supabase)', () => {
  let db: Client
  // Two destinations under sender A, one under sender B.
  let destA1: string
  let destA2: string
  let destB1: string

  // The ids the pass "registered": A1 plus, deliberately, a destination that
  // is NOT sender A's. A caller cannot widen the blast radius by passing a
  // foreign id — that is what the user_id filter is for.
  let transfers: {
    target: string
    otherDest: string
    otherReason: string
    unheld: string
    foreign: string
    notFunded: string
  }
  let released: string[]

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
    return destination.rows[0].id as string
  }

  // Inserted directly at its state rather than walked: this service reads and
  // writes only the two hold columns, and the state machine has its own suites.
  const seedTransfer = async (opts: {
    userId: string
    destinationId: string
    holdReason?: string | null
    state?: string
  }): Promise<string> => {
    const transferId = crypto.randomUUID()
    const quote = await db.query(
      `insert into public.quotes (user_id, payout_destination_id, send_amount_minor, send_currency,
         receive_amount_minor, receive_currency, fee_amount_minor, fee_currency,
         fx_rate, source_rate, fx_rate_at, expires_at, status)
       values ($1, $2, ${S}, 'USD', 396014, 'MXN', ${FEE}, 'USD', 19.9997, 20.100251, now(),
         now() + interval '15 minutes', 'consumed') returning id`,
      [opts.userId, opts.destinationId],
    )
    await db.query(
      `insert into public.transfers (id, user_id, payout_destination_id, quote_id,
         send_amount_minor, send_currency, receive_amount_minor, receive_currency,
         fee_amount_minor, fee_currency, fx_rate, fx_rate_at, idempotency_key, state,
         funding_payment_ref, payment_at, payout_hold_reason, payout_held_at)
       values ($1, $2, $3, $4, ${S}, 'USD', 396014, 'MXN', ${FEE}, 'USD', 19.9997, now(), $5,
         $6, $7, now(), $8, $9)`,
      [
        transferId,
        opts.userId,
        opts.destinationId,
        quote.rows[0].id,
        `holds-db-test-${transferId}`,
        opts.state ?? 'FUNDED',
        `mockpay_${transferId}`,
        opts.holdReason ?? null,
        opts.holdReason ? new Date().toISOString() : null,
      ],
    )
    return transferId
  }

  const holdOf = async (transferId: string) =>
    (
      await db.query(
        'select state, payout_hold_reason, payout_held_at from public.transfers where id = $1',
        [transferId],
      )
    ).rows[0]

  const opsActionsFor = async (transferId: string) =>
    (
      await db.query(
        `select actor, action, reason, note, before, after, request_id
         from public.ops_actions where transfer_id = $1 order by created_at`,
        [transferId],
      )
    ).rows

  beforeAll(async () => {
    db = new Client({ connectionString: DB_URL })
    await db.connect()
    // auth.users(phone) is unique and this run's rows are never deleted.
    for (const id of [SENDER_A, SENDER_B]) {
      await db.query(`insert into auth.users (id, phone) values ($1, $2)`, [
        id,
        `1555${crypto.randomInt(1_000_000, 9_999_999)}`,
      ])
    }

    destA1 = await seedDestination(SENDER_A)
    destA2 = await seedDestination(SENDER_A)
    destB1 = await seedDestination(SENDER_B)

    transfers = {
      // The one and only row this pass should clear.
      target: await seedTransfer({ userId: SENDER_A, destinationId: destA1, holdReason: 'payability' }),
      // Same sender, same reason, a destination the pass did NOT register:
      // its payability could be destination_not_active, which is unpayable.
      otherDest: await seedTransfer({ userId: SENDER_A, destinationId: destA2, holdReason: 'payability' }),
      // Same destination, re-held for something a registration does not fix.
      otherReason: await seedTransfer({ userId: SENDER_A, destinationId: destA1, holdReason: 'velocity_review' }),
      // Same destination, never held.
      unheld: await seedTransfer({ userId: SENDER_A, destinationId: destA1, holdReason: null }),
      // Another sender entirely, whose destination id is passed in below.
      foreign: await seedTransfer({ userId: SENDER_B, destinationId: destB1, holdReason: 'payability' }),
      // Already past FUNDED — releasing it would be meaningless.
      notFunded: await seedTransfer({
        userId: SENDER_A,
        destinationId: destA1,
        holdReason: 'payability',
        state: 'SUBMITTED',
      }),
    }

    enqueuePayoutSubmit.mockResolvedValue('job-1')
    released = await releaseDestinationPayabilityHolds(
      {
        userId: SENDER_A,
        destinationIds: [destA1, destB1],
        actor: 'webhook:bridge',
        requestId: REQUEST_ID,
      },
      log,
    )
  })

  afterAll(async () => {
    await db?.end()
  })

  it('releases exactly the FUNDED payability hold on a destination this pass registered', async () => {
    expect(released).toEqual([transfers.target])

    const row = await holdOf(transfers.target)
    expect(row.payout_hold_reason).toBeNull()
    expect(row.payout_held_at).toBeNull()
    // A release clears the hold and nothing else.
    expect(row.state).toBe('FUNDED')
  })

  it('leaves a payability hold on a destination the pass did NOT register', async () => {
    // The whole point of threading registeredIds through: this hold could be
    // destination_not_active, and releasing it would push an unpayable
    // transfer at Bridge.
    const row = await holdOf(transfers.otherDest)
    expect(row.payout_hold_reason).toBe('payability')
    expect(row.payout_held_at).not.toBeNull()
  })

  it('leaves a row on the same destination that was re-held for another reason', async () => {
    const row = await holdOf(transfers.otherReason)
    expect(row.payout_hold_reason).toBe('velocity_review')
  })

  it("leaves another sender's hold alone even when their destination id is passed in", async () => {
    const row = await holdOf(transfers.foreign)
    expect(row.payout_hold_reason).toBe('payability')
  })

  it('leaves a non-FUNDED row held', async () => {
    const row = await holdOf(transfers.notFunded)
    expect(row.state).toBe('SUBMITTED')
    expect(row.payout_hold_reason).toBe('payability')
  })

  it('does not touch an unheld row, and writes it no provenance', async () => {
    const row = await holdOf(transfers.unheld)
    expect(row.payout_hold_reason).toBeNull()
    expect(await opsActionsFor(transfers.unheld)).toEqual([])
  })

  it('writes one ops_actions row that satisfies the table CHECK constraints', async () => {
    // The unit test asserts the object handed to recordOpsAction. This asserts
    // Postgres accepted it: the action enum, the actor and reason length
    // bounds, jsonb_typeof(before/after) = 'object', and the append-only
    // trigger letting the INSERT through.
    const rows = await opsActionsFor(transfers.target)
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({
      actor: 'webhook:bridge',
      action: 'hold_release',
      reason: 'payability',
      note: null,
      request_id: REQUEST_ID,
    })
    expect(rows[0].before).toEqual({ payoutHoldReason: 'payability', providerAccountRef: 'missing' })
    expect(rows[0].after).toEqual({ payoutHoldReason: null, providerAccountRef: 'registered' })
  })

  it('re-enqueues the submit for the released transfer only', () => {
    expect(enqueuePayoutSubmit).toHaveBeenCalledTimes(1)
    expect(enqueuePayoutSubmit).toHaveBeenCalledWith(transfers.target, 'api')
  })

  it('is a no-op on a second pass — the CAS finds nothing left to release', async () => {
    enqueuePayoutSubmit.mockClear()

    const again = await releaseDestinationPayabilityHolds(
      { userId: SENDER_A, destinationIds: [destA1, destB1], actor: 'webhook:bridge', requestId: REQUEST_ID },
      log,
    )

    expect(again).toEqual([])
    expect(enqueuePayoutSubmit).not.toHaveBeenCalled()
    // No second provenance row for a release that did not happen.
    expect(await opsActionsFor(transfers.target)).toHaveLength(1)
  })
})
