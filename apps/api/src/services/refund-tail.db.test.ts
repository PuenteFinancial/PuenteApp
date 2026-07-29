// Integration tests against a real local Supabase stack (Docker).
// Gated: RUN_DB_TESTS=1. Proves the slice-6 PR-2 refund tail at the DATABASE
// level: the full FUNDED → SUBMITTED → PAYOUT_FAILED → REFUNDED walk with the
// TWO distinct refund batches (bridge_return + REFUNDED) posting under distinct
// keys, every batch net-zero, per-account balances landing where the money
// went, fx_slippage from SUBMITTED staying realized (never reversed), and a
// replay of both refund posts adding nothing. The T_REFUND walk posts the two
// batches BY HAND through the production wrappers (transitionTransfer +
// postLedgerTransaction via PostgREST), pinning the ledger shape independently
// of any service. The slice-7 PR6a tests (T_OPS) drive services/refunds.ts —
// the shared tail the job and the operator CLI both execute — and additionally
// pin the ops: actor, a second run writing nothing, and a refusal on a transfer
// that never failed.
//
// The slice-7 PR6b-0 tests (T_CLAIM) pin the refund CLAIM, which is the one
// guarantee no mocked test can establish: only real Postgres row locking
// serializes two runs that both read `refund_payment_ref is null`, and
// MockFundingProcessor.refund() ignores the idempotency key by design, so
// nothing downstream would dedupe a second payment.
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import { Client } from 'pg'
import {
  transitionTransfer,
  fundedLedgerEntries,
  bridgeReturnLedgerEntries,
  refundedLedgerEntries,
  type LedgerEntryJson,
} from './transfers.js'
import { submittedLedgerEntries } from './payouts.js'
import { postLedgerTransaction, type LedgerEntryInput } from './ledger.js'
import { refundPayoutFailure, releaseStaleRefundClaim } from './refunds.js'

// Count processor calls without changing processor BEHAVIOUR: the real
// MockFundingProcessor still runs, we just observe it. Without this the suite
// cannot see a double payment at all — the mock mints a fresh ref per call and
// the ref persist is null-gated, so two disbursements leave exactly the same
// database state as one, and "disbursed once" would be inferred only from the
// returned outcomes. A mutation moving the claim to AFTER the processor call
// survives every other assertion in this file.
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

const USER = '00000000-0000-4000-8000-00000000008a'
const T_REFUND = '00000000-0000-4000-8000-000000000081'
// slice-7 PR6a: the same tail driven through services/refunds.ts by an operator
// (AUTO_REFUND off — the service reads no flag; the gate lives at the caller).
const T_OPS = '00000000-0000-4000-8000-000000000082'
// slice-7 PR6b-0: the refund claim, proven against real Postgres row locking.
const T_CLAIM = '00000000-0000-4000-8000-000000000085'

const S = 19801 // quoted send principal
const FEE = 199
const A = 19855 // actual USDC draw (A > S → +54 unfavorable slippage)

const toInput = (entries: LedgerEntryJson[]): LedgerEntryInput[] =>
  entries.map((e) => ({
    accountCode: e.account_code,
    direction: e.direction,
    money: { amountMinor: e.amount_minor, currency: e.currency },
  }))

describe.skipIf(!runDb)('refund tail ledger walk (integration, local Supabase)', () => {
  let db: Client

  const seedFundedTransfer = async (transferId: string, destinationId: string) => {
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
         funding_payment_ref)
       values ($1, $2, $3, $4, ${S}, 'USD', 396014, 'MXN', ${FEE}, 'USD', 19.9997, now(), $5,
         'PENDING_PAYMENT', $6)`,
      [
        transferId,
        USER,
        destinationId,
        quote.rows[0].id,
        `refund-tail-test-${transferId}`,
        // Set at confirm in the real flow, so every transfer that can reach
        // PAYOUT_FAILED carries one. The tail refuses to disburse without it
        // rather than sending the processor an empty payment reference.
        `mockpay_${transferId}`,
      ],
    )
  }

  beforeAll(async () => {
    db = new Client({ connectionString: DB_URL })
    await db.connect()
    await db.query(
      `insert into auth.users (id, phone) values ($1, '15550000081') on conflict (id) do nothing`,
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
    await seedFundedTransfer(T_REFUND, destination.rows[0].id)
    await seedFundedTransfer(T_OPS, destination.rows[0].id)
  })

  afterAll(async () => {
    await db.query('truncate table public.ledger_entries, public.ledger_transactions cascade')
    await db.query('truncate table public.payment_events, public.transfer_transitions, public.disclosures')
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

  // FUNDED → SUBMITTED → PAYOUT_FAILED: the state a payout failure parks in,
  // whichever path drives the refund from there.
  const walkToPayoutFailed = async (transferId: string) => {
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
    await transitionTransfer({
      transferId,
      fromState: 'SUBMITTED',
      toState: 'PAYOUT_FAILED',
      actor: 'worker:payment-event',
    })
  }

  // Walk to PAYOUT_FAILED, then drive the two-batch refund the way
  // services/refunds.ts does — replicated by hand here on purpose, so the
  // ledger shape is asserted independently of the service under test.
  const walkToRefunded = async (transferId: string) => {
    await walkToPayoutFailed(transferId)
    // 1) bridge_return — stand-alone post, its own key {id}:bridge_return
    await postLedgerTransaction({
      transferId,
      transition: 'bridge_return',
      description: 'bridge returned principal on payout failure',
      entries: toInput(bridgeReturnLedgerEntries({ send_amount_minor: S })),
    })
    // 2) REFUNDED — a DISTINCT key {id}:REFUNDED, posted with the transition
    return transitionTransfer({
      transferId,
      fromState: 'PAYOUT_FAILED',
      toState: 'REFUNDED',
      actor: 'worker:payment-event',
      ledgerEntries: refundedLedgerEntries({ send_amount_minor: S, fee_amount_minor: FEE }),
    })
  }

  it('drives PAYOUT_FAILED → REFUNDED with two balanced batches; fx_slippage stays realized', async () => {
    const refunded = await walkToRefunded(T_REFUND)
    expect(refunded.state).toBe('REFUNDED')

    expect(await accountTotals(T_REFUND)).toEqual({
      funding_receivable: S + FEE, // still owed by the funding processor (settles independently)
      transfer_payable: 0, // recognized at FUNDED, extinguished at REFUNDED
      fee_revenue: 0, // recognized at FUNDED, reversed at REFUNDED (fee refunded per Reg E)
      due_from_bridge: 0, // opened at SUBMITTED, settled by bridge_return
      fx_slippage: A - S, // debit STAYS — the slippage is realized, never reversed
      bridge_wallet_float: -A, // USDC that left the treasury wallet at SUBMITTED
      cash_clearing: -FEE, // +S back from Bridge, −(S+F) refunded to sender = −F
    })

    // four posting batches (PAYOUT_FAILED posts nothing), each net-zero
    const perTx = await db.query(
      `select t.transition,
              sum(case when e.direction = 'debit' then e.amount_minor else -e.amount_minor end)::bigint as net
         from public.ledger_entries e
         join public.ledger_transactions t on t.id = e.ledger_transaction_id
        where t.transfer_id = $1 group by t.id, t.transition`,
      [T_REFUND],
    )
    expect(perTx.rows.length).toBe(4)
    for (const row of perTx.rows) expect(Number(row.net)).toBe(0)
    // both refund batches exist under DISTINCT keys
    expect(perTx.rows.map((r) => r.transition).sort()).toEqual(
      ['FUNDED', 'REFUNDED', 'SUBMITTED', 'bridge_return'].sort(),
    )
  })

  it('replaying both refund posts adds nothing (idempotent on the two distinct keys)', async () => {
    const before = await countEntries(T_REFUND)

    // replay bridge_return (same {id}:bridge_return key → ON CONFLICT DO NOTHING)
    await postLedgerTransaction({
      transferId: T_REFUND,
      transition: 'bridge_return',
      description: 'bridge returned principal on payout failure',
      entries: toInput(bridgeReturnLedgerEntries({ send_amount_minor: S })),
    })
    // replay the REFUNDED transition (already REFUNDED → RPC replay no-op)
    await expect(
      transitionTransfer({
        transferId: T_REFUND,
        fromState: 'PAYOUT_FAILED',
        toState: 'REFUNDED',
        actor: 'worker:payment-event',
        ledgerEntries: refundedLedgerEntries({ send_amount_minor: S, fee_amount_minor: FEE }),
      }),
    ).resolves.toMatchObject({ state: 'REFUNDED' })

    expect(await countEntries(T_REFUND)).toBe(before)
  })

  // slice-7 PR6a: the SAME tail driven by an operator through the shared service
  // while AUTO_REFUND is off (the service reads no flag — the gate is the
  // caller's). This is what scripts/trigger-refund.ts --confirm executes.
  it('an operator-triggered refund reaches REFUNDED with both batches and an ops: actor', async () => {
    await walkToPayoutFailed(T_OPS)

    await expect(
      refundPayoutFailure({
        transferId: T_OPS,
        actor: 'ops:jphelps',
        reason: 'operator-triggered refund — AUTO_REFUND off',
      }),
    ).resolves.toEqual({ done: true, outcome: 'refunded' })

    const transfer = await db.query(
      'select state, refund_payment_ref, refunded_at from public.transfers where id = $1',
      [T_OPS],
    )
    expect(transfer.rows[0].state).toBe('REFUNDED')
    // the sender was actually paid — not just marked refunded
    expect(transfer.rows[0].refund_payment_ref).toMatch(/^mockrefund_/)
    expect(transfer.rows[0].refunded_at).not.toBeNull()

    // transfer_transitions.actor is the ONLY durable record of who did this
    const transitions = await db.query(
      `select actor from public.transfer_transitions
        where transfer_id = $1 and to_state = 'REFUNDED'`,
      [T_OPS],
    )
    expect(transitions.rows.map((r) => r.actor)).toEqual(['ops:jphelps'])

    // same money as the automated path — the two implementations cannot diverge
    expect(await accountTotals(T_OPS)).toEqual({
      funding_receivable: S + FEE,
      transfer_payable: 0,
      fee_revenue: 0,
      due_from_bridge: 0,
      fx_slippage: A - S,
      bridge_wallet_float: -A,
      cash_clearing: -FEE,
    })

    const perTx = await db.query(
      `select t.transition,
              sum(case when e.direction = 'debit' then e.amount_minor else -e.amount_minor end)::bigint as net
         from public.ledger_entries e
         join public.ledger_transactions t on t.id = e.ledger_transaction_id
        where t.transfer_id = $1 group by t.id, t.transition`,
      [T_OPS],
    )
    for (const row of perTx.rows) expect(Number(row.net)).toBe(0)
    expect(perTx.rows.map((r) => r.transition).sort()).toEqual(
      ['FUNDED', 'REFUNDED', 'SUBMITTED', 'bridge_return'].sort(),
    )
  })

  it('a second operator run is a clean no-op — no second disbursement, no new entries', async () => {
    const before = await countEntries(T_OPS)
    const beforeRef = (
      await db.query('select refund_payment_ref from public.transfers where id = $1', [T_OPS])
    ).rows[0].refund_payment_ref

    await expect(
      refundPayoutFailure({ transferId: T_OPS, actor: 'ops:jphelps', reason: 'replay' }),
    ).resolves.toEqual({ done: true, outcome: 'already_settled' })

    expect(await countEntries(T_OPS)).toBe(before)
    expect(
      (await db.query('select refund_payment_ref from public.transfers where id = $1', [T_OPS]))
        .rows[0].refund_payment_ref,
    ).toBe(beforeRef)
  })

  // ── the refund claim (slice-7 PR6b-0) ────────────────────────────────────
  // The bug this exists for cannot be caught by a mocked test: two runs both
  // read `refund_payment_ref is null` and both disburse. Only a real Postgres
  // UPDATE serializes them, and MockFundingProcessor.refund() ignores the
  // idempotency key on purpose, so nothing downstream would dedupe the second
  // payment. Two genuinely concurrent calls, one sender, one disbursement.
  it('two concurrent runs disburse exactly ONCE and post exactly one set of batches', async () => {
    const destination = await db.query(
      `select pd.id from public.payout_destinations pd
         join public.recipients r on r.id = pd.recipient_id where r.user_id = $1 limit 1`,
      [USER],
    )
    await seedFundedTransfer(T_CLAIM, destination.rows[0].id)
    await walkToPayoutFailed(T_CLAIM)

    refundCalls.length = 0
    const results = await Promise.all([
      refundPayoutFailure({ transferId: T_CLAIM, actor: 'ops:one', reason: 'race' }),
      refundPayoutFailure({ transferId: T_CLAIM, actor: 'worker:payment-event', reason: 'race' }),
    ])

    // Exactly one winner; the loser refuses rather than reporting a refund it
    // did not make. (Either may win — assert the shape, not the order.)
    // EXACTLY ONE run may report that it moved the money. Three loser
    // outcomes, all non-writing:
    //   claim_taken       — the winner is still mid-flight
    //   already_settled   — the winner finished before the loser's re-read
    //   already_disbursed — the winner's ref persist landed before the loser's
    //     FIRST load (observed ~1-in-12 under the full-suite run, where the
    //     shared PostgREST connection pool can serialize the loser's initial
    //     read behind the winner's whole disbursement; 4th sighting 2026-07-29,
    //     accepted per the watch-item's plan of record). The loser then takes
    //     the crash-recovery-heal path: its transition is a replay no-op that
    //     writes nothing. The invariants that matter are pinned below either
    //     way — ONE processor call, ONE transition row, the winner's actor.
    const outcomes = results.map((r) => (r.done ? r.outcome : r.reason))
    expect(outcomes.filter((o) => o === 'refunded')).toHaveLength(1)
    const loser = outcomes.find((o) => o !== 'refunded')!
    expect(['claim_taken', 'already_settled', 'already_disbursed']).toContain(loser)

    // THE invariant, and the only assertion here that can see a double payment:
    // the sender's money left our processor exactly once. Everything else in
    // this test observes database state, which looks identical whether the
    // processor was called once or twice.
    expect(refundCalls).toHaveLength(1)

    const transitions = await db.query(
      `select actor from public.transfer_transitions
        where transfer_id = $1 and to_state = 'REFUNDED'`,
      [T_CLAIM],
    )
    expect(transitions.rows).toHaveLength(1)

    const row = (
      await db.query(
        'select refund_payment_ref, refund_claimed_at, refund_claimed_by, state from public.transfers where id = $1',
        [T_CLAIM],
      )
    ).rows[0]
    expect(row.refund_payment_ref).toMatch(/^mockrefund_/)
    expect(row.state).toBe('REFUNDED')
    // The claim is kept after success, not cleared: it is the record of when
    // the money left, and refund_payment_ref is what gates from here on.
    expect(row.refund_claimed_at).not.toBeNull()
    expect(['ops:one', 'worker:payment-event']).toContain(row.refund_claimed_by)

    const perTx = await db.query(
      `select t.transition, count(*)::int as n
         from public.ledger_transactions t where t.transfer_id = $1 group by t.transition`,
      [T_CLAIM],
    )
    for (const r of perTx.rows) expect(r.n).toBe(1)
    expect(perTx.rows.map((r) => r.transition).sort()).toEqual(
      ['FUNDED', 'REFUNDED', 'SUBMITTED', 'bridge_return'].sort(),
    )
  })

  it('lifecycle claim columns are writable — the frozen-terms trigger does not guard them', async () => {
    // Same class as submit_attempted_at / refunded_at. If the trigger ever grew
    // to cover these, every claim would raise instead of gating a refund.
    // `.resolves.toBeDefined()` would pass on any resolution — assert the write
    // actually landed on the row.
    const updated = await db.query(
      `update public.transfers set refund_claimed_at = now(), refund_claimed_by = 'ops:x'
        where id = $1 returning refund_claimed_by`,
      [T_OPS],
    )
    expect(updated.rows).toHaveLength(1)
    expect(updated.rows[0].refund_claimed_by).toBe('ops:x')
    await db.query(
      `update public.transfers set refund_claimed_at = null, refund_claimed_by = null where id = $1`,
      [T_OPS],
    )
  })

  it('releaseStaleRefundClaim clears an abandoned claim but never a live one', async () => {
    const target = '00000000-0000-4000-8000-000000000084'
    const destination = await db.query(
      `select pd.id from public.payout_destinations pd
         join public.recipients r on r.id = pd.recipient_id where r.user_id = $1 limit 1`,
      [USER],
    )
    await seedFundedTransfer(target, destination.rows[0].id)

    const claimedAt = async (): Promise<string | null> =>
      (await db.query('select refund_claimed_at from public.transfers where id = $1', [target]))
        .rows[0].refund_claimed_at

    // Live claim (just inside the 10-min CLAIM_STALE_AFTER_MS window): a run
    // may be mid-disbursement, so clearing it would let a second payment go
    // out underneath it.
    await db.query(
      `update public.transfers set refund_claimed_at = now() - interval '9 minutes',
         refund_claimed_by = 'ops:x' where id = $1`,
      [target],
    )
    await expect(releaseStaleRefundClaim(target)).resolves.toBe(false)
    expect(await claimedAt()).not.toBeNull()

    // Abandoned (just past the window): nobody is coming back for it.
    await db.query(
      `update public.transfers set refund_claimed_at = now() - interval '11 minutes' where id = $1`,
      [target],
    )
    await expect(releaseStaleRefundClaim(target)).resolves.toBe(true)
    expect(await claimedAt()).toBeNull()

    // A recorded disbursement is untouchable at any age — the money is out.
    await db.query(
      `update public.transfers set refund_claimed_at = now() - interval '99 minutes',
         refund_payment_ref = 'mockrefund_already' where id = $1`,
      [target],
    )
    await expect(releaseStaleRefundClaim(target)).resolves.toBe(false)
    expect(await claimedAt()).not.toBeNull()
  })

  it('refuses a transfer that never failed and writes nothing', async () => {
    // A fresh PENDING_PAYMENT transfer stands in for the case that matters most:
    // a transfer an operator must never be able to "refund" through this path.
    const other = '00000000-0000-4000-8000-000000000083'
    const destination = await db.query(
      `select pd.id from public.payout_destinations pd
         join public.recipients r on r.id = pd.recipient_id where r.user_id = $1 limit 1`,
      [USER],
    )
    await seedFundedTransfer(other, destination.rows[0].id)

    await expect(
      refundPayoutFailure({ transferId: other, actor: 'ops:jphelps', reason: 'x' }),
    ).resolves.toEqual({ done: false, reason: 'not_payout_failed', state: 'PENDING_PAYMENT' })

    expect(await countEntries(other)).toBe(0)
  })
})
