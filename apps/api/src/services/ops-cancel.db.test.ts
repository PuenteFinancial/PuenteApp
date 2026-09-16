// Integration tests against a real local Supabase stack (Docker).
// Gated: RUN_DB_TESTS=1. Proves the ops cancel of an undeliverable payout at the
// DATABASE level — the layer where the three things that actually matter live:
//
//   1. THE LEDGER ARITHMETIC. The whole reason this tail does not reuse the
//      sender-cancel reversal is that these rows have `funding_cleared` posted.
//      A mocked test can assert which builder was called; only a real ledger can
//      show that the chosen pair lands every account on zero and that the
//      obvious alternative drives funding_receivable NEGATIVE. Both are asserted
//      below, the second as an explicit counterfactual.
//   2. THE RACE. `submit_attempted_at IS NULL` inside ops_cancel_held_transfer's
//      guarded UPDATE is only a serialization point because Postgres locks the
//      row; two connections at the statement level are the only way to test it.
//   3. THE GRANT. ops_cancel_held_transfer is service-role only, and a raw `pg`
//      superuser connection cannot see a missing grant (the 2026-09-10 lesson —
//      14 schema tests passed against a table the API could not write). One test
//      here drives the real service through PostgREST end to end.
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import { Client } from 'pg'

// The service resolves the processor per ROW (audit corner 1); rows seeded here
// carry no stamp, so the accessor must hand back the same instance the process
// would. Spied, not replaced: MockFundingProcessor.refund() ignores the
// idempotency key by design, so a double disbursement leaves the same database
// state as a single one and can only be seen by counting calls.
const refundCalls: unknown[] = []
vi.mock('./funding/index.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./funding/index.js')>()
  const spied = () =>
    new Proxy(actual.getFundingProcessor(), {
      get(target, prop, recv) {
        if (prop !== 'refund') return Reflect.get(target, prop, recv)
        return (input: unknown) => {
          refundCalls.push(input)
          return (target as { refund: (i: unknown) => unknown }).refund(input)
        }
      },
    })
  return { ...actual, getFundingProcessor: spied, processorFor: spied }
})

// A seam for the one race that cannot be staged any other way. The RPC's replay
// arm is only reachable when the row goes CANCELED strictly BETWEEN the
// service's read and its call — a window that exists for microseconds against a
// real database and cannot be seeded, because seeding it produces the OTHER
// shape (the pre-read branch) instead. So the interleaving is injected rather
// than raced: the real RPC still runs, against real Postgres, and really does
// take its replay arm.
const beforeOpsCancel = { impl: null as null | (() => Promise<void>) }
vi.mock('./transfers.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./transfers.js')>()
  return {
    ...actual,
    opsCancelHeldTransfer: async (...args: Parameters<typeof actual.opsCancelHeldTransfer>) => {
      if (beforeOpsCancel.impl) await beforeOpsCancel.impl()
      return actual.opsCancelHeldTransfer(...args)
    },
  }
})

const { cancelHeldTransfer } = await import('./ops-cancel.js')
const {
  fundedLedgerEntries,
  fundingClearedLedgerEntries,
  cancelRefundOwedLedgerEntries,
  canceledLedgerEntries,
} = await import('./transfers.js')

const runDb = process.env.RUN_DB_TESTS === '1'
const DB_URL = process.env.TEST_DB_URL ?? 'postgresql://postgres:postgres@127.0.0.1:54322/postgres'

// Fixed UUID in the …00d block — no collision with the other db tests' users.
const USER = '00000000-0000-4000-8000-0000000000da'
const OPERATOR = '00000000-0000-4000-8000-0000000000db'
const ACTOR = `ops:${OPERATOR}`

// The staging shape this was built for, scaled to the db-test quote fixtures:
// revenue carried in margin_minor, fee zero.
const S = 20000 // the send amount
// NON-ZERO, AND DELIBERATELY NOT EQUAL TO MARGIN. The sender is owed `send +
// fee`, and revenue is `fee + margin` — with a zero fee both collapse into the
// send amount and the arithmetic stops being testable. Verified by mutation
// 2026-09-16: dropping the fee leg from this tail's refund left all 2491 tests
// green. A value distinct from MARGIN also keeps `fee_revenue` from reading the
// same under `fee + margin` as under `2 x margin`.
const FEE = 250
const MARGIN = 199
const PRINCIPAL = S - MARGIN
const REVENUE = FEE + MARGIN
const TOTAL = S + FEE

const amounts = { send_amount_minor: S, fee_amount_minor: FEE, margin_minor: MARGIN }
const json = (entries: unknown) => JSON.stringify(entries)

const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() }

describe.skipIf(!runDb)('ops cancel of an undeliverable payout (integration, local Supabase)', () => {
  let db: Client
  let destinationId: string

  const seedQuote = async (): Promise<string> => {
    const quote = await db.query(
      `insert into public.quotes (user_id, payout_destination_id, send_amount_minor, send_currency,
         receive_amount_minor, receive_currency, fee_amount_minor, fee_currency,
         fx_rate, source_rate, fx_rate_at, expires_at, status, margin_minor)
       values ($1, $2, ${S}, 'USD', 396014, 'MXN', ${FEE}, 'USD', 19.9997, 20.100251, now(),
         now() + interval '15 minutes', 'active', ${MARGIN}) returning id`,
      [USER, destinationId],
    )
    return quote.rows[0].id as string
  }

  /**
   * A FUNDED transfer that is CLEARED and HELD — the row this tail exists for.
   * The Reg E window is deliberately in the PAST: these rows are days old, and
   * `cancel_transfer` refusing them is exactly why a second RPC exists.
   */
  const seedHeldTransfer = async (
    opts: { holdReason?: string | null; cleared?: boolean; windowOpen?: boolean } = {},
  ): Promise<string> => {
    const holdReason = opts.holdReason === undefined ? 'payability' : opts.holdReason
    const cleared = opts.cleared ?? true
    // The window is in the past by default (these rows are days old). Opening it
    // is only for the sender-cancel fixture below, which cancel_transfer will
    // not touch otherwise.
    const age = opts.windowOpen ? '0 days' : '3 days'
    const quoteId = await seedQuote()
    const created = await db.query(
      `select public.create_transfer_from_quote($1, $2, $3, 'es', $4::jsonb) as result`,
      [quoteId, USER, `ops-cancel-${quoteId}`, json({ version: 1 })],
    )
    const transferId = (created.rows[0].result as { transfer: { id: string } }).transfer.id
    await db.query(
      `select public.transition_transfer($1, 'PENDING_PAYMENT', 'FUNDED', 'webhook:funding',
        'payment initiated', '{}'::jsonb, 'transfer FUNDED', $2::jsonb,
        now() - $3::interval, now() - $3::interval + interval '30 minutes', 'mockpay_1')`,
      [transferId, json(fundedLedgerEntries(amounts)), age],
    )
    if (cleared) {
      await db.query(
        `select public.post_ledger_transaction($1 || ':funding_cleared', 'ach cleared', $2::jsonb, $1::uuid, 'funding_cleared')`,
        [transferId, json(fundingClearedLedgerEntries(amounts))],
      )
      await db.query('update public.transfers set funding_cleared = true where id = $1', [
        transferId,
      ])
    }
    if (holdReason !== null) {
      await db.query(
        `update public.transfers set payout_hold_reason = $2, payout_held_at = now() - $3::interval where id = $1`,
        [transferId, holdReason, age],
      )
    }
    return transferId
  }

  const rawCancel = (transferId: string, holdReason = 'payability') =>
    db.query(
      `select public.ops_cancel_held_transfer($1, $2, $3, 'ops cancel', 'transfer CANCELED', $4::jsonb)`,
      [transferId, ACTOR, holdReason, json(cancelRefundOwedLedgerEntries(amounts))],
    )

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
    return Object.fromEntries(res.rows.map((r) => [r.code as string, Number(r.net)]))
  }

  beforeAll(async () => {
    db = new Client({ connectionString: DB_URL })
    await db.connect()
    await db.query(
      `insert into auth.users (id, phone) values ($1, '15550000101') on conflict (id) do nothing`,
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
    destinationId = destination.rows[0].id as string
  })

  afterAll(async () => {
    // The ledger is append-only by ROW TRIGGER, so a DELETE raises P0001 after
    // every assertion has passed and the file reports FAILED with 0 failing
    // tests. TRUNCATE fires no row triggers. Leaving these behind is not an
    // option either: funding_receivable is a GLOBAL balance the float ceiling
    // reads, and a leaked receivable trips it for every later suite.
    await db.query('truncate table public.ledger_entries, public.ledger_transactions cascade')
    // ops_actions is append-only by the same trigger, and it holds an
    // ON DELETE RESTRICT reference to transfers — so it must be truncated, and
    // truncated BEFORE the per-user transfer deletes below.
    await db.query(
      'truncate table public.payment_events, public.transfer_transitions, public.disclosures, public.ops_actions',
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

  it('drives the whole tail through the real services and lands every account on zero', async () => {
    refundCalls.length = 0
    const transferId = await seedHeldTransfer()

    // Through PostgREST as service_role — which is what proves the RPC grant.
    await expect(
      cancelHeldTransfer(
        {
          transferId,
          actor: ACTOR,
          holdReason: 'payability',
          note: 'destination has no SPEI endorsement; Bridge will never pay it',
          requestId: null,
        },
        log,
      ),
    ).resolves.toEqual({ done: true, outcome: 'canceled_and_refunded' })

    expect(await stateOf(transferId)).toBe('REFUNDED')
    expect(refundCalls).toHaveLength(1)
    // WHAT was sent back, not just that something was. The ledger assertions
    // below net to zero whatever the processor was asked for — the batches are
    // built from the row, and the disbursement amount is computed separately at
    // the call site, so only this line connects the two. Dropping the fee leg
    // from that expression left every balance assertion here green.
    expect(refundCalls[0]).toMatchObject({ amountMinor: TOTAL, currency: 'USD' })

    // THE POINT. FUNDED + funding_cleared + CANCELED + REFUNDED nets every
    // touched account back to zero on a transfer whose ACH already settled.
    expect(await accountTotals(transferId)).toEqual({
      funding_receivable: 0,
      cash_clearing: 0,
      transfer_payable: 0,
      fee_revenue: 0,
      refunds_payable: 0,
    })

    // Four postings under four distinct keys, each individually net-zero.
    const perTx = await db.query(
      `select t.transition,
              sum(case when e.direction = 'debit' then e.amount_minor else -e.amount_minor end)::bigint as net
         from public.ledger_entries e
         join public.ledger_transactions t on t.id = e.ledger_transaction_id
        where t.transfer_id = $1 group by t.transition`,
      [transferId],
    )
    // Sorted in JS: Postgres' default collation is not byte order, so
    // `order by transition` interleaves 'funding_cleared' among the uppercase
    // keys and the expectation would be collation-dependent.
    expect(perTx.rows.map((r) => r.transition as string).sort()).toEqual([
      'CANCELED',
      'FUNDED',
      'REFUNDED',
      'funding_cleared',
    ])
    for (const r of perTx.rows) expect(Number(r.net)).toBe(0)

    // Both transitions signed by the operator, and the hold reason preserved on
    // the cancel even though the column was cleared.
    const trans = await db.query(
      `select from_state, to_state, actor, metadata from public.transfer_transitions
        where transfer_id = $1 and from_state is not null order by created_at`,
      [transferId],
    )
    expect(trans.rows.map((r) => [r.from_state, r.to_state, r.actor])).toEqual([
      ['PENDING_PAYMENT', 'FUNDED', 'webhook:funding'],
      ['FUNDED', 'CANCELED', ACTOR],
      ['CANCELED', 'REFUNDED', ACTOR],
    ])
    expect(trans.rows[1].metadata).toEqual({ payout_hold_reason: 'payability' })

    // The hold is discharged, not left advertising work nobody owes.
    const row = await db.query(
      'select payout_hold_reason, payout_held_at, refund_payment_ref, refunded_at from public.transfers where id = $1',
      [transferId],
    )
    expect(row.rows[0].payout_hold_reason).toBeNull()
    expect(row.rows[0].payout_held_at).toBeNull()
    expect(row.rows[0].refund_payment_ref).toMatch(/^mockrefund_/)
    expect(row.rows[0].refunded_at).not.toBeNull()

    // The provenance row, written as the operator with their note.
    const ops = await db.query(
      `select actor, action, reason, note, before, after from public.ops_actions where transfer_id = $1`,
      [transferId],
    )
    expect(ops.rows).toHaveLength(1)
    expect(ops.rows[0]).toMatchObject({ actor: ACTOR, action: 'transfer_cancel', reason: 'payability' })
    expect(ops.rows[0].before).toEqual({
      state: 'FUNDED',
      payoutHoldReason: 'payability',
      payoutHeldAt: expect.any(String),
      fundingCleared: true,
    })
    expect(ops.rows[0].after).toEqual({
      state: 'REFUNDED',
      outcome: 'canceled_and_refunded',
      undoMode: 'refunded',
    })
  })

  // THE COUNTERFACTUAL. The batch a reader would reach for first — the
  // sender-cancel reversal — books a credit against a receivable the clearing
  // leg already settled. Reconciliation's open-item guard calls a negative
  // funding_receivable an arithmetic impossibility, and it would be right.
  it('the sender-cancel reversal would drive funding_receivable negative on a cleared row', async () => {
    const transferId = await seedHeldTransfer()
    await db.query(
      `select public.ops_cancel_held_transfer($1, $2, 'payability', 'counterfactual', 'wrong batch', $3::jsonb)`,
      [transferId, ACTOR, json(canceledLedgerEntries(amounts))],
    )

    const totals = await accountTotals(transferId)
    expect(totals['funding_receivable']).toBe(-TOTAL)
    expect(totals['cash_clearing']).toBe(TOTAL) // …and the cash we hold is unaccounted for
  })

  it('a second call is a replay: no extra transition, no second posting', async () => {
    const transferId = await seedHeldTransfer()
    await rawCancel(transferId)
    await rawCancel(transferId)

    expect(await stateOf(transferId)).toBe('CANCELED')
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

  it('refuses a hold that changed underneath the operator', async () => {
    const transferId = await seedHeldTransfer({ holdReason: 'fx_drift' })
    await expect(rawCancel(transferId, 'payability')).rejects.toThrow('transfer_not_cancelable')
    expect(await stateOf(transferId)).toBe('FUNDED')
  })

  it('refuses an unheld row — nothing here cancels a healthy payout', async () => {
    const transferId = await seedHeldTransfer()
    await db.query('update public.transfers set payout_hold_reason = null where id = $1', [
      transferId,
    ])
    await expect(rawCancel(transferId)).rejects.toThrow('transfer_not_cancelable')
  })

  it('refuses a null hold reason rather than silently matching nothing', async () => {
    const transferId = await seedHeldTransfer()
    await expect(
      db.query(`select public.ops_cancel_held_transfer($1, $2, null, null, null, null)`, [
        transferId,
        ACTOR,
      ]),
    ).rejects.toThrow('requires a hold reason')
  })

  it('refuses a row the submit job has claimed, and one already at Bridge', async () => {
    const claimed = await seedHeldTransfer()
    await db.query('update public.transfers set submit_attempted_at = now() where id = $1', [
      claimed,
    ])
    await expect(rawCancel(claimed)).rejects.toThrow('transfer_not_cancelable')

    const atBridge = await seedHeldTransfer()
    await db.query(`update public.transfers set provider_transfer_ref = $2 where id = $1`, [
      atBridge,
      `bridge_${atBridge}`,
    ])
    await expect(rawCancel(atBridge)).rejects.toThrow('transfer_not_cancelable')
  })

  // The headline race, at the statement level on two connections: the submit
  // claim and this cancel both guard on submit_attempted_at, so exactly one
  // commits. A Bridge-payout-exists-but-CANCELED row is structurally impossible.
  it('serializes against the submit claim — exactly one of the two wins', async () => {
    const transferId = await seedHeldTransfer()
    const other = new Client({ connectionString: DB_URL })
    await other.connect()
    try {
      await db.query('begin')
      // The cancel takes the row lock first and holds it.
      await rawCancel(transferId)

      // The submit claim's exact predicate (jobs/payout-submit.ts). It blocks on
      // the lock; once the cancel commits, `state = 'FUNDED'` no longer matches.
      const claim = other.query(
        `update public.transfers set submit_attempted_at = now()
          where id = $1 and state = 'FUNDED' and payout_hold_reason is null
            and submit_attempted_at is null returning id`,
        [transferId],
      )
      await db.query('commit')
      const claimed = await claim

      expect(claimed.rowCount).toBe(0)
      expect(await stateOf(transferId)).toBe('CANCELED')
      const row = await db.query(
        'select submit_attempted_at, provider_transfer_ref from public.transfers where id = $1',
        [transferId],
      )
      expect(row.rows[0].submit_attempted_at).toBeNull()
      expect(row.rows[0].provider_transfer_ref).toBeNull()
    } finally {
      await other.end()
    }
  })

  it('reports an unknown transfer as transfer_not_found', async () => {
    await expect(
      db.query(
        `select public.ops_cancel_held_transfer('00000000-0000-4000-8000-0000000000dc'::uuid,
          'ops:x', 'payability', null, null, null)`,
      ),
    ).rejects.toThrow('transfer_not_found')
  })

  it('denies the RPC to authenticated clients (service-role only)', async () => {
    const transferId = await seedHeldTransfer()
    await db.query('begin')
    try {
      await db.query('set local role authenticated')
      await db.query(`select set_config('request.jwt.claims', $1, true)`, [
        json({ sub: USER, role: 'authenticated' }),
      ])
      await expect(
        db.query(
          `select public.ops_cancel_held_transfer($1, 'ops:x', 'payability', null, null, $2::jsonb)`,
          [transferId, json(cancelRefundOwedLedgerEntries(amounts))],
        ),
      ).rejects.toMatchObject({ code: '42501' })
    } finally {
      await db.query('rollback')
    }
  })

  // THE DOUBLE-BOOK GUARD, against a real sender cancel rather than a fixture.
  // cancel_transfer posts the FUNDED-batch reversal at CANCELED, so
  // refunds_payable was never credited — settling such a row through this tail
  // would debit a liability that does not exist.
  it('refuses to finish a CANCELED row that the SENDER canceled', async () => {
    const transferId = await seedHeldTransfer({ holdReason: null, windowOpen: true })
    await db.query(
      `select public.cancel_transfer($1, 'user', 'sender canceled', 'transfer CANCELED', $2::jsonb)`,
      [transferId, json(canceledLedgerEntries(amounts))],
    )
    expect(await stateOf(transferId)).toBe('CANCELED')

    await expect(
      cancelHeldTransfer(
        {
          transferId,
          actor: ACTOR,
          holdReason: 'payability',
          note: 'trying to finish a row this tail did not cancel',
          requestId: null,
        },
        log,
      ),
    ).resolves.toEqual({ done: false, reason: 'not_our_cancel' })

    // Nothing posted beyond what the sender's cancel wrote.
    const keys = await db.query(
      `select transition from public.ledger_transactions where transfer_id = $1`,
      [transferId],
    )
    expect((keys.rows as Array<{ transition: string }>).map((r) => r.transition).sort()).toEqual([
      'CANCELED',
      'FUNDED',
      'funding_cleared',
    ])
    expect((await accountTotals(transferId))['refunds_payable']).toBeUndefined()
  })

  // THE SAME REFUSAL, REACHED THROUGH THE RPC'S REPLAY ARM.
  //
  // Above, the row already read CANCELED. Here it reads FUNDED — the refusal
  // gate passes — and the sender cancels before the RPC fires. The guarded
  // UPDATE finds nothing, `v_current = 'CANCELED'`, and the function returns
  // the row with NO error: a success the caller cannot tell apart from a cancel
  // it performed itself. Until 2026-09-16 that was a way past `not_our_cancel`
  // into step 2, on a row whose books the sender's cancel had already squared.
  //
  // The assertion that matters is the ledger. cancel_transfer posted the
  // FUNDED-batch reversal, so refunds_payable was never credited; a `:REFUNDED`
  // batch on top of it would debit a liability that does not exist.
  it('refuses when the sender cancels between our read and the RPC', async () => {
    refundCalls.length = 0
    const transferId = await seedHeldTransfer({ windowOpen: true })
    beforeOpsCancel.impl = async () => {
      await db.query(
        `select public.cancel_transfer($1, 'user', 'sender canceled', 'transfer CANCELED', $2::jsonb)`,
        [transferId, json(canceledLedgerEntries(amounts))],
      )
    }

    try {
      await expect(
        cancelHeldTransfer(
          {
            transferId,
            actor: ACTOR,
            holdReason: 'payability',
            note: 'the sender got there first',
            requestId: null,
          },
          log,
        ),
      ).resolves.toEqual({ done: false, reason: 'not_our_cancel' })
    } finally {
      beforeOpsCancel.impl = null
    }

    // Nothing posted beyond what the sender's cancel wrote — in particular no
    // second CANCELED batch from our RPC (its replay arm posts nothing) and no
    // REFUNDED batch from the settle we refused to reach.
    const keys = await db.query(
      `select transition from public.ledger_transactions where transfer_id = $1`,
      [transferId],
    )
    expect((keys.rows as Array<{ transition: string }>).map((r) => r.transition).sort()).toEqual([
      'CANCELED',
      'FUNDED',
      'funding_cleared',
    ])
    expect((await accountTotals(transferId))['refunds_payable']).toBeUndefined()
    expect(await stateOf(transferId)).toBe('CANCELED')
    // And no disbursement attempt. The sender's void and this tail's refund use
    // different processor sub-keys (`:void` vs `:refund`), so they would NOT
    // have deduped at the provider — this is the half of the race that pays
    // twice, not merely the half that books twice.
    expect(refundCalls).toHaveLength(0)
  })

  it('books the UNCLEARED shape back to zero too, through the voided arm', async () => {
    // No funding_cleared leg: the receivable is still open. The mock always
    // reports `refunded`, so drive the voided settle by hand — the arithmetic,
    // not the adapter, is what this pins.
    const transferId = await seedHeldTransfer({ cleared: false })
    await rawCancel(transferId)
    await db.query(
      `select public.transition_transfer($1, 'CANCELED', 'REFUNDED', $2, 'voided settle',
        '{}'::jsonb, 'transfer REFUNDED', $3::jsonb, null, null, null, null)`,
      [
        transferId,
        ACTOR,
        json([
          { account_code: 'refunds_payable', direction: 'debit', amount_minor: TOTAL, currency: 'USD' },
          {
            account_code: 'funding_receivable',
            direction: 'credit',
            amount_minor: TOTAL,
            currency: 'USD',
          },
        ]),
      ],
    )

    expect(await stateOf(transferId)).toBe('REFUNDED')
    expect(await accountTotals(transferId)).toEqual({
      funding_receivable: 0,
      transfer_payable: 0,
      fee_revenue: 0,
      refunds_payable: 0,
    })
  })

  it('PRINCIPAL and revenue split the total exactly (no float, no rounding slack)', () => {
    const entries = cancelRefundOwedLedgerEntries(amounts)
    expect(entries.find((e) => e.account_code === 'transfer_payable')!.amount_minor).toBe(PRINCIPAL)
    expect(entries.find((e) => e.account_code === 'fee_revenue')!.amount_minor).toBe(REVENUE)
    expect(entries.find((e) => e.account_code === 'refunds_payable')!.amount_minor).toBe(TOTAL)
  })
})
