// Integration tests against a real local Supabase stack (Docker).
// Gated: RUN_DB_TESTS=1. Proves the slice-6 PR-1 cancel path at the DATABASE
// level: the cancel_transfer RPC's guard (FUNDED + submit_attempted_at IS NULL +
// Reg E window), its serialization against the submit claim (the HEADLINE race —
// exactly one guarded UPDATE wins, so a CANCELED row can never coexist with a
// set submit_attempted_at / provider_transfer_ref), the clean FUNDED-batch
// reversal that nets the ledger to zero, and replay idempotency.
//
// All raw SQL (like transfers.db.test.ts) on a superuser connection: the race is
// a Postgres row-locking property, tested deterministically at the statement
// level with two connections. The production wrapper (cancelTransfer via
// PostgREST) and its error mapping are covered in services/transfers.test.ts.
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { Client } from 'pg'

const runDb = process.env.RUN_DB_TESTS === '1'

const DB_URL = process.env.TEST_DB_URL ?? 'postgresql://postgres:postgres@127.0.0.1:54322/postgres'

// Fixed UUID in the …007x block — no collision with the other db tests' users
const USER = '00000000-0000-4000-8000-00000000007a'

const S = 19801 // quoted send principal
const FEE = 199
const TOTAL = S + FEE // 20000

const FUNDED_ENTRIES = JSON.stringify([
  { account_code: 'funding_receivable', direction: 'debit', amount_minor: TOTAL, currency: 'USD' },
  { account_code: 'transfer_payable', direction: 'credit', amount_minor: S, currency: 'USD' },
  { account_code: 'fee_revenue', direction: 'credit', amount_minor: FEE, currency: 'USD' },
])

// The exact reversal services/transfers.ts canceledLedgerEntries() builds.
const CANCELED_ENTRIES = JSON.stringify([
  { account_code: 'transfer_payable', direction: 'debit', amount_minor: S, currency: 'USD' },
  { account_code: 'fee_revenue', direction: 'debit', amount_minor: FEE, currency: 'USD' },
  { account_code: 'funding_receivable', direction: 'credit', amount_minor: TOTAL, currency: 'USD' },
])

describe.skipIf(!runDb)('cancel_transfer (integration, local Supabase)', () => {
  let db: Client
  let destinationId: string

  const seedQuote = async (): Promise<string> => {
    const quote = await db.query(
      `insert into public.quotes (user_id, payout_destination_id, send_amount_minor, send_currency,
         receive_amount_minor, receive_currency, fee_amount_minor, fee_currency,
         fx_rate, source_rate, fx_rate_at, expires_at, status)
       values ($1, $2, ${S}, 'USD', 396014, 'MXN', ${FEE}, 'USD', 19.9997, 20.100251, now(),
         now() + interval '15 minutes', 'active') returning id`,
      [USER, destinationId],
    )
    return quote.rows[0].id
  }

  const createTransfer = async (quoteId: string): Promise<string> => {
    const created = await db.query(
      `select public.create_transfer_from_quote($1, $2, $3, 'es', $4::jsonb) as result`,
      [quoteId, USER, `cancel-test-${quoteId}`, JSON.stringify({ version: 1 })],
    )
    return (created.rows[0].result as { transfer: { id: string } }).transfer.id
  }

  // Fresh PENDING_PAYMENT transfer (quote_id is single-use, so a fresh quote).
  const seedPendingTransfer = async (): Promise<string> => createTransfer(await seedQuote())

  // Fresh FUNDED transfer with the FUNDED ledger batch posted and the Reg E
  // window set; cancelableMinutes < 0 puts the window in the past (expired).
  const seedFundedTransfer = async (opts: { cancelableMinutes?: number } = {}): Promise<string> => {
    const cancelableMinutes = opts.cancelableMinutes ?? 30
    const transferId = await seedPendingTransfer()
    await db.query(
      `select public.transition_transfer($1, 'PENDING_PAYMENT', 'FUNDED', 'webhook:funding',
        'payment initiated', '{}'::jsonb, 'transfer FUNDED', $2::jsonb,
        now(), now() + ($3 || ' minutes')::interval, 'mockpay_1')`,
      [transferId, FUNDED_ENTRIES, String(cancelableMinutes)],
    )
    return transferId
  }

  const cancel = (transferId: string) =>
    db.query(
      `select public.cancel_transfer($1, 'user', 'sender canceled', 'transfer CANCELED', $2::jsonb)`,
      [transferId, CANCELED_ENTRIES],
    )

  // cancel_transfer returns a composite (public.transfers); node-pg hands that
  // back as a raw string, so read the committed state with a plain SELECT.
  const stateOf = async (transferId: string): Promise<string> => {
    const res = await db.query('select state from public.transfers where id = $1', [transferId])
    return res.rows[0].state as string
  }

  // Per-account signed totals (debits − credits) across one transfer's postings.
  const accountTotals = async (transferId: string): Promise<Record<string, number>> => {
    const res = await db.query(
      `select a.code,
              sum(case when e.direction = 'debit' then e.amount_minor else -e.amount_minor end)::bigint as net
         from public.ledger_entries e
         join public.ledger_accounts a on a.id = e.account_id
         join public.ledger_transactions t on t.id = e.ledger_transaction_id
        where t.transfer_id = $1
        group by a.code`,
      [transferId],
    )
    return Object.fromEntries(res.rows.map((r) => [r.code, Number(r.net)]))
  }

  beforeAll(async () => {
    db = new Client({ connectionString: DB_URL })
    await db.connect()
    await db.query(
      `insert into auth.users (id, phone) values ($1, '15550000071') on conflict (id) do nothing`,
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
    destinationId = destination.rows[0].id
  })

  afterAll(async () => {
    // disclosures / transitions / ledger are append-only or FK parents of
    // transfers — truncate (bypasses the append-only row triggers) before the
    // user-scoped deletes below.
    await db.query('truncate table public.ledger_entries, public.ledger_transactions cascade')
    await db.query(
      'truncate table public.payment_events, public.transfer_transitions, public.disclosures',
    )
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

  it('FUNDED → CANCELED: state moves, one transition appended, FUNDED batch reversed to zero', async () => {
    const transferId = await seedFundedTransfer()

    await cancel(transferId)
    expect(await stateOf(transferId)).toBe('CANCELED')

    const trans = await db.query(
      `select from_state, to_state, actor from public.transfer_transitions
        where transfer_id = $1 and to_state = 'CANCELED'`,
      [transferId],
    )
    expect(trans.rows).toEqual([{ from_state: 'FUNDED', to_state: 'CANCELED', actor: 'user' }])

    // FUNDED + CANCELED batches net every touched account back to zero
    expect(await accountTotals(transferId)).toEqual({
      funding_receivable: 0,
      transfer_payable: 0,
      fee_revenue: 0,
    })

    // and each ledger transaction individually nets to zero (the DB invariant)
    const perTx = await db.query(
      `select t.id, sum(case when e.direction = 'debit' then e.amount_minor else -e.amount_minor end)::bigint as net
         from public.ledger_entries e
         join public.ledger_transactions t on t.id = e.ledger_transaction_id
        where t.transfer_id = $1 group by t.id`,
      [transferId],
    )
    expect(perTx.rows.length).toBe(2) // FUNDED, CANCELED
    for (const row of perTx.rows) expect(Number(row.net)).toBe(0)
  })

  it('reverses cleanly at zero fee too (fee line omitted both ways)', async () => {
    // zero-fee quote → FUNDED batch and reversal each have 2 entries, no fee line
    const quote = await db.query(
      `insert into public.quotes (user_id, payout_destination_id, send_amount_minor, send_currency,
         receive_amount_minor, receive_currency, fee_amount_minor, fee_currency,
         fx_rate, source_rate, fx_rate_at, expires_at, status)
       values ($1, $2, ${S}, 'USD', 396014, 'MXN', 0, 'USD', 19.9997, 20.100251, now(),
         now() + interval '15 minutes', 'active') returning id`,
      [USER, destinationId],
    )
    const transferId = await createTransfer(quote.rows[0].id)
    const zeroFeeFunded = JSON.stringify([
      { account_code: 'funding_receivable', direction: 'debit', amount_minor: S, currency: 'USD' },
      { account_code: 'transfer_payable', direction: 'credit', amount_minor: S, currency: 'USD' },
    ])
    await db.query(
      `select public.transition_transfer($1, 'PENDING_PAYMENT', 'FUNDED', 'webhook:funding',
        'payment initiated', '{}'::jsonb, 'transfer FUNDED', $2::jsonb,
        now(), now() + interval '30 minutes', 'mockpay_1')`,
      [transferId, zeroFeeFunded],
    )
    const zeroFeeCanceled = JSON.stringify([
      { account_code: 'transfer_payable', direction: 'debit', amount_minor: S, currency: 'USD' },
      { account_code: 'funding_receivable', direction: 'credit', amount_minor: S, currency: 'USD' },
    ])
    await db.query(
      `select public.cancel_transfer($1, 'user', 'sender canceled', 'transfer CANCELED', $2::jsonb)`,
      [transferId, zeroFeeCanceled],
    )
    expect(await accountTotals(transferId)).toEqual({ funding_receivable: 0, transfer_payable: 0 })
  })

  it('the headline race: cancel vs submit-claim — exactly one wins, never both', async () => {
    const db2 = new Client({ connectionString: DB_URL })
    await db2.connect()
    try {
      // The per-side deterministic outcomes (cancel wins; claim-already-won →
      // cancel refused) are pinned by the dedicated tests below; this loop
      // hammers the CONCURRENT invariant across 30 fresh FUNDED rows.
      for (let i = 0; i < 30; i++) {
        const transferId = await seedFundedTransfer()

        // the cancel RPC and the EXACT guarded UPDATE payout-submit.ts's
        // claimForSubmission runs, fired concurrently on the one FUNDED row
        const doCancel = db
          .query(`select public.cancel_transfer($1, 'user', 'race', 'transfer CANCELED', $2::jsonb)`, [
            transferId,
            CANCELED_ENTRIES,
          ])
          .then(() => 'cancel' as const)
          .catch((e: { message: string }) => {
            if (e.message.includes('transfer_not_cancelable')) return null
            throw e
          })
        const doClaim = db2
          .query(
            `update public.transfers set submit_attempted_at = now()
              where id = $1 and state = 'FUNDED' and payout_hold_reason is null
                and submit_attempted_at is null
              returning id`,
            [transferId],
          )
          .then((r) => (r.rowCount === 1 ? ('claim' as const) : null))

        const winners = (await Promise.all([doCancel, doClaim])).filter(Boolean)
        expect(winners).toHaveLength(1) // exactly one guarded UPDATE commits

        const row = await db.query(
          `select state, submit_attempted_at, provider_transfer_ref from public.transfers where id = $1`,
          [transferId],
        )
        const { state, submit_attempted_at, provider_transfer_ref } = row.rows[0]
        // THE structural invariant: a CANCELED row never coexists with a claim,
        // and a claimed row never reached CANCELED — whichever guard won, the
        // other matched 0 rows.
        if (state === 'CANCELED') {
          expect(submit_attempted_at).toBeNull()
          expect(provider_transfer_ref).toBeNull()
        } else {
          expect(state).toBe('FUNDED')
          expect(submit_attempted_at).not.toBeNull()
        }
      }
    } finally {
      await db2.end()
    }
  })

  it('claimed-but-not-yet-submitted (submit_attempted_at set, still FUNDED) → not cancelable', async () => {
    const transferId = await seedFundedTransfer()
    // simulate a submit job that claimed then crashed before the transition:
    // a Bridge payout may already exist, so cancel MUST refuse (the recovery
    // re-POST owns it).
    await db.query(`update public.transfers set submit_attempted_at = now() where id = $1`, [transferId])
    await expect(cancel(transferId)).rejects.toThrow('transfer_not_cancelable')
  })

  it('expired Reg E window → not cancelable', async () => {
    const transferId = await seedFundedTransfer({ cancelableMinutes: -1 })
    await expect(cancel(transferId)).rejects.toThrow('transfer_not_cancelable')
  })

  it('a held FUNDED transfer stays cancelable (guard omits payout_hold_reason)', async () => {
    const transferId = await seedFundedTransfer()
    await db.query(
      `update public.transfers set payout_hold_reason = 'fx_drift', payout_held_at = now() where id = $1`,
      [transferId],
    )
    await cancel(transferId)
    expect(await stateOf(transferId)).toBe('CANCELED')
  })

  it('replay: a second cancel is a no-op — no duplicate transition or ledger post', async () => {
    const transferId = await seedFundedTransfer()
    await cancel(transferId)
    await cancel(transferId) // replay (route resumes here after a crash mid-cancel)

    const trans = await db.query(
      `select count(*)::int as n from public.transfer_transitions
        where transfer_id = $1 and to_state = 'CANCELED'`,
      [transferId],
    )
    expect(trans.rows[0].n).toBe(1)
    const tx = await db.query(
      `select count(*)::int as n from public.ledger_transactions
        where transfer_id = $1 and transition = 'CANCELED'`,
      [transferId],
    )
    expect(tx.rows[0].n).toBe(1)
  })

  it('PENDING_PAYMENT and unknown transfers are not cancelable', async () => {
    const pendingId = await seedPendingTransfer()
    await expect(cancel(pendingId)).rejects.toThrow('transfer_not_cancelable')
    await expect(
      db.query(
        `select public.cancel_transfer('00000000-0000-4000-8000-0000000000cc'::uuid, 'user', null, null, null)`,
      ),
    ).rejects.toThrow('transfer_not_found')
  })

  it('denies cancel_transfer to authenticated clients (service-role only)', async () => {
    const transferId = await seedFundedTransfer()
    await db.query('begin')
    try {
      await db.query('set local role authenticated')
      await db.query(`select set_config('request.jwt.claims', $1, true)`, [
        JSON.stringify({ sub: USER, role: 'authenticated' }),
      ])
      await expect(
        db.query(
          `select public.cancel_transfer($1, 'user', null, 'transfer CANCELED', $2::jsonb)`,
          [transferId, CANCELED_ENTRIES],
        ),
      ).rejects.toMatchObject({ code: '42501' })
    } finally {
      await db.query('rollback')
    }
  })
})
