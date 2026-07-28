// Integration tests against a real local Supabase stack (Docker).
// Gated: RUN_DB_TESTS=1. Proves the slice-7 PR6b UNDER_REVIEW exits at the
// DATABASE level — the ledger truths the mocked cancellation-review.test.ts
// cannot establish:
//
//   - the correction payment posts ONE batch under {id}:REFUNDED that nets to
//     zero and books to loss_cancellation_correction — a NEW expense, not a
//     reversal: fee_revenue stays earned and transfer_payable stays discharged
//   - the original COMPLETED entries (and every earlier batch) are untouched,
//     entry for entry — delivered history is never rewritten
//   - a replay writes nothing: no second disbursement (the processor is
//     observed, not mocked), no new entries, the first resolution stands
//   - both denial exits post NO ledger: UNDER_REVIEW → COMPLETED moves state
//     only, and a never-routed COMPLETED denial moves nothing at all
//   - the legal guard holds against real rows: an in-window request that beat
//     the operator's cited deposit cannot be denied
//
// The walk to UNDER_REVIEW posts the real FUNDED/SUBMITTED/COMPLETED batches
// through the production wrappers, then makes the COMPLETED → UNDER_REVIEW
// routing transition BY HAND — the routing DECISION lives in
// payment-event-process (pinned in its unit suite, driven for real in the e2e
// rig); what this suite owns is what the exits do to the books.
//
// Fixture idiom: FRESH uuids per run, no cleanup beyond closing the connection
// (append-only tables; leftovers under random ids are inert; `supabase db
// reset` is the janitor). Seeds mirror refund-tail.db.test.ts.
import crypto from 'node:crypto'
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import { Client } from 'pg'
import {
  transitionTransfer,
  fundedLedgerEntries,
  completedLedgerEntries,
} from './transfers.js'
import { submittedLedgerEntries } from './payouts.js'
import { recordCancellationRequest } from './cancellations.js'
import { refundCancellation, denyCancellation } from './cancellation-review.js'

// Count processor calls without changing processor BEHAVIOUR (the
// refund-tail.db.test.ts pattern): the real MockFundingProcessor runs, we just
// observe it. Database state looks identical whether the processor was called
// once or twice — the mock mints a fresh ref per call and the persist is
// null-gated — so this spy is the only witness a replay could double-pay.
const refundCalls: unknown[] = []
vi.mock('./funding/index.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./funding/index.js')>()
  return {
    ...actual,
    getFundingProcessor: () =>
      new Proxy(actual.getFundingProcessor(), {
        get(target, prop, recv) {
          if (prop !== 'refund') return Reflect.get(target, prop, recv)
          return (input: unknown) => {
            refundCalls.push(input)
            return (target as { refund: (i: unknown) => unknown }).refund(input)
          }
        },
      }),
  }
})

const runDb = process.env.RUN_DB_TESTS === '1'

const DB_URL = process.env.TEST_DB_URL ?? 'postgresql://postgres:postgres@127.0.0.1:54322/postgres'

const USER = crypto.randomUUID()

const S = 19801 // quoted send principal
const FEE = 199
const A = 19855 // actual USDC draw (A > S → +54 unfavorable slippage)

describe.skipIf(!runDb)('cancellation review exits (integration, local Supabase)', () => {
  let db: Client
  let destinationId: string

  const seedTransfer = async (opts: { cancelableMinutes?: number } = {}): Promise<string> => {
    const transferId = crypto.randomUUID()
    const minutes = opts.cancelableMinutes ?? 30
    const quote = await db.query(
      `insert into public.quotes (user_id, payout_destination_id, send_amount_minor, send_currency,
         receive_amount_minor, receive_currency, fee_amount_minor, fee_currency,
         fx_rate, source_rate, fx_rate_at, expires_at, status)
       values ($1, $2, ${S}, 'USD', 396014, 'MXN', ${FEE}, 'USD', 19.9997, 20.100251, now(),
         now() + interval '15 minutes', 'consumed') returning id`,
      [USER, destinationId],
    )
    await db.query(
      `insert into public.transfers (id, user_id, payout_destination_id, quote_id,
         send_amount_minor, send_currency, receive_amount_minor, receive_currency,
         fee_amount_minor, fee_currency, fx_rate, fx_rate_at, idempotency_key, state,
         funding_payment_ref, payment_at, cancelable_until)
       values ($1, $2, $3, $4, ${S}, 'USD', 396014, 'MXN', ${FEE}, 'USD', 19.9997, now(), $5,
         'PENDING_PAYMENT', $6, now(), $7)`,
      [
        transferId,
        USER,
        destinationId,
        quote.rows[0].id,
        `review-db-test-${transferId}`,
        `mockpay_${transferId}`,
        new Date(Date.now() + minutes * 60_000).toISOString(),
      ],
    )
    return transferId
  }

  // PENDING_PAYMENT → … → COMPLETED with the real batches, recording the
  // cancellation at SUBMITTED — where the 202 branch records it in production.
  const walkToCompletedWithRequest = async (transferId: string) => {
    await transitionTransfer({
      transferId,
      fromState: 'PENDING_PAYMENT',
      toState: 'FUNDED',
      actor: 'webhook:funding',
      ledgerEntries: fundedLedgerEntries({ send_amount_minor: S, fee_amount_minor: FEE }),
    })
    await transitionTransfer({
      transferId,
      fromState: 'FUNDED',
      toState: 'SUBMITTED',
      actor: 'worker:payout',
      providerTransferRef: `bridge_ref_${transferId}`,
      ledgerEntries: submittedLedgerEntries({ sendAmountMinor: S, actualSourceAmountMinor: A }),
    })
    const request = await recordCancellationRequest({
      transferId,
      userId: USER,
      state: 'SUBMITTED',
    })
    await transitionTransfer({
      transferId,
      fromState: 'SUBMITTED',
      toState: 'IN_FLIGHT',
      actor: 'worker:payment-event',
    })
    await transitionTransfer({
      transferId,
      fromState: 'IN_FLIGHT',
      toState: 'COMPLETED',
      actor: 'worker:payment-event',
      ledgerEntries: completedLedgerEntries({ send_amount_minor: S }),
    })
    return request
  }

  // The routing transition payment-event-process makes for a timely
  // pre-deposit request (no ledger — UNDER_REVIEW is a holding state).
  const parkUnderReview = (transferId: string) =>
    transitionTransfer({
      transferId,
      fromState: 'COMPLETED',
      toState: 'UNDER_REVIEW',
      actor: 'system',
      reason: 'timely pre-deposit cancellation on a delivered transfer — correction payment owed',
    })

  beforeAll(async () => {
    db = new Client({ connectionString: DB_URL })
    await db.connect()
    await db.query(
      `insert into auth.users (id, phone) values ($1, $2) on conflict (id) do nothing`,
      [USER, `1555${crypto.randomInt(1_000_000, 9_999_999)}`],
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
    await db.end()
  })

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

  const countEntries = async (transferId: string): Promise<number> => {
    const res = await db.query(
      `select count(*)::int as n from public.ledger_entries e
        join public.ledger_transactions t on t.id = e.ledger_transaction_id
       where t.transfer_id = $1`,
      [transferId],
    )
    return res.rows[0].n as number
  }

  // Every entry of one transfer's batches, deterministically sorted (ids are
  // uuids, so there is no insertion order to sort by) — the "delivered history
  // is never rewritten" witness: same ids, same values, before and after.
  const allEntries = async (transferId: string) =>
    (
      await db.query(
        `select e.id, t.transition, a.code, e.direction, e.amount_minor::bigint as amount
           from public.ledger_entries e
           join public.ledger_accounts a on a.id = e.account_id
           join public.ledger_transactions t on t.id = e.ledger_transaction_id
          where t.transfer_id = $1
          order by t.transition, a.code, e.direction, e.id`,
        [transferId],
      )
    ).rows

  const requestRow = async (transferId: string) =>
    (
      await db.query(
        `select status, resolution, resolved_by from public.cancellation_requests
          where transfer_id = $1 order by created_at desc limit 1`,
        [transferId],
      )
    ).rows[0]

  it('pays the correction as ONE net-zero batch to loss_cancellation_correction, leaving delivered history intact', async () => {
    const transferId = await seedTransfer()
    await walkToCompletedWithRequest(transferId)
    await parkUnderReview(transferId)

    const entriesBefore = await allEntries(transferId)
    refundCalls.length = 0

    await expect(
      refundCancellation({ transferId, operator: 'dbtest' }),
    ).resolves.toEqual({ done: true, outcome: 'refunded' })

    // The sender was actually paid, exactly once, send + fee.
    expect(refundCalls).toHaveLength(1)
    expect(refundCalls[0]).toMatchObject({ amountMinor: S + FEE, currency: 'USD' })
    const transfer = (
      await db.query(
        'select state, refund_payment_ref, refunded_at from public.transfers where id = $1',
        [transferId],
      )
    ).rows[0]
    expect(transfer.state).toBe('REFUNDED')
    expect(transfer.refund_payment_ref).toMatch(/^mockrefund_/)
    expect(transfer.refunded_at).not.toBeNull()

    // Exactly the four batches — and NO bridge_return: this is the correction
    // tail, not the payout-failure tail. Bridge keeps nothing to return here.
    const perTx = await db.query(
      `select t.transition,
              sum(case when e.direction = 'debit' then e.amount_minor else -e.amount_minor end)::bigint as net
         from public.ledger_entries e
         join public.ledger_transactions t on t.id = e.ledger_transaction_id
        where t.transfer_id = $1 group by t.id, t.transition`,
      [transferId],
    )
    expect(perTx.rows.map((r) => r.transition).sort()).toEqual(
      ['COMPLETED', 'FUNDED', 'REFUNDED', 'SUBMITTED'].sort(),
    )
    for (const row of perTx.rows) expect(Number(row.net)).toBe(0)

    // The REFUNDED batch is the correction pair and nothing else.
    const correction = await db.query(
      `select a.code, e.direction, e.amount_minor::bigint as amount
         from public.ledger_entries e
         join public.ledger_accounts a on a.id = e.account_id
         join public.ledger_transactions t on t.id = e.ledger_transaction_id
        where t.transfer_id = $1 and t.transition = 'REFUNDED'
        order by a.code`,
      [transferId],
    )
    expect(correction.rows).toEqual([
      { code: 'cash_clearing', direction: 'credit', amount: String(S + FEE) },
      { code: 'loss_cancellation_correction', direction: 'debit', amount: String(S + FEE) },
    ])

    // Delivered history untouched, entry for entry: everything that existed
    // before the correction still exists, unmodified, same ids — and the ONLY
    // additions are the two correction lines.
    const entriesAfter = await allEntries(transferId)
    expect(entriesAfter.filter((e) => e.transition !== 'REFUNDED')).toEqual(entriesBefore)
    expect(entriesAfter.length).toBe(entriesBefore.length + 2)

    // The economics: a NEW expense, not a reversal. The fee stays EARNED
    // (fee_revenue is not debited back) and transfer_payable stays discharged
    // by delivery — the whole double-pay lands on the compliance-cost account,
    // which is what lets the ledger answer "what did Reg E cost us" directly.
    expect(await accountTotals(transferId)).toEqual({
      funding_receivable: S + FEE,
      transfer_payable: 0,
      fee_revenue: -FEE,
      due_from_bridge: 0,
      fx_slippage: A - S,
      bridge_wallet_float: -A,
      loss_cancellation_correction: S + FEE,
      cash_clearing: -(S + FEE),
    })

    // The request closed under the operator who paid it.
    expect(await requestRow(transferId)).toMatchObject({
      status: 'resolved_refunded',
      resolved_by: 'ops:dbtest',
    })
    // And the durable record of who moved the money is the transition actor.
    const transitions = await db.query(
      `select actor from public.transfer_transitions
        where transfer_id = $1 and from_state = 'UNDER_REVIEW' and to_state = 'REFUNDED'`,
      [transferId],
    )
    expect(transitions.rows).toEqual([{ actor: 'ops:dbtest' }])
  })

  it('a replay writes nothing: no second disbursement, no new entries, the first resolution stands', async () => {
    const transferId = await seedTransfer()
    await walkToCompletedWithRequest(transferId)
    await parkUnderReview(transferId)

    await refundCancellation({ transferId, operator: 'first' })
    const before = await countEntries(transferId)
    const refBefore = (
      await db.query('select refund_payment_ref from public.transfers where id = $1', [transferId])
    ).rows[0].refund_payment_ref
    refundCalls.length = 0

    await expect(
      refundCancellation({ transferId, operator: 'second' }),
    ).resolves.toEqual({ done: true, outcome: 'already_refunded' })

    expect(refundCalls).toHaveLength(0) // the money moved ONCE
    expect(await countEntries(transferId)).toBe(before)
    expect(
      (await db.query('select refund_payment_ref from public.transfers where id = $1', [transferId]))
        .rows[0].refund_payment_ref,
    ).toBe(refBefore)
    // resolve is guarded on pending: the second operator cannot overwrite the
    // first's closure.
    expect(await requestRow(transferId)).toMatchObject({
      status: 'resolved_refunded',
      resolved_by: 'ops:first',
    })
  })

  it('denies an UNDER_REVIEW request whose deposit preceded it: state back to COMPLETED, NO ledger', async () => {
    const transferId = await seedTransfer()
    const request = await walkToCompletedWithRequest(transferId)
    await parkUnderReview(transferId)

    const entriesBefore = await allEntries(transferId)
    // Bridge's dashboard timestamp, one minute BEFORE the ask: condition (2)
    // failed at request time, so denial is lawful despite within_window=true.
    const depositedAt = new Date(Date.parse(request.requested_at) - 60_000).toISOString()

    await expect(
      denyCancellation({ transferId, operator: 'dbtest', depositedAt }),
    ).resolves.toEqual({ done: true, outcome: 'denied' })

    const state = (
      await db.query('select state, refund_payment_ref from public.transfers where id = $1', [transferId])
    ).rows[0]
    expect(state.state).toBe('COMPLETED')
    expect(state.refund_payment_ref).toBeNull() // no money moved

    // NO ledger: the UNDER_REVIEW → COMPLETED transition posts nothing, and
    // nothing else did either — the books still say exactly "delivered".
    expect(await allEntries(transferId)).toEqual(entriesBefore)

    // The denial is provable later: the operator's evidence is on the
    // transition AND in the resolution text.
    const transition = await db.query(
      `select metadata from public.transfer_transitions
        where transfer_id = $1 and from_state = 'UNDER_REVIEW' and to_state = 'COMPLETED'`,
      [transferId],
    )
    expect(transition.rows).toHaveLength(1)
    expect(transition.rows[0].metadata).toMatchObject({ bridgeDepositedAt: depositedAt })
    const closed = await requestRow(transferId)
    expect(closed).toMatchObject({ status: 'resolved_denied', resolved_by: 'ops:dbtest' })
    expect(closed.resolution).toContain(depositedAt)
    expect(closed.resolution).toContain(request.requested_at)
  })

  it('REFUSES to deny a request that beat the cited deposit, writing nothing (the legal guard, on real rows)', async () => {
    const transferId = await seedTransfer()
    const request = await walkToCompletedWithRequest(transferId)
    await parkUnderReview(transferId)

    const depositedAt = new Date(Date.parse(request.requested_at) + 60_000).toISOString()

    await expect(
      denyCancellation({ transferId, operator: 'dbtest', depositedAt }),
    ).resolves.toEqual({ done: false, reason: 'request_precedes_deposit' })

    // Nothing moved: still parked for the human, request still open.
    expect(
      (await db.query('select state from public.transfers where id = $1', [transferId])).rows[0]
        .state,
    ).toBe('UNDER_REVIEW')
    expect(await requestRow(transferId)).toMatchObject({ status: 'pending' })
  })

  it('denies a never-routed out-of-window request without touching state or ledger', async () => {
    // cancelable_until already past when the ask lands → within_window=false →
    // the job never routes it: the transfer sits at COMPLETED with an open
    // request awaiting a human denial.
    const transferId = await seedTransfer({ cancelableMinutes: -1 })
    const request = await walkToCompletedWithRequest(transferId)
    expect(request.within_window).toBe(false)

    const entriesBefore = await allEntries(transferId)
    const depositedAt = new Date().toISOString()

    await expect(
      denyCancellation({ transferId, operator: 'dbtest', depositedAt }),
    ).resolves.toEqual({ done: true, outcome: 'denied' })

    // No transition at all — the state was already correct.
    const transitions = await db.query(
      `select count(*)::int as n from public.transfer_transitions
        where transfer_id = $1 and (from_state = 'UNDER_REVIEW' or to_state = 'UNDER_REVIEW')`,
      [transferId],
    )
    expect(transitions.rows[0].n).toBe(0)
    expect(
      (await db.query('select state from public.transfers where id = $1', [transferId])).rows[0]
        .state,
    ).toBe('COMPLETED')
    expect(await allEntries(transferId)).toEqual(entriesBefore)
    const closed = await requestRow(transferId)
    expect(closed).toMatchObject({ status: 'resolved_denied', resolved_by: 'ops:dbtest' })
    // Out-of-window is provable from our own record; the resolution names that
    // ground, not the deposit-race one.
    expect(closed.resolution).toContain('after the Reg E window')
  })
})
