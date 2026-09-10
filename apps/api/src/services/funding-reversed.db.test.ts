import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import { Client } from 'pg'
import { randomUUID } from 'node:crypto'

// The loss path against REAL Postgres.
//
// The staging drive (2026-09-10) proved the PRE-delivery arm end to end: a
// dispute on a FUNDED transfer held the payout, froze the sender, and booked
// nothing. It could not reach the POST-delivery arm — the one that recognizes
// the loss — because Stripe raises the test dispute seconds after the charge
// while our payout sweep takes up to a minute, so the dispute always wins the
// race. That arm is the one with a ledger batch on it, and it had never run
// against a database.
//
// What only a real database can answer here:
//   - does the transfers CHECK constraint accept COMPLETED -> FUNDING_REVERSED?
//   - do `loss_funding_reversed` and the credited assets exist as accounts?
//   - does the append-only ledger take the batch, and does it net to zero?
//   - does the payout_hold_reason CHECK accept `funding_disputed`? (a migration
//     shipped in the same PR as the code that writes it)
//   - does the ops_actions CHECK accept `sender_freeze`? (likewise)
//
// Every one of those is a constraint, not a code path, so a stubbed test
// cannot see them. Three of the five were shipped by migrations in the same
// change as their writer, which is exactly when this goes wrong.

const runDb = process.env.RUN_DB_TESTS === '1'
const DB_URL =
  process.env.SUPABASE_DB_URL ?? 'postgresql://postgres:postgres@127.0.0.1:54322/postgres'

const SEND_MINOR = 500
const FEE_MINOR = 0
const RECEIVE_MINOR = 9_899
const TOTAL_MINOR = SEND_MINOR + FEE_MINOR

// The FUNDED path enqueues a payout after its commit; that is pg-boss, and not
// what this is about. Everything else stays real.
vi.mock('./queue.js', () => ({ enqueuePayoutSubmit: async () => undefined }))

const { applyFundingSucceeded, applyFundingCleared, applyFundingReversed } = await import(
  './funding-apply.js'
)

const RUN = Math.floor(Math.random() * 9000) + 1000

describe.skipIf(!runDb)('the FUNDING_REVERSED loss path (integration)', () => {
  let db: Client
  let userId: string
  let destinationId: string
  let recipientId: string
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
      [transferId, userId, destinationId, quote.rows[0].id, `rev-${transferId}`, `cs_test_rev_${transferId}`],
    )
    transferIds.push(transferId)
    return transferId
  }

  /** Fund it, optionally clear it, and put it where the dispute will find it. */
  const seedAt = async (state: string, cleared: boolean): Promise<string> => {
    const transferId = await seedPending()
    await applyFundingSucceeded({
      transferId,
      paymentRef: `cs_test_rev_${transferId}`,
      eventId: `evt_funded_${transferId}`,
      actor: 'webhook:funding',
    })
    if (cleared) await applyFundingCleared({ transferId })
    if (state !== 'FUNDED') {
      await db.query(`update public.transfers set state = $2 where id = $1`, [transferId, state])
    }
    // Each case is its own sender-freeze, so reset the flag between cases.
    await db.query(`update public.users set status = 'active' where id = $1`, [userId])
    return transferId
  }

  const reverse = (transferId: string) =>
    applyFundingReversed({
      transferId,
      paymentRef: `pi_test_rev_${transferId}`,
      eventId: `evt_dispute_${transferId}`,
      actor: 'system:funding_webhook',
      reason: 'fraudulent',
    })

  const entriesFor = async (transferId: string, transition: string) => {
    const rows = await db.query(
      `select la.code, le.direction, le.amount_minor
         from public.ledger_entries le
         join public.ledger_transactions lt on lt.id = le.ledger_transaction_id
         join public.ledger_accounts la on la.id = le.account_id
        where lt.transfer_id = $1 and lt.transition = $2
        order by la.code`,
      [transferId, transition],
    )
    return rows.rows.map((r) => ({ code: r.code, direction: r.direction, amount: Number(r.amount_minor) }))
  }

  beforeAll(async () => {
    db = new Client({ connectionString: DB_URL })
    await db.connect()
    userId = randomUUID()
    await db.query(`insert into auth.users (id, phone) values ($1, $2) on conflict (id) do nothing`, [
      userId,
      `1555${RUN}902`,
    ])
    await db.query(
      `insert into public.users (id, phone, kyc_status, status, bridge_customer_id)
       values ($1, $2, 'approved', 'active', $3)
       on conflict (id) do update set kyc_status = 'approved', status = 'active'`,
      [userId, `1555${RUN}902`, `bridge_cust_rev_${RUN}`],
    )
    const recipient = await db.query(
      `insert into public.recipients (user_id, first_name, last_name, relationship, country)
       values ($1, 'Ana', 'García López', 'mother', 'MX') returning id`,
      [userId],
    )
    recipientId = recipient.rows[0].id
    const destination = await db.query(
      `insert into public.payout_destinations (recipient_id, method, currency, details, provider_account_ref)
       values ($1, 'bank_account', 'MXN', '{}', $2) returning id`,
      [recipientId, `bridge_ext_rev_${RUN}`],
    )
    destinationId = destination.rows[0].id
  })

  afterAll(async () => {
    // TRUNCATE, never DELETE, for the ledger: it is append-only by a row-level
    // BEFORE DELETE trigger (ledger_forbid_mutation), so a DELETE raises P0001.
    // Leave the book as found — the recon suite reads global state.
    if (!db) return
    await db.query('truncate table public.ledger_entries, public.ledger_transactions cascade')
    await db.query('truncate table public.transfer_transitions')
    // ops_actions is append-only too, by the same kind of row-level BEFORE
    // DELETE trigger as the ledger — a DELETE here raises "append-only: DELETE
    // on ops_actions is not allowed", which is how this teardown failed its
    // first run after all six assertions had already passed. TRUNCATE fires no
    // row triggers.
    await db.query('truncate table public.ops_actions')
    await db.query(`delete from public.transfers where id = any($1)`, [transferIds])
    await db.query(`delete from public.quotes where user_id = $1`, [userId])
    await db.query(`delete from public.payout_destinations where id = $1`, [destinationId])
    await db.query(`delete from public.recipients where id = $1`, [recipientId])
    await db.query(`delete from public.users where id = $1`, [userId])
    await db.query(`delete from auth.users where id = $1`, [userId])
    await db.end()
  })

  it('delivered and cleared: the loss lands against CASH, and the books balance', async () => {
    const transferId = await seedAt('COMPLETED', true)

    const out = await reverse(transferId)

    expect(out).toMatchObject({ outcome: 'reversed', cleared: true })
    const state = await db.query(`select state from public.transfers where id = $1`, [transferId])
    // The transfers CHECK constraint accepts the state a migration declared in July.
    expect(state.rows[0].state).toBe('FUNDING_REVERSED')

    expect(await entriesFor(transferId, 'FUNDING_REVERSED')).toEqual([
      { code: 'cash_clearing', direction: 'credit', amount: TOTAL_MINOR },
      { code: 'loss_funding_reversed', direction: 'debit', amount: TOTAL_MINOR },
    ])
  })

  it('delivered but never cleared: the loss lands against the RECEIVABLE instead', async () => {
    // Crediting cash here would claim a withdrawal from money we never held.
    const transferId = await seedAt('COMPLETED', false)

    const out = await reverse(transferId)

    expect(out).toMatchObject({ outcome: 'reversed', cleared: false })
    expect(await entriesFor(transferId, 'FUNDING_REVERSED')).toEqual([
      { code: 'funding_receivable', direction: 'credit', amount: TOTAL_MINOR },
      { code: 'loss_funding_reversed', direction: 'debit', amount: TOTAL_MINOR },
    ])
  })

  it('a late clearing after a reversal never credits the receivable twice', async () => {
    // The security-reviewer finding, against the real ledger: the void arm
    // already wrote the receivable off, so the clearing must skip.
    const transferId = await seedAt('COMPLETED', false)
    await reverse(transferId)

    const out = await applyFundingCleared({ transferId })

    expect(out).toEqual({ outcome: 'skipped', state: 'FUNDING_REVERSED' })
    expect(await entriesFor(transferId, 'funding_cleared')).toEqual([])
    // funding_receivable: opened once by FUNDED, closed once by the reversal.
    const net = await db.query(
      `select sum(case when le.direction = 'debit' then le.amount_minor else -le.amount_minor end)::int as net
         from public.ledger_entries le
         join public.ledger_transactions lt on lt.id = le.ledger_transaction_id
         join public.ledger_accounts la on la.id = le.account_id
        where lt.transfer_id = $1 and la.code = 'funding_receivable'`,
      [transferId],
    )
    expect(Number(net.rows[0].net)).toBe(0)
  })

  it('not yet delivered: the payout is held, the sender frozen, and NOTHING is booked', async () => {
    const transferId = await seedAt('FUNDED', true)

    const out = await reverse(transferId)

    expect(out).toMatchObject({ outcome: 'held', held: true })
    const row = await db.query(
      `select state, payout_hold_reason from public.transfers where id = $1`,
      [transferId],
    )
    expect(row.rows[0].state).toBe('FUNDED')
    // The payout_hold_reason CHECK accepts the value its migration added.
    expect(row.rows[0].payout_hold_reason).toBe('funding_disputed')
    // Nothing is lost while the pesos are still ours.
    expect(await entriesFor(transferId, 'FUNDING_REVERSED')).toEqual([])
  })

  it('the freeze and its audit row both land, and the CHECK accepts the new action', async () => {
    const transferId = await seedAt('COMPLETED', true)

    await reverse(transferId)

    const user = await db.query(`select status from public.users where id = $1`, [userId])
    expect(user.rows[0].status).toBe('suspended')

    const audit = await db.query(
      `select action, actor, reason from public.ops_actions where transfer_id = $1`,
      [transferId],
    )
    expect(audit.rows).toHaveLength(1)
    expect(audit.rows[0]).toMatchObject({
      action: 'sender_freeze',
      actor: 'system:funding_webhook',
      reason: 'fraudulent',
    })
  })

  it('a redelivered dispute changes nothing at all', async () => {
    const transferId = await seedAt('COMPLETED', true)
    await reverse(transferId)

    const again = await reverse(transferId)

    expect(again).toEqual({ outcome: 'replayed' })
    // Exactly one loss posting, not two — the transition guard plus the
    // ledger's (transfer_id, transition) uniqueness.
    const n = await db.query(
      `select count(*)::int as n from public.ledger_transactions
        where transfer_id = $1 and transition = 'FUNDING_REVERSED'`,
      [transferId],
    )
    expect(Number(n.rows[0].n)).toBe(1)
  })
})
