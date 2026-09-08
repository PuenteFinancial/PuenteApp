// The float ceiling under concurrency (local Supabase, Docker). RUN_DB_TESTS=1.
//
// The float ceiling is the backstop on how much money can be in the air at
// once: `funding_receivable` is what we have fronted and not yet collected, and
// past FLOAT_CEILING_MINOR the submit job stops sending. It is deliberately NOT
// a hold — it pages a warning and returns 0, and the 1-minute sweep retries as
// the balance drains (payout-submit.ts, "self-healing backpressure").
//
// WHY THIS FILE EXISTS SEPARATELY: `isFloatCeilingTripped` reads a balance and
// then the caller acts on it, which is the shape of a check-then-act race, and
// the multi-user suite deliberately runs with a ceiling too high to ever trip.
// So the control's actual behaviour under load was untested. Two questions:
// does it stop payouts when it should, and does it let them through again once
// the exposure drains?
//
// ON THE RACE ITSELF — worth writing down, because the obvious worry turns out
// not to be the real one. Several concurrent submits DO all read the same
// balance and reach the same verdict. But submitting does not change
// `funding_receivable`; FUNDING does, at the PENDING_PAYMENT → FUNDED
// transition. So concurrent submits cannot drive each other over the line, and
// there is no lost update to find. The residual window is narrower: a funding
// event landing between one submit's read and its Bridge POST lets that single
// payout through at a balance now over the ceiling. That is bounded by
// in-flight concurrency, it is a soft advisory control by design, and it
// self-heals — so it is documented here rather than asserted as a bound, which
// would only produce a flaky test that encodes today's timing.
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import { Client } from 'pg'
import { randomUUID } from 'node:crypto'

const runDb = process.env.RUN_DB_TESTS === '1'
const DB_URL =
  process.env.SUPABASE_DB_URL ?? 'postgresql://postgres:postgres@127.0.0.1:54322/postgres'

const SEND_MINOR = 10_000 // $100
const FEE_MINOR = 200 // $2
const RECEIVE_MINOR = 1_999_970
const TRANSFERS = 5
// Each FUNDED transfer puts send+fee ($102) into funding_receivable, so five
// of them sit at $510. A $250 ceiling is comfortably breached by the third —
// tight on purpose, because a ceiling that never trips proves nothing.
// Plain `=` for the same reason as the multi-user suite: process.env survives
// across test files even though the module registry does not.
process.env.FLOAT_CEILING_MINOR = '25000'
process.env.BRIDGE_TREASURY_WALLET_ID = 'wallet_ceiling_test'

const bridgeCalls: string[] = []
vi.mock('./bridge.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./bridge.js')>()
  return {
    ...actual,
    createBridgePayout: async (input: { idempotencyKey: string }) => {
      bridgeCalls.push(input.idempotencyKey)
      return {
        bridgeTransferId: `bridge_${randomUUID()}`,
        state: 'payment_submitted',
        sourceAmount: (Math.round(SEND_MINOR * 1.01) / 100).toFixed(2),
      }
    },
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
const { submitPayout } = await import('../jobs/payout-submit.js')
const { getAccountBalance } = await import('./ledger.js')
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

const RUN = Math.floor(Math.random() * 9000) + 1000

describe.skipIf(!runDb)('float ceiling under concurrent submits (integration)', () => {
  let db: Client
  let userId: string
  let baselineFindings: string[] = []
  const transferIds: string[] = []

  beforeAll(async () => {
    db = new Client({ connectionString: DB_URL })
    await db.connect()
    userId = randomUUID()
    const phone = `1555${RUN}900`
    await db.query(
      `insert into auth.users (id, phone) values ($1, $2) on conflict (id) do nothing`,
      [userId, phone],
    )
    await db.query(
      `insert into public.users (id, phone, kyc_status, bridge_customer_id)
       values ($1, $2, 'approved', $3)
       -- The on-auth-user-created trigger already inserted this row, so the
       -- CONFLICT path is the one that runs: it has to set the customer id too,
       -- or submitPayout's K6 backstop throws on a sender Bridge never approved.
       on conflict (id) do update set kyc_status = 'approved',
         bridge_customer_id = excluded.bridge_customer_id`,
      [userId, phone, `bridge_cust_ceiling_${RUN}`],
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
      [recipient.rows[0].id, `bridge_ext_ceiling_${RUN}`],
    )
    // Treasury has plenty — this suite is about the RECEIVABLE ceiling, not an
    // empty wallet, and an underfunded float would fail for the wrong reason.
    await recordFloatTopUp({ amountMinor: 500_000, externalRef: `ceiling-prefund-${RUN}` })

    for (let n = 0; n < TRANSFERS; n++) {
      const transferId = randomUUID()
      const quote = await db.query(
        `insert into public.quotes (user_id, payout_destination_id, send_amount_minor,
           send_currency, receive_amount_minor, receive_currency, fee_amount_minor, fee_currency,
           fx_rate, source_rate, fx_rate_at, expires_at, status)
         values ($1, $2, ${SEND_MINOR}, 'USD', ${RECEIVE_MINOR}, 'MXN', ${FEE_MINOR}, 'USD',
           19.9997, 20.100251, now(), now() + interval '15 minutes', 'consumed') returning id`,
        [userId, destination.rows[0].id],
      )
      await db.query(
        `insert into public.transfers (id, user_id, payout_destination_id, quote_id,
           send_amount_minor, send_currency, receive_amount_minor, receive_currency,
           fee_amount_minor, fee_currency, fx_rate, fx_rate_at, idempotency_key, state,
           funding_payment_ref)
         values ($1, $2, $3, $4, ${SEND_MINOR}, 'USD', ${RECEIVE_MINOR}, 'MXN', ${FEE_MINOR},
           'USD', 19.9997, now(), $5, 'PENDING_PAYMENT', $6)`,
        [
          transferId,
          userId,
          destination.rows[0].id,
          quote.rows[0].id,
          `ceiling-test-${transferId}`,
          `mockpay_${transferId}`,
        ],
      )
      transferIds.push(transferId)
    }
    baselineFindings = await fatalFindingKeys()
  })

  afterAll(async () => {
    if (!db) return
    await db.query('truncate table public.ledger_entries, public.ledger_transactions cascade')
    await db.query(
      'truncate table public.payment_events, public.transfer_transitions, public.disclosures',
    )
    await db.query('delete from public.transfers where user_id = $1', [userId])
    await db.query('delete from public.quotes where user_id = $1', [userId])
    await db.query(
      `delete from public.payout_destinations where recipient_id in
         (select id from public.recipients where user_id = $1)`,
      [userId],
    )
    await db.query('delete from public.recipients where user_id = $1', [userId])
    await db.query('delete from public.users where id = $1', [userId])
    await db.query('delete from auth.users where id = $1', [userId])
    await db.end()
  })

  it('blocks every concurrent submit once the receivable is over the ceiling', async () => {
    // Fund all five FIRST, so the exposure is unambiguously over the line
    // before any submit reads it: 5 × $102 = $510 against a $250 ceiling.
    for (const transferId of transferIds) {
      const funded = await applyFundingSucceeded({
        transferId,
        paymentRef: `mockpay_${transferId}`,
        eventId: `evt_${transferId}`,
        actor: 'ceiling-test',
      })
      expect(funded.outcome).toBe('applied')
    }

    const exposure = await getAccountBalance('funding_receivable')
    expect(exposure.amountMinor).toBe(TRANSFERS * (SEND_MINOR + FEE_MINOR))
    expect(exposure.amountMinor).toBeGreaterThan(25_000)

    // All five at once. The control has to hold for every one of them.
    const results = await Promise.all(transferIds.map((id) => submitPayout(id)))

    expect(results).toEqual(Array(TRANSFERS).fill(0))
    // The assertion that actually matters: no money was asked for.
    expect(bridgeCalls).toEqual([])

    const states = await db.query(
      `select state, count(*)::int as n from public.transfers
        where user_id = $1 group by state`,
      [userId],
    )
    expect(states.rows).toEqual([{ state: 'FUNDED', n: TRANSFERS }])
  })

  it('self-heals: the same submits go through once the exposure drains', async () => {
    // Clearing is what drains funding_receivable — the ACH actually settling.
    // Clear four, leaving $102 against the $250 ceiling.
    for (const transferId of transferIds.slice(0, 4)) {
      await applyFundingCleared({ transferId })
    }

    const exposure = await getAccountBalance('funding_receivable')
    expect(exposure.amountMinor).toBe(SEND_MINOR + FEE_MINOR)
    expect(exposure.amountMinor).toBeLessThan(25_000)

    // The sweep's retry, simulated: every previously-blocked transfer, at once.
    const results = await Promise.all(transferIds.map((id) => submitPayout(id)))

    expect(results).toEqual(Array(TRANSFERS).fill(1))
    // Exactly one Bridge payout each, no duplicates — the claim holding while
    // five submits that were all blocked a moment ago retry simultaneously.
    expect(bridgeCalls.length).toBe(TRANSFERS)
    expect(new Set(bridgeCalls).size).toBe(TRANSFERS)

    const introduced = (await fatalFindingKeys()).filter((k) => !baselineFindings.includes(k))
    expect(introduced, 'draining the ceiling and resubmitting introduced findings').toEqual([])
  })
})
