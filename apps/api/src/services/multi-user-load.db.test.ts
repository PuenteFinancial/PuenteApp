// Multi-user volume + reconciliation integration test (local Supabase, Docker).
// Gated: RUN_DB_TESTS=1.
//
// THE QUESTION THIS ANSWERS: after many senders each move money several times,
// concurrently, do the books still reconcile? Every other db suite drives ONE
// transfer down one path. This one drives N senders × M sends through the real
// lifecycle at the same time and then runs the ACTUAL reconciliation checks —
// the same `buildChecks()` the daily cron runs — and requires every fatal check
// to come back with nothing.
//
// It is deliberately NOT a performance test. At five trusted users, throughput
// is not the risk; the risk is a race that leaves the ledger a few cents wrong
// in a way nobody notices for a month. So the shape is CONTENTION, not volume:
// users run in parallel so their postings interleave on the same shared
// accounts (cash_clearing, transfer_payable, due_from_bridge, the float), while
// each user's own sends run in sequence because that is what a real sender
// does — and because the per-user risk caps (RISK_UNCLEARED_MAX_COUNT = 1) make
// parallel sends by ONE user a different test.
//
// Production code drives every transition: applyFundingSucceeded, the real
// submitPayout with its whole gate chain, transitionTransfer's RPC. Only the
// two external providers are faked. Nothing here re-implements a ledger rule,
// which is the point — a test that recomputed the postings would agree with
// itself and prove nothing. The recon checks are the oracle.
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import { Client } from 'pg'
import { randomUUID } from 'node:crypto'

const runDb = process.env.RUN_DB_TESTS === '1'
const DB_URL =
  process.env.SUPABASE_DB_URL ?? 'postgresql://postgres:postgres@127.0.0.1:54322/postgres'

const USER_COUNT = 5
const SENDS_PER_USER = 4
const SEND_MINOR = 10_000 // $100
const FEE_MINOR = 200 // $2
const RECEIVE_MINOR = 1_999_970

// Set HERE, not in test/setup.ts, and deliberately so. `isFloatCeilingTripped`
// throws when FLOAT_CEILING_MINOR is unset — it refuses to submit payouts with
// the control missing — and that fail-closed behaviour is worth keeping for
// every other suite. This one needs payouts to actually run, so it opts in
// explicitly: $10,000 against $2,000 of draw (20 sends × $100) is headroom, and
// whether the ceiling TRIPS is float-ceiling-concurrency.db.test.ts's job.
//
// Plain `=`, not `??=`: vitest isolates the module registry per file but NOT
// process.env, so a sibling db file that ran first would otherwise pin this
// suite's ceiling to ITS value. Each file declares its own; order stops
// mattering.
process.env.FLOAT_CEILING_MINOR = '1000000'
// Same reasoning: submitPayout refuses outright without a treasury wallet
// rather than guessing one. Mocked Bridge never reads it, but the guard is
// real and this suite has to satisfy it like production does.
process.env.BRIDGE_TREASURY_WALLET_ID = 'wallet_load_test'

// ── the two external providers, and only those ──────────────────────────────
// Bridge accepts every payout and draws the source amount 1% over the send —
// the real destination-fixed draw buffer, so `fx_slippage` is exercised rather
// than left at zero (a slippage-free run would not prove SUBMITTED's postings
// balance when they carry a third line).
const bridgeCalls: string[] = []
vi.mock('./bridge.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./bridge.js')>()
  return {
    ...actual,
    createBridgePayout: async (input: { idempotencyKey: string; sourceAmountMinor?: number }) => {
      bridgeCalls.push(input.idempotencyKey)
      return {
        bridgeTransferId: `bridge_${randomUUID()}`,
        state: 'payment_submitted',
        // 1% over the send leg, two decimals — the documented draw buffer.
        sourceAmount: (Math.round(SEND_MINOR * 1.01) / 100).toFixed(2),
      }
    },
    // Live rate pinned to the seeded quote's source_rate so the FX drift
    // backstop never trips. Drift is its own test's job, not this one's.
    getExchangeRate: async () => ({
      midmarketRate: '20.100251',
      buyRate: '20.100251',
      sellRate: '20.100251',
      updatedAt: new Date().toISOString(),
    }),
    listBridgeTransfers: async () => [],
    getBridgeWalletBalances: async () => [],
  }
})

const { applyFundingSucceeded, applyFundingCleared } = await import('./funding-apply.js')
const { transitionTransfer, completedLedgerEntries } = await import('./transfers.js')
const { submitPayout } = await import('../jobs/payout-submit.js')
const { buildChecks } = await import('./reconciliation.js')
const { recordFloatTopUp } = await import('./payouts.js')

// Reconciliation checks read GLOBAL state, so asserting "the database is
// clean" makes this suite hostage to every other suite's residue — which is
// exactly how it first failed (cancellations.db.test.ts was leaking 11
// transfers per run). The honest claim is narrower and more useful: OUR
// activity introduced no findings. Snapshot before, compare after.
const fatalFindingKeys = async (): Promise<string[]> => {
  const keys: string[] = []
  for (const check of buildChecks().filter((c) => c.severity === 'fatal')) {
    const { findings } = await check.run()
    keys.push(...findings.map((f) => `${check.name}:${f.key}`))
  }
  return keys
}

interface Sender {
  userId: string
  destinationId: string
  transferIds: string[]
}

// Phones are unique per RUN, not per user index. `users_phone_key` is a unique
// constraint, so a fixed block collides with whatever a previous crashed run
// left behind — and a suite that cannot survive its own residue fails for the
// wrong reason and teaches nothing.
const RUN = Math.floor(Math.random() * 9000) + 1000
const phoneFor = (u: number) => `1555${RUN}${String(u).padStart(3, '0')}`

describe.skipIf(!runDb)('multi-user volume: the books still reconcile (integration)', () => {
  let db: Client
  let baselineFindings: string[] = []
  const senders: Sender[] = []

  const seedPendingTransfer = async (sender: Sender, n: number): Promise<string> => {
    const transferId = randomUUID()
    const quote = await db.query(
      `insert into public.quotes (user_id, payout_destination_id, send_amount_minor, send_currency,
         receive_amount_minor, receive_currency, fee_amount_minor, fee_currency,
         fx_rate, source_rate, fx_rate_at, expires_at, status)
       values ($1, $2, ${SEND_MINOR}, 'USD', ${RECEIVE_MINOR}, 'MXN', ${FEE_MINOR}, 'USD',
         19.9997, 20.100251, now(), now() + interval '15 minutes', 'consumed') returning id`,
      [sender.userId, sender.destinationId],
    )
    await db.query(
      `insert into public.transfers (id, user_id, payout_destination_id, quote_id,
         send_amount_minor, send_currency, receive_amount_minor, receive_currency,
         fee_amount_minor, fee_currency, fx_rate, fx_rate_at, idempotency_key, state,
         funding_payment_ref)
       values ($1, $2, $3, $4, ${SEND_MINOR}, 'USD', ${RECEIVE_MINOR}, 'MXN', ${FEE_MINOR}, 'USD',
         19.9997, now(), $5, 'PENDING_PAYMENT', $6)`,
      [
        transferId,
        sender.userId,
        sender.destinationId,
        quote.rows[0].id,
        `load-test-${transferId}-${n}`,
        `mockpay_${transferId}`,
      ],
    )
    return transferId
  }

  // One sender's whole lifecycle for one transfer, through production code.
  const driveOne = async (transferId: string): Promise<void> => {
    const funded = await applyFundingSucceeded({
      transferId,
      paymentRef: `mockpay_${transferId}`,
      eventId: `evt_${transferId}`,
      actor: 'load-test',
    })
    if (funded.outcome !== 'applied') {
      throw new Error(`funding did not apply for ${transferId}: ${funded.outcome}`)
    }

    // The REAL submit, with its whole gate chain — holds, payability, float
    // ceiling, FX backstop, and the atomic claim that is the thing most likely
    // to misbehave when five of these run at once.
    const submitted = await submitPayout(transferId)
    if (submitted !== 1) throw new Error(`submit did not run for ${transferId} (got ${submitted})`)

    await transitionTransfer({
      transferId,
      fromState: 'SUBMITTED',
      toState: 'IN_FLIGHT',
      actor: 'load-test',
      reason: 'bridge payment_submitted',
    })
    await transitionTransfer({
      transferId,
      fromState: 'IN_FLIGHT',
      toState: 'COMPLETED',
      actor: 'load-test',
      reason: 'bridge payment_processed',
      ledgerDescription: 'transfer COMPLETED',
      ledgerEntries: completedLedgerEntries({
        send_amount_minor: SEND_MINOR,
        fee_amount_minor: FEE_MINOR,
        margin_minor: 0,
      }),
    })
    // The ACH leg settling later — the second half of the money story, and the
    // one that leaves funding_receivable open if it never runs.
    await applyFundingCleared({ transferId })
  }

  beforeAll(async () => {
    db = new Client({ connectionString: DB_URL })
    await db.connect()

    // PREFUND THE TREASURY, because production does. Payouts draw USDC from a
    // pre-funded Bridge wallet; without a top-up the float account simply goes
    // negative and reconciliation says so — which is exactly what happened the
    // first time this suite ran (`negative-balance:bridge_wallet_float`,
    // -$2,020, the precise total drawn). That was the check working, not a bug,
    // and modelling the real precondition is the fix. $5,000 against $2,020 of
    // draw (20 sends × $100 plus Bridge's ~1% destination-fixed buffer).
    await recordFloatTopUp({ amountMinor: 500_000, externalRef: `load-test-prefund-${RUN}` })

    for (let u = 0; u < USER_COUNT; u++) {
      const userId = randomUUID()
      await db.query(
        `insert into auth.users (id, phone) values ($1, $2) on conflict (id) do nothing`,
        [userId, phoneFor(u)],
      )
      // Approved with a Bridge customer: submitPayout's K6 backstop refuses to
      // send on behalf of a sender Bridge has not approved.
      await db.query(
        `insert into public.users (id, phone, kyc_status, bridge_customer_id)
         values ($1, $2, 'approved', $3)
         on conflict (id) do update set kyc_status = 'approved',
           bridge_customer_id = excluded.bridge_customer_id`,
        [userId, phoneFor(u), `bridge_cust_${u}`],
      )
      const recipient = await db.query(
        `insert into public.recipients (user_id, first_name, last_name, relationship, country)
         values ($1, 'Ana', 'García López', 'mother', 'MX') returning id`,
        [userId],
      )
      const destination = await db.query(
        `insert into public.payout_destinations (recipient_id, method, currency, details,
           provider_account_ref)
         values ($1, 'bank_account', 'MXN', '{}', $2) returning id`,
        [recipient.rows[0].id, `bridge_ext_${u}`],
      )
      const sender: Sender = {
        userId,
        destinationId: destination.rows[0].id,
        transferIds: [],
      }
      for (let n = 0; n < SENDS_PER_USER; n++) {
        sender.transferIds.push(await seedPendingTransfer(sender, n))
      }
      senders.push(sender)
    }

    // Taken AFTER seeding and BEFORE any money moves: anything already flagged
    // belongs to someone else and is not this suite's to fix.
    baselineFindings = await fatalFindingKeys()
  })

  afterAll(async () => {
    if (!db) return
    const userIds = senders.map((s) => s.userId)
    await db.query('truncate table public.ledger_entries, public.ledger_transactions cascade')
    await db.query(
      'truncate table public.payment_events, public.transfer_transitions, public.disclosures',
    )
    await db.query('delete from public.transfers where user_id = any($1)', [userIds])
    await db.query('delete from public.quotes where user_id = any($1)', [userIds])
    await db.query(
      `delete from public.payout_destinations where recipient_id in
         (select id from public.recipients where user_id = any($1))`,
      [userIds],
    )
    await db.query('delete from public.recipients where user_id = any($1)', [userIds])
    await db.query('delete from public.users where id = any($1)', [userIds])
    await db.query('delete from auth.users where id = any($1)', [userIds])
    await db.end()
  })

  it(`reconciles cleanly after ${USER_COUNT} senders × ${SENDS_PER_USER} completed sends`, async () => {
    // Senders in PARALLEL, each sender's own sends in SEQUENCE. The parallelism
    // is the test: five lifecycles interleaving on the same shared ledger
    // accounts, each posting five batches, is where a lost update or a
    // half-applied transition would show up.
    await Promise.all(
      senders.map(async (sender) => {
        for (const transferId of sender.transferIds) {
          await driveOne(transferId)
        }
      }),
    )

    const total = USER_COUNT * SENDS_PER_USER
    const completed = await db.query(
      `select count(*)::int as n from public.transfers
        where user_id = any($1) and state = 'COMPLETED'`,
      [senders.map((s) => s.userId)],
    )
    expect(completed.rows[0].n).toBe(total)

    // Bridge saw exactly one payout per transfer — no double submission under
    // concurrency, which the atomic claim is what guarantees.
    expect(bridgeCalls.length).toBe(total)
    expect(new Set(bridgeCalls).size).toBe(total)

    // ── the oracle: the real reconciliation, not a re-implementation ────────
    // Fatal checks are the money-correctness ones: every batch nets zero, no
    // batch is a single dangling entry, every state posted what its transition
    // owes, and the account balances hold their invariants.
    expect(buildChecks().filter((c) => c.severity === 'fatal').length).toBeGreaterThanOrEqual(4)
    const introduced = (await fatalFindingKeys()).filter((k) => !baselineFindings.includes(k))
    expect(introduced, `20 completed sends introduced reconciliation findings`).toEqual([])
  })

  it('is replay-safe at volume: re-driving every funded transfer posts nothing new', async () => {
    const before = await db.query('select count(*)::int as n from public.ledger_transactions')
    const bridgeBefore = bridgeCalls.length

    // Every transfer is COMPLETED now. Replaying funding and submit — a
    // duplicate webhook, a re-enqueued job, a crash-recovery sweep — must be
    // inert. Fired all at once, because a replay storm is exactly how this
    // arrives in production.
    await Promise.all(
      senders.flatMap((sender) =>
        sender.transferIds.map(async (transferId) => {
          await applyFundingSucceeded({
            transferId,
            paymentRef: `mockpay_${transferId}`,
            eventId: `evt_${transferId}`,
            actor: 'load-test-replay',
          })
          await submitPayout(transferId)
        }),
      ),
    )

    const after = await db.query('select count(*)::int as n from public.ledger_transactions')
    expect(after.rows[0].n).toBe(before.rows[0].n)
    expect(bridgeCalls.length).toBe(bridgeBefore)

    const introduced = (await fatalFindingKeys()).filter((k) => !baselineFindings.includes(k))
    expect(introduced, 'the replay storm introduced reconciliation findings').toEqual([])
  })
})
