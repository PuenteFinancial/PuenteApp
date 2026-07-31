// Integration tests against a real local Supabase stack (Docker).
// Gated: RUN_DB_TESTS=1. Pins the AUTHORITATIVE per-user risk queries that the
// unit tests can only mock — proving, end-to-end through PostgREST: for the
// transaction limits, the per-transaction cap, the rolling day/month/6-month
// send-amount tiers, the per-day count, user-scoping, the committed
// (disclosure-accepted) filter, the window lower bound (the `.gte` the unit
// test can't exercise), unwound-state exclusion, and excludeTransferId; for the
// uncleared-exposure cap (slice-8 O3), the funding_cleared filter, the ABSENCE
// of any window bound, and the older-wins tuple ordering against real
// PostgREST timestamp formats (`+00:00` row values vs `Z`-form inputs). Seeds
// transfers by raw SQL (the enforce_transfers_terms_frozen trigger is BEFORE
// UPDATE only, so any initial state — and any send amount — is insertable).
import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest'
import { Client } from 'pg'
import { assessTransferRisk, assessUnclearedCap, hasClearedHistory } from './risk.js'
import { env } from '../config/env.js'

const runDb = process.env.RUN_DB_TESTS === '1'
const DB_URL = process.env.TEST_DB_URL ?? 'postgresql://postgres:postgres@127.0.0.1:54322/postgres'

const USER = '00000000-0000-4000-8000-0000000000a1'
const OTHER_USER = '00000000-0000-4000-8000-0000000000a2'

const PER_TXN = env.RISK_PER_TXN_MAX_MINOR
const DAILY = env.RISK_DAILY_MAX_MINOR
const MONTHLY = env.RISK_MONTHLY_MAX_MINOR
const SEMIANNUAL = env.RISK_SEMIANNUAL_MAX_MINOR
const MAX_COUNT = env.RISK_VELOCITY_MAX_COUNT

const HOUR = 60 * 60 * 1000
const DAY = 24 * HOUR
// Commit timestamps at safe offsets — never near a window boundary (no flake).
const iso = (msAgo: number) => new Date(Date.now() - msAgo).toISOString()
const RECENT = iso(1 * HOUR) // today (in every window)
const WEEKS = iso(10 * DAY) // in the month + 6-month windows, not today
const MONTHS = iso(60 * DAY) // in the 6-month window only
const OUTSIDE = iso(200 * DAY) // outside every window
// Uncleared-cap ordering fixtures: two distinct commit instants plus one
// shared instant for the exact-tie case.
const T_OLD = iso(3 * HOUR)
const T_NEW = iso(2 * HOUR)
const TIE = iso(4 * HOUR)

describe.skipIf(!runDb)('risk service (integration, local Supabase)', () => {
  let db: Client
  let destId: string
  let otherDestId: string
  let seq = 0

  const seedDestination = async (userId: string, phone: string): Promise<string> => {
    await db.query(
      `insert into auth.users (id, phone) values ($1, $2) on conflict (id) do nothing`,
      [userId, phone],
    )
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

  // Seed one transfer (with its single-use quote) at an arbitrary state, commit
  // time, and send amount (the send may exceed the per-transaction cap — that cap
  // gates only the new send; the DB has no upper bound). Returns the transfer id.
  const seedTransfer = async (opts: {
    state: string
    committedAt: string | null // disclosure_accepted_at
    sendMinor: number
    userId?: string
    destinationId?: string
    fundingCleared?: boolean
  }): Promise<string> => {
    const userId = opts.userId ?? USER
    const destinationId = opts.destinationId ?? destId
    seq += 1
    const quote = await db.query(
      `insert into public.quotes (user_id, payout_destination_id, send_amount_minor, send_currency,
         receive_amount_minor, receive_currency, fee_amount_minor, fee_currency,
         fx_rate, source_rate, fx_rate_at, expires_at, status)
       values ($1, $2, $3, 'USD', 396014, 'MXN', 0, 'USD', 19.9997, 20.100251, now(),
         now() + interval '15 minutes', 'consumed') returning id`,
      [userId, destinationId, opts.sendMinor],
    )
    const transfer = await db.query(
      `insert into public.transfers (user_id, payout_destination_id, quote_id,
         send_amount_minor, send_currency, receive_amount_minor, receive_currency,
         fee_amount_minor, fee_currency, fx_rate, fx_rate_at, idempotency_key, state,
         disclosure_accepted_at, funding_cleared)
       values ($1, $2, $3, $4, 'USD', 396014, 'MXN', 0, 'USD', 19.9997, now(), $5, $6, $7, $8)
       returning id`,
      [userId, destinationId, quote.rows[0].id, opts.sendMinor, `risk-db-${seq}`, opts.state, opts.committedAt, opts.fundingCleared ?? false],
    )
    return transfer.rows[0].id as string
  }

  beforeAll(async () => {
    db = new Client({ connectionString: DB_URL })
    await db.connect()
    destId = await seedDestination(USER, '15550000091')
    otherDestId = await seedDestination(OTHER_USER, '15550000092')
  })

  afterEach(async () => {
    await db.query('delete from public.transfers where user_id = any($1)', [[USER, OTHER_USER]])
    await db.query('delete from public.quotes where user_id = any($1)', [[USER, OTHER_USER]])
  })

  afterAll(async () => {
    await db.query(
      `delete from public.payout_destinations where recipient_id in
       (select id from public.recipients where user_id = any($1))`,
      [[USER, OTHER_USER]],
    )
    await db.query('delete from public.recipients where user_id = any($1)', [[USER, OTHER_USER]])
    await db.query('delete from auth.users where id = any($1)', [[USER, OTHER_USER]])
    await db.end()
  })

  it('blocks per_transaction over the single-send cap', async () => {
    await expect(
      assessTransferRisk({ userId: USER, sendAmountMinor: PER_TXN + 1 }),
    ).resolves.toEqual({ ok: false, reason: 'per_transaction' })
  })

  it('passes when under every cap', async () => {
    await seedTransfer({ state: 'FUNDED', committedAt: RECENT, sendMinor: 20_000 })
    await expect(assessTransferRisk({ userId: USER, sendAmountMinor: 10_000 })).resolves.toEqual({
      ok: true,
    })
  })

  it('blocks daily at the rolling-24h send total (== cap ok, +1 over)', async () => {
    await seedTransfer({ state: 'FUNDED', committedAt: RECENT, sendMinor: DAILY - 10_000 })
    await expect(assessTransferRisk({ userId: USER, sendAmountMinor: 10_000 })).resolves.toEqual({
      ok: true,
    })
    await expect(assessTransferRisk({ userId: USER, sendAmountMinor: 10_001 })).resolves.toEqual({
      ok: false,
      reason: 'daily',
    })
  })

  it('blocks monthly on sends within 30d but not today', async () => {
    // Two sends 10 days ago totalling MONTHLY - 10_000; today's total stays $0.
    await seedTransfer({ state: 'FUNDED', committedAt: WEEKS, sendMinor: (MONTHLY - 10_000) / 2 })
    await seedTransfer({ state: 'COMPLETED', committedAt: WEEKS, sendMinor: (MONTHLY - 10_000) / 2 })
    await expect(assessTransferRisk({ userId: USER, sendAmountMinor: 10_001 })).resolves.toEqual({
      ok: false,
      reason: 'monthly',
    })
  })

  it('blocks semiannual on sends within 180d but not this month', async () => {
    await seedTransfer({ state: 'FUNDED', committedAt: MONTHS, sendMinor: SEMIANNUAL - 10_000 })
    await expect(assessTransferRisk({ userId: USER, sendAmountMinor: 10_001 })).resolves.toEqual({
      ok: false,
      reason: 'semiannual',
    })
  })

  it('blocks velocity_count at the per-day send count cap', async () => {
    for (let i = 0; i < MAX_COUNT; i += 1) {
      await seedTransfer({ state: 'FUNDED', committedAt: RECENT, sendMinor: 100 })
    }
    await expect(assessTransferRisk({ userId: USER, sendAmountMinor: 100 })).resolves.toEqual({
      ok: false,
      reason: 'velocity_count',
    })
  })

  it('ignores out-of-window, uncommitted, unwound, and other users’ sends', async () => {
    // Each noise send is sized at the daily cap, so if ANY single one leaked into
    // the tally the daily check would trip — asserting ok proves every one is
    // excluded. (The out-of-window one is even larger, to trip the 6-month cap.)
    await seedTransfer({ state: 'FUNDED', committedAt: OUTSIDE, sendMinor: SEMIANNUAL + 100_000 }) // outside window
    await seedTransfer({ state: 'PENDING_PAYMENT', committedAt: null, sendMinor: DAILY }) // uncommitted
    await seedTransfer({ state: 'CANCELED', committedAt: RECENT, sendMinor: DAILY }) // unwound
    await seedTransfer({ state: 'REFUNDED', committedAt: RECENT, sendMinor: DAILY }) // unwound
    await seedTransfer({ state: 'PAYMENT_FAILED', committedAt: RECENT, sendMinor: DAILY }) // unwound
    await seedTransfer({ state: 'FUNDING_REVERSED', committedAt: RECENT, sendMinor: DAILY }) // unwound
    await seedTransfer({
      state: 'FUNDED',
      committedAt: RECENT,
      sendMinor: DAILY,
      userId: OTHER_USER,
      destinationId: otherDestId,
    }) // other user
    await expect(assessTransferRisk({ userId: USER, sendAmountMinor: 10_000 })).resolves.toEqual({
      ok: true,
    })
  })

  it('excludeTransferId omits the send under consideration (the submit backstop)', async () => {
    const self = await seedTransfer({ state: 'FUNDED', committedAt: RECENT, sendMinor: DAILY })
    // Counting self, a $1 send tips the daily total over; excluding it, we're clear.
    await expect(assessTransferRisk({ userId: USER, sendAmountMinor: 1 })).resolves.toEqual({
      ok: false,
      reason: 'daily',
    })
    await expect(
      assessTransferRisk({ userId: USER, sendAmountMinor: 1, excludeTransferId: self }),
    ).resolves.toEqual({ ok: true })
  })

  it('counts still-live committed states: accepted-but-unfunded and PAYOUT_FAILED', async () => {
    // Accepted-but-not-yet-funded (the burst threat model) and PAYOUT_FAILED
    // (charged, not yet refunded) both count; if either were excluded the daily
    // total would fall under the cap.
    await seedTransfer({ state: 'PENDING_PAYMENT', committedAt: RECENT, sendMinor: DAILY / 2 })
    await seedTransfer({ state: 'PAYOUT_FAILED', committedAt: RECENT, sendMinor: DAILY / 2 })
    await expect(assessTransferRisk({ userId: USER, sendAmountMinor: 10_000 })).resolves.toEqual({
      ok: false,
      reason: 'daily',
    })
  })

  describe('assessUnclearedCap (slice-8 O3)', () => {
    it('blocks on an uncleared committed send regardless of age — NO window bound', async () => {
      // OUTSIDE (200d ago) is beyond every velocity window; the cap must still
      // see it — "until cleared" has no horizon.
      const blocker = await seedTransfer({ state: 'COMPLETED', committedAt: OUTSIDE, sendMinor: 100 })
      await expect(assessUnclearedCap({ userId: USER })).resolves.toEqual({
        ok: false,
        blockerTransferId: blocker,
      })
    })

    it('a cleared send frees the slot', async () => {
      await seedTransfer({
        state: 'COMPLETED',
        committedAt: RECENT,
        sendMinor: 100,
        fundingCleared: true,
      })
      await expect(assessUnclearedCap({ userId: USER })).resolves.toEqual({ ok: true })
    })

    it('ignores uncommitted, unwound, and other users’ sends; excludeTransferId omits self', async () => {
      await seedTransfer({ state: 'PENDING_PAYMENT', committedAt: null, sendMinor: 100 }) // uncommitted
      await seedTransfer({ state: 'CANCELED', committedAt: RECENT, sendMinor: 100 }) // unwound
      await seedTransfer({ state: 'PAYMENT_FAILED', committedAt: RECENT, sendMinor: 100 }) // unwound
      await seedTransfer({
        state: 'FUNDED',
        committedAt: RECENT,
        sendMinor: 100,
        userId: OTHER_USER,
        destinationId: otherDestId,
      }) // other user
      await expect(assessUnclearedCap({ userId: USER })).resolves.toEqual({ ok: true })

      const self = await seedTransfer({ state: 'FUNDED', committedAt: RECENT, sendMinor: 100 })
      await expect(assessUnclearedCap({ userId: USER })).resolves.toMatchObject({ ok: false })
      await expect(
        assessUnclearedCap({ userId: USER, excludeTransferId: self }),
      ).resolves.toEqual({ ok: true })
    })

    it('olderThan counts only strictly-older rows — through real PostgREST timestamps', async () => {
      // The stored row comes back from PostgREST in `+00:00` form while the
      // worker passes the Z-form it read at load; both must land on the same
      // millisecond for the order to be consistent across racers.
      const older = await seedTransfer({ state: 'FUNDED', committedAt: T_OLD, sendMinor: 100 })
      const newer = await seedTransfer({ state: 'FUNDED', committedAt: T_NEW, sendMinor: 100 })
      // the newer racer sees the older → waits
      await expect(
        assessUnclearedCap({
          userId: USER,
          excludeTransferId: newer,
          olderThan: { acceptedAt: T_NEW, transferId: newer },
        }),
      ).resolves.toEqual({ ok: false, blockerTransferId: older })
      // the older racer sees nothing older → submits
      await expect(
        assessUnclearedCap({
          userId: USER,
          excludeTransferId: older,
          olderThan: { acceptedAt: T_OLD, transferId: older },
        }),
      ).resolves.toEqual({ ok: true })
    })

    it('breaks an exact same-timestamp tie by id — exactly one winner', async () => {
      const a = await seedTransfer({ state: 'FUNDED', committedAt: TIE, sendMinor: 100 })
      const b = await seedTransfer({ state: 'FUNDED', committedAt: TIE, sendMinor: 100 })
      const [lo, hi] = a < b ? [a, b] : [b, a]
      // the higher id yields to the lower…
      await expect(
        assessUnclearedCap({
          userId: USER,
          excludeTransferId: hi,
          olderThan: { acceptedAt: TIE, transferId: hi },
        }),
      ).resolves.toEqual({ ok: false, blockerTransferId: lo })
      // …and the lower id proceeds
      await expect(
        assessUnclearedCap({
          userId: USER,
          excludeTransferId: lo,
          olderThan: { acceptedAt: TIE, transferId: lo },
        }),
      ).resolves.toEqual({ ok: true })
    })
  })

  describe('hasClearedHistory (slice-8 O3)', () => {
    it('false with no cleared sends, true once one clears', async () => {
      await seedTransfer({ state: 'COMPLETED', committedAt: RECENT, sendMinor: 100 })
      await expect(hasClearedHistory(USER)).resolves.toBe(false)
      await seedTransfer({
        state: 'COMPLETED',
        committedAt: RECENT,
        sendMinor: 100,
        fundingCleared: true,
      })
      await expect(hasClearedHistory(USER)).resolves.toBe(true)
    })

    it('a clawed-back clearing (FUNDING_REVERSED) is not proof', async () => {
      await seedTransfer({
        state: 'FUNDING_REVERSED',
        committedAt: RECENT,
        sendMinor: 100,
        fundingCleared: true,
      })
      await expect(hasClearedHistory(USER)).resolves.toBe(false)
    })

    it('is scoped to the user', async () => {
      await seedTransfer({
        state: 'COMPLETED',
        committedAt: RECENT,
        sendMinor: 100,
        fundingCleared: true,
        userId: OTHER_USER,
        destinationId: otherDestId,
      })
      await expect(hasClearedHistory(USER)).resolves.toBe(false)
    })
  })
})
