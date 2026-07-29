// Integration test against a real local Supabase stack (Docker).
// Gated: RUN_DB_TESTS=1. Pins the three truths the mocked correction-watch
// suite cannot establish: the migration's seeded loss_cancellation_correction
// account really satisfies the job's `.single()` lookup; the rolling window
// filters real rows the way the DB does; and the signed sum matches an
// independently-written SQL aggregate over the same window.
//
// Leftover-tolerant by design (fresh uuids, NO cleanup — the append-only
// ledger forbids deletes and `supabase db reset` is the janitor): assertions
// compare the job's reported total against a direct SQL sum over the SAME
// window rather than pinning absolute values, and separately prove our
// in-window seeds are counted while the out-of-window seed is not.
import crypto from 'node:crypto'
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import { Client } from 'pg'
import { postLedgerTransaction } from '../services/ledger.js'
import { watchLossCorrections } from './correction-watch.js'
import { env } from '../config/env.js'

const captureMessage = vi.hoisted(() => vi.fn())
const setFingerprint = vi.hoisted(() => vi.fn())
const setContext = vi.hoisted(() => vi.fn())
vi.mock('@sentry/node', () => ({
  withScope: (fn: (s: unknown) => void) => fn({ setFingerprint, setContext }),
  captureMessage: (...a: unknown[]) => captureMessage(...a),
}))

const runDb = process.env.RUN_DB_TESTS === '1'

const DB_URL = process.env.TEST_DB_URL ?? 'postgresql://postgres:postgres@127.0.0.1:54322/postgres'

describe.skipIf(!runDb)('correction-watch (integration, local Supabase)', () => {
  let db: Client

  beforeAll(async () => {
    db = new Client({ connectionString: DB_URL })
    await db.connect()
  })

  afterAll(async () => {
    await db.end()
  })

  it('counts in-window signed corrections, excludes out-of-window rows, and matches the SQL sum', async () => {
    // In-window, through the PRODUCTION write path: a $200 correction and a
    // $50 reversal-shaped credit (the append-only ledger's undo).
    await postLedgerTransaction({
      idempotencyKey: `corr-watch-test-${crypto.randomUUID()}`,
      description: 'correction-watch db test — in-window correction',
      entries: [
        { accountCode: 'loss_cancellation_correction', direction: 'debit', money: { amountMinor: 20_000, currency: 'USD' } },
        { accountCode: 'cash_clearing', direction: 'credit', money: { amountMinor: 20_000, currency: 'USD' } },
      ],
    })
    await postLedgerTransaction({
      idempotencyKey: `corr-watch-test-${crypto.randomUUID()}`,
      description: 'correction-watch db test — in-window reversal credit',
      entries: [
        { accountCode: 'cash_clearing', direction: 'debit', money: { amountMinor: 5_000, currency: 'USD' } },
        { accountCode: 'loss_cancellation_correction', direction: 'credit', money: { amountMinor: 5_000, currency: 'USD' } },
      ],
    })

    // Out-of-window, raw SQL with an explicit old created_at (the append-only
    // triggers block UPDATE/DELETE, not INSERT). One BEGIN/COMMIT: the
    // net-zero and min-entries constraints are DEFERRED to commit, so the
    // transaction row and its balanced entries must land together.
    const oldDays = env.LOSS_CORRECTION_WINDOW_DAYS + 1
    await db.query('begin')
    try {
      const tx = await db.query(
        `insert into public.ledger_transactions (idempotency_key, description)
         values ($1, 'correction-watch db test — out-of-window') returning id`,
        [`corr-watch-test-old-${crypto.randomUUID()}`],
      )
      await db.query(
        `insert into public.ledger_entries (ledger_transaction_id, account_id, direction, amount_minor, currency, created_at)
         select $1, a.id, v.direction, v.amount_minor, 'USD', now() - ($2 || ' days')::interval
           from (values ('debit', 7777, 'loss_cancellation_correction'),
                        ('credit', 7777, 'cash_clearing')) as v(direction, amount_minor, code)
           join public.ledger_accounts a on a.code = v.code`,
        [tx.rows[0].id, String(oldDays)],
      )
      await db.query('commit')
    } catch (err) {
      await db.query('rollback')
      throw err
    }

    captureMessage.mockReset()
    setContext.mockReset()

    const count = await watchLossCorrections()

    // The independently-written aggregate over the SAME window — the job's
    // number must agree with the database's.
    const sql = await db.query(
      `select coalesce(sum(case when e.direction = 'debit' then e.amount_minor else -e.amount_minor end), 0)::bigint as total,
              count(*)::int as n
         from public.ledger_entries e
         join public.ledger_accounts a on a.id = e.account_id
        where a.code = 'loss_cancellation_correction'
          and e.created_at >= now() - ($1 || ' days')::interval`,
      [String(env.LOSS_CORRECTION_WINDOW_DAYS)],
    )
    const expectedTotal = Number(sql.rows[0].total)
    expect(count).toBe(sql.rows[0].n)

    // Our seeds: +20000 − 5000 in-window (leftovers from prior runs may add
    // more — the window sum floor proves ours counted), and the out-of-window
    // 7777 debit must NOT be in the DB sum the job agreed with.
    expect(expectedTotal).toBeGreaterThanOrEqual(15_000)

    // ≥ $200 in-window → the alert fired, with the job's total matching SQL's.
    expect(captureMessage).toHaveBeenCalledWith(
      'Reg E correction losses at/above aggregate threshold',
      'warning',
    )
    const context = setContext.mock.calls.at(-1)![1] as { totalMinor: number; correctionCount: number }
    expect(context.totalMinor).toBe(expectedTotal)
    expect(context.correctionCount).toBe(sql.rows[0].n)
  })

  it('the out-of-window seed is really older than the cutoff (the exclusion is not vacuous)', async () => {
    const res = await db.query(
      `select count(*)::int as n
         from public.ledger_entries e
         join public.ledger_accounts a on a.id = e.account_id
        where a.code = 'loss_cancellation_correction'
          and e.created_at < now() - ($1 || ' days')::interval`,
      [String(env.LOSS_CORRECTION_WINDOW_DAYS)],
    )
    expect(res.rows[0].n).toBeGreaterThanOrEqual(1)
  })
})
