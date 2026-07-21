// Integration tests against a real local Supabase stack (Docker).
// Gated: RUN_DB_TESTS=1. Proves the slice-5 PR-2 money path at the DATABASE
// level: the full FUNDED → SUBMITTED → IN_FLIGHT → COMPLETED walk through
// transition_transfer v2 with the real ledger batches, for both slippage
// signs, asserting per-account debit/credit totals and per-transaction
// net-zero. Uses the production wrapper (transitionTransfer via PostgREST) —
// the same call path the worker takes.
//
// Transfers are inserted directly in FUNDED with fixed ids (the frozen-terms
// trigger fires only on UPDATE); the FUNDED ledger batch is posted through
// the transition RPC's replay-safe posting key by transitioning
// PENDING_PAYMENT → FUNDED first.
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { Client } from 'pg'
import {
  transitionTransfer,
  fundedLedgerEntries,
  completedLedgerEntries,
} from './transfers.js'
import { submittedLedgerEntries } from './payouts.js'

const runDb = process.env.RUN_DB_TESTS === '1'

const DB_URL = process.env.TEST_DB_URL ?? 'postgresql://postgres:postgres@127.0.0.1:54322/postgres'

// Fixed UUIDs in the …006x block — no collisions with the other db tests
const USER = '00000000-0000-4000-8000-00000000006a'
const T_UNFAV = '00000000-0000-4000-8000-000000000061' // A > S: unfavorable slippage
const T_FAV = '00000000-0000-4000-8000-000000000062' // A < S: favorable slippage

const S = 19801 // quoted send principal
const FEE = 199

describe.skipIf(!runDb)('payout ledger walk (integration, local Supabase)', () => {
  let db: Client

  const seedPendingTransfer = async (transferId: string, destinationId: string) => {
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
         fee_amount_minor, fee_currency, fx_rate, fx_rate_at, idempotency_key, state)
       values ($1, $2, $3, $4, ${S}, 'USD', 396014, 'MXN', ${FEE}, 'USD', 19.9997, now(), $5,
         'PENDING_PAYMENT')`,
      [transferId, USER, destinationId, quote.rows[0].id, `payout-ledger-test-${transferId}`],
    )
  }

  beforeAll(async () => {
    db = new Client({ connectionString: DB_URL })
    await db.connect()
    await db.query(
      `insert into auth.users (id, phone) values ($1, '15550000061') on conflict (id) do nothing`,
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
    for (const id of [T_UNFAV, T_FAV]) await seedPendingTransfer(id, destination.rows[0].id)
  })

  afterAll(async () => {
    await db.query('truncate table public.ledger_entries, public.ledger_transactions cascade')
    await db.query('truncate table public.payment_events, public.transfer_transitions')
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

  // Per-account signed totals (debits − credits) for one transfer's postings.
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

  const walk = async (transferId: string, actualSourceAmountMinor: number) => {
    await transitionTransfer({
      transferId,
      fromState: 'PENDING_PAYMENT',
      toState: 'FUNDED',
      actor: 'webhook:funding',
      ledgerEntries: fundedLedgerEntries({ send_amount_minor: S, fee_amount_minor: FEE }),
    })
    const submitted = await transitionTransfer({
      transferId,
      fromState: 'FUNDED',
      toState: 'SUBMITTED',
      actor: 'worker:payout',
      providerTransferRef: `bridge_ref_${transferId}`,
      ledgerEntries: submittedLedgerEntries({ sendAmountMinor: S, actualSourceAmountMinor }),
    })
    expect(submitted.provider_transfer_ref).toBe(`bridge_ref_${transferId}`)
    await transitionTransfer({
      transferId,
      fromState: 'SUBMITTED',
      toState: 'IN_FLIGHT',
      actor: 'webhook:bridge',
    })
    const completed = await transitionTransfer({
      transferId,
      fromState: 'IN_FLIGHT',
      toState: 'COMPLETED',
      actor: 'webhook:bridge',
      ledgerEntries: completedLedgerEntries({ send_amount_minor: S }),
    })
    expect(completed.state).toBe('COMPLETED')
    expect(completed.completed_at).not.toBeNull()
  }

  it('unfavorable slippage (A > S): full walk, balances land where the money went', async () => {
    const A = 19855 // D = +54
    await walk(T_UNFAV, A)

    const totals = await accountTotals(T_UNFAV)
    expect(totals).toEqual({
      funding_receivable: S + FEE, // still owed by the funding processor
      transfer_payable: 0, // recognized at FUNDED, extinguished at COMPLETED
      fee_revenue: -FEE, // credit-normal: our fee
      due_from_bridge: 0, // recognized at SUBMITTED, extinguished at COMPLETED
      fx_slippage: A - S, // debit: the extra USDC the payout cost us
      bridge_wallet_float: -A, // credit: USDC that left the treasury wallet
    })

    // Every transaction in the walk nets to zero — the DB-level invariant.
    const perTx = await db.query(
      `select t.id, sum(case when e.direction = 'debit' then e.amount_minor else -e.amount_minor end)::bigint as net
         from public.ledger_entries e
         join public.ledger_transactions t on t.id = e.ledger_transaction_id
        where t.transfer_id = $1 group by t.id`,
      [T_UNFAV],
    )
    expect(perTx.rows.length).toBe(3) // FUNDED, SUBMITTED, COMPLETED (IN_FLIGHT posts nothing)
    for (const row of perTx.rows) expect(Number(row.net)).toBe(0)
  })

  it('favorable slippage (A < S): fx_slippage carries a credit balance', async () => {
    const A = 19750 // D = −51
    await walk(T_FAV, A)

    const totals = await accountTotals(T_FAV)
    expect(totals).toEqual({
      funding_receivable: S + FEE,
      transfer_payable: 0,
      fee_revenue: -FEE,
      due_from_bridge: 0,
      fx_slippage: A - S, // negative: favorable drift is a credit
      bridge_wallet_float: -A,
    })
  })

  it('replaying the SUBMITTED transition posts nothing twice', async () => {
    const before = await db.query(
      `select count(*)::int as n from public.ledger_entries e
        join public.ledger_transactions t on t.id = e.ledger_transaction_id
       where t.transfer_id = $1`,
      [T_UNFAV],
    )
    // Same call the crash-recovery path makes: state is COMPLETED now, but a
    // stale FUNDED→SUBMITTED replay must not conflict into double-posting.
    await expect(
      transitionTransfer({
        transferId: T_UNFAV,
        fromState: 'IN_FLIGHT',
        toState: 'COMPLETED',
        actor: 'webhook:bridge',
        ledgerEntries: completedLedgerEntries({ send_amount_minor: S }),
      }),
    ).resolves.toMatchObject({ state: 'COMPLETED' })
    const after = await db.query(
      `select count(*)::int as n from public.ledger_entries e
        join public.ledger_transactions t on t.id = e.ledger_transaction_id
       where t.transfer_id = $1`,
      [T_UNFAV],
    )
    expect(after.rows[0].n).toBe(before.rows[0].n)
  })
})
