// Integration tests against a real local Supabase stack (Docker).
// Gated: RUN_DB_TESTS=1. Proves the slice-6 PR-2 refund tail at the DATABASE
// level: the full FUNDED → SUBMITTED → PAYOUT_FAILED → REFUNDED walk with the
// TWO distinct refund batches (bridge_return + REFUNDED) posting under distinct
// keys, every batch net-zero, per-account balances landing where the money
// went, fx_slippage from SUBMITTED staying realized (never reversed), and a
// replay of both refund posts adding nothing. Uses the production wrappers
// (transitionTransfer + postLedgerTransaction via PostgREST) — the same call
// path the payment-event.process job takes.
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
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

const runDb = process.env.RUN_DB_TESTS === '1'

const DB_URL = process.env.TEST_DB_URL ?? 'postgresql://postgres:postgres@127.0.0.1:54322/postgres'

const USER = '00000000-0000-4000-8000-00000000008a'
const T_REFUND = '00000000-0000-4000-8000-000000000081'

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
         fee_amount_minor, fee_currency, fx_rate, fx_rate_at, idempotency_key, state)
       values ($1, $2, $3, $4, ${S}, 'USD', 396014, 'MXN', ${FEE}, 'USD', 19.9997, now(), $5,
         'PENDING_PAYMENT')`,
      [transferId, USER, destinationId, quote.rows[0].id, `refund-tail-test-${transferId}`],
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

  // Walk to PAYOUT_FAILED, then drive the two-batch refund (as driveRefund does).
  const walkToRefunded = async (transferId: string) => {
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
    const countEntries = async () => {
      const res = await db.query(
        `select count(*)::int as n from public.ledger_entries e
          join public.ledger_transactions t on t.id = e.ledger_transaction_id
         where t.transfer_id = $1`,
        [T_REFUND],
      )
      return res.rows[0].n as number
    }
    const before = await countEntries()

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

    expect(await countEntries()).toBe(before)
  })
})
