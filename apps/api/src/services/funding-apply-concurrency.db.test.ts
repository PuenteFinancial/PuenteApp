import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import { Client } from 'pg'
import { randomUUID } from 'node:crypto'

// The concurrent cousin of the two C5 race bugs, against REAL Postgres.
//
// Both ordering bugs (clearing-before-funding on card, processing-overwrites-
// the-ref on ACH) were fixed for the observed orders. This pins the case the
// unit tests can only model: the two appliers running AT THE SAME TIME on the
// same row. Before the fix, applyFundingCleared judged "is the receivable
// open?" from a read taken before its own UPDATE, and applyFundingSucceeded
// checked the flag before its transition — so a FUNDED commit landing between
// those two reads made both sides skip, and the clearing leg was lost with
// nothing left to retry it. The row-lock ordering the fix relies on is a
// property of the database, which is why this is a .db test and not a stub.
//
// Runs the pair N times on N fresh transfers to widen the interleaving window;
// the invariant is per-transfer and absolute: exactly one FUNDED posting,
// exactly one funding_cleared posting, receivable nets to zero.

const runDb = process.env.RUN_DB_TESTS === '1'
const DB_URL =
  process.env.SUPABASE_DB_URL ?? 'postgresql://postgres:postgres@127.0.0.1:54322/postgres'

const SEND_MINOR = 500
const FEE_MINOR = 0
const RECEIVE_MINOR = 9_899
const ROUNDS = 12

// The FUNDED path enqueues the payout after its commit; that is pg-boss, which
// is not what this test is about. Everything else stays real.
const enqueued: string[] = []
vi.mock('./queue.js', () => ({
  enqueuePayoutSubmit: async (transferId: string) => {
    enqueued.push(transferId)
  },
}))

const { applyFundingSucceeded, applyFundingCleared } = await import('./funding-apply.js')

const RUN = Math.floor(Math.random() * 9000) + 1000

describe.skipIf(!runDb)('funding appliers under true concurrency (integration)', () => {
  let db: Client
  let userId: string
  let destinationId: string
  const transferIds: string[] = []

  const seedPending = async (): Promise<string> => {
    const transferId = randomUUID()
    const quote = await db.query(
      `insert into public.quotes (user_id, payout_destination_id, send_amount_minor, send_currency,
         receive_amount_minor, receive_currency, fee_amount_minor, fee_currency,
         fx_rate, source_rate, fx_rate_at, expires_at, status)
       values ($1, $2, ${SEND_MINOR}, 'USD', ${RECEIVE_MINOR}, 'MXN', ${FEE_MINOR}, 'USD',
         19.798, 20.100251, now(), now() + interval '15 minutes', 'consumed') returning id`,
      [userId, destinationId],
    )
    await db.query(
      `insert into public.transfers (id, user_id, payout_destination_id, quote_id,
         send_amount_minor, send_currency, receive_amount_minor, receive_currency,
         fee_amount_minor, fee_currency, fx_rate, fx_rate_at, idempotency_key, state,
         funding_processor, funding_payment_ref)
       values ($1, $2, $3, $4, ${SEND_MINOR}, 'USD', ${RECEIVE_MINOR}, 'MXN', ${FEE_MINOR}, 'USD',
         19.798, now(), $5, 'PENDING_PAYMENT', 'stripe_checkout', $6)`,
      [transferId, userId, destinationId, quote.rows[0].id, `race-${transferId}`, `cs_test_race_${transferId}`],
    )
    transferIds.push(transferId)
    return transferId
  }

  beforeAll(async () => {
    db = new Client({ connectionString: DB_URL })
    await db.connect()
    userId = randomUUID()
    await db.query(`insert into auth.users (id, phone) values ($1, $2) on conflict (id) do nothing`, [
      userId,
      `1555${RUN}901`,
    ])
    await db.query(
      `insert into public.users (id, phone, kyc_status, bridge_customer_id)
       values ($1, $2, 'approved', $3)
       on conflict (id) do update set kyc_status = 'approved', bridge_customer_id = excluded.bridge_customer_id`,
      [userId, `1555${RUN}901`, `bridge_cust_race_${RUN}`],
    )
    const recipient = await db.query(
      `insert into public.recipients (user_id, first_name, last_name, relationship, country)
       values ($1, 'Ana', 'García López', 'mother', 'MX') returning id`,
      [userId],
    )
    const destination = await db.query(
      `insert into public.payout_destinations (recipient_id, method, currency, details, provider_account_ref)
       values ($1, 'bank_account', 'MXN', '{}', $2) returning id`,
      [recipient.rows[0].id, `bridge_ext_race_${RUN}`],
    )
    destinationId = destination.rows[0].id
  })

  afterAll(async () => {
    // Leave the book as found (the cancellations.db leak lesson): the recon
    // suite reads global state and fails loud past its row bound.
    //
    // TRUNCATE, never DELETE, for the ledger: it is append-only by a row-level
    // BEFORE DELETE trigger (ledger_forbid_mutation), so a DELETE raises P0001
    // — which is exactly how this teardown failed its first CI run, after
    // every assertion had already passed. TRUNCATE fires no row triggers. Same
    // pattern as multi-user-load.db.test.ts.
    if (!db) return
    await db.query('truncate table public.ledger_entries, public.ledger_transactions cascade')
    await db.query('truncate table public.transfer_transitions')
    await db.query(`delete from public.transfers where id = any($1)`, [transferIds])
    await db.query(`delete from public.quotes where user_id = $1`, [userId])
    await db.query(`delete from public.payout_destinations where id = $1`, [destinationId])
    await db.query(`delete from public.recipients where user_id = $1`, [userId])
    await db.query(`delete from public.users where id = $1`, [userId])
    await db.query(`delete from auth.users where id = $1`, [userId])
    await db.end()
  })

  it('funded and cleared fired together always leave both ledger legs, never one', async () => {
    for (let round = 0; round < ROUNDS; round++) {
      const transferId = await seedPending()
      // Alternate which applier gets the head start, and in the middle rounds
      // give neither — Promise.all starts both synchronously.
      const funded = () =>
        applyFundingSucceeded({
          transferId,
          paymentRef: `cs_test_race_${transferId}`,
          eventId: `evt_completed_${round}`,
          actor: 'webhook:funding',
        })
      const cleared = () => applyFundingCleared({ transferId })
      if (round % 3 === 0) await Promise.all([cleared(), funded()])
      else if (round % 3 === 1) await Promise.all([funded(), cleared()])
      else {
        const c = cleared()
        await new Promise((r) => setTimeout(r, 1))
        await Promise.all([funded(), c])
      }
    }

    const postings = await db.query(
      `select transfer_id, transition, count(*)::int as n
         from public.ledger_transactions where transfer_id = any($1)
        group by transfer_id, transition`,
      [transferIds],
    )
    const byTransfer = new Map<string, Record<string, number>>()
    for (const r of postings.rows) {
      const m = byTransfer.get(r.transfer_id) ?? {}
      m[r.transition] = r.n
      byTransfer.set(r.transfer_id, m)
    }
    for (const id of transferIds) {
      expect(byTransfer.get(id), id).toEqual({ FUNDED: 1, funding_cleared: 1 })
    }

    // And the receivable is closed on every one: debits equal credits.
    const receivable = await db.query(
      `select lt.transfer_id,
              sum(case when le.direction = 'debit' then le.amount_minor else 0 end)::int as dr,
              sum(case when le.direction = 'credit' then le.amount_minor else 0 end)::int as cr
         from public.ledger_entries le
         join public.ledger_transactions lt on lt.id = le.ledger_transaction_id
         join public.ledger_accounts la on la.id = le.account_id
        where lt.transfer_id = any($1) and la.code = 'funding_receivable'
        group by lt.transfer_id`,
      [transferIds],
    )
    expect(receivable.rows).toHaveLength(transferIds.length)
    for (const r of receivable.rows) {
      expect({ id: r.transfer_id, dr: r.dr, cr: r.cr }).toEqual({ id: r.transfer_id, dr: SEND_MINOR, cr: SEND_MINOR })
    }

    const rows = await db.query(
      `select count(*)::int as n from public.transfers where id = any($1) and state = 'FUNDED' and funding_cleared`,
      [transferIds],
    )
    expect(rows.rows[0].n).toBe(transferIds.length)
    expect(enqueued).toHaveLength(ROUNDS)
  })
})
