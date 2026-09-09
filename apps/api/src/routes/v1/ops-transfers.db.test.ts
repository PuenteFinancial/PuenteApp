// Integration tests against a real local Supabase stack (Docker).
// Gated: RUN_DB_TESTS=1. The O-B write routes END TO END: the real Fastify
// app (real gate, real idempotency plugin, real error handler), the real
// services, the real ledger RPCs through PostgREST, the real append-only
// ops_actions table — with the mock funding processor disbursing the refund.
// The unit tests pin the mapping with every service mocked; this pins that
// the chain actually holds together against Postgres: a release clears the
// hold and leaves its provenance row; an idempotent replay writes nothing
// twice; a pre-submit refund (#254) walks PAYOUT_FAILED → REFUNDED with one
// batch, the ops actor on the transition, and the note kept OUT of it; an
// abandoned claim refuses before any write; and a submitted row whose Bridge
// cannot be reached answers 502 with nothing written.
//
// Only enqueuePayoutSubmit is mocked (pg-boss is latency-only here and has
// its own db test). Bridge is NOT mocked: the test host in setup.ts does not
// resolve, which is exactly the "unreachable" the 502 branch is for.
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import { Client } from 'pg'
import supertest from 'supertest'
import Fastify from 'fastify'
import fp from 'fastify-plugin'

const runDb = process.env.RUN_DB_TESTS === '1'

const DB_URL = process.env.TEST_DB_URL ?? 'postgresql://postgres:postgres@127.0.0.1:54322/postgres'

// Fixed UUIDs in the …009x block — no collisions with the other db tests.
const ADMIN = '00000000-0000-4000-8000-00000000009a'
const SENDER = '00000000-0000-4000-8000-00000000009b'
const T_HELD = '00000000-0000-4000-8000-000000000091'
const T_PRESUBMIT = '00000000-0000-4000-8000-000000000092'
const T_ABANDONED = '00000000-0000-4000-8000-000000000093'
const T_SUBMITTED = '00000000-0000-4000-8000-000000000094'

const S = 19801
const FEE = 199
const NOTE = 'db-test: verified with the sender; both sends today are legitimate.'

// The gate reads these ONCE at env import — set before any module loads it.
process.env.OPS_ADMIN_USER_IDS = ADMIN
process.env.OPS_WRITE_ENABLED = 'true'

const enqueuePayoutSubmit = vi.hoisted(() => vi.fn())
vi.mock('../../services/queue.js', () => ({
  enqueuePayoutSubmit: (...args: unknown[]) => enqueuePayoutSubmit(...args),
}))

const { opsTransfersRoute } = await import('./ops-transfers.js')
const { errorHandlerPlugin } = await import('../../plugins/error-handler.js')
const { idempotencyPlugin } = await import('../../plugins/idempotency.js')
const { transitionTransfer, fundedLedgerEntries } = await import('../../services/transfers.js')
const { submittedLedgerEntries } = await import('../../services/payouts.js')

const mockAuth = fp(async (server) => {
  server.addHook('onRequest', async (request, reply) => {
    const token = request.headers.authorization?.replace('Bearer ', '')
    if (!token) return reply.code(401).send({ error: 'Unauthorized' })
    request.user = { id: token }
  })
})

async function buildApp() {
  const app = Fastify({ logger: false })
  await app.register(errorHandlerPlugin)
  await app.register(mockAuth)
  await app.register(idempotencyPlugin)
  await app.register(opsTransfersRoute, { prefix: '/v1' })
  await app.ready()
  return app
}

describe.skipIf(!runDb)('ops write routes end to end (integration, local Supabase)', () => {
  let db: Client
  let app: Awaited<ReturnType<typeof buildApp>>

  const post = (path: string, key: string) =>
    supertest(app.server).post(path).set('Authorization', `Bearer ${ADMIN}`).set('Idempotency-Key', key)

  const seedTransfer = async (transferId: string, destinationId: string) => {
    const quote = await db.query(
      `insert into public.quotes (user_id, payout_destination_id, send_amount_minor, send_currency,
         receive_amount_minor, receive_currency, fee_amount_minor, fee_currency,
         fx_rate, source_rate, fx_rate_at, expires_at, status)
       values ($1, $2, ${S}, 'USD', 396014, 'MXN', ${FEE}, 'USD', 19.9997, 20.100251, now(),
         now() + interval '15 minutes', 'consumed') returning id`,
      [SENDER, destinationId],
    )
    await db.query(
      `insert into public.transfers (id, user_id, payout_destination_id, quote_id,
         send_amount_minor, send_currency, receive_amount_minor, receive_currency,
         fee_amount_minor, fee_currency, fx_rate, fx_rate_at, idempotency_key, state,
         funding_payment_ref)
       values ($1, $2, $3, $4, ${S}, 'USD', 396014, 'MXN', ${FEE}, 'USD', 19.9997, now(), $5,
         'PENDING_PAYMENT', $6)`,
      [transferId, SENDER, destinationId, quote.rows[0].id, `ops-db-test-${transferId}`, `mockpay_${transferId}`],
    )
    await transitionTransfer({
      transferId,
      fromState: 'PENDING_PAYMENT',
      toState: 'FUNDED',
      actor: 'webhook:funding',
      ledgerEntries: fundedLedgerEntries({ send_amount_minor: S, fee_amount_minor: FEE, margin_minor: 0 }),
    })
  }

  const opsActions = async (transferId: string) =>
    (
      await db.query(
        'select actor, action, reason, note, before, after, request_id from public.ops_actions where transfer_id = $1 order by created_at',
        [transferId],
      )
    ).rows

  const transferRow = async (transferId: string) =>
    (
      await db.query(
        'select state, payout_hold_reason, payout_held_at, refund_payment_ref, refund_claimed_at from public.transfers where id = $1',
        [transferId],
      )
    ).rows[0]

  const ledgerKeys = async (transferId: string) =>
    (
      await db.query('select idempotency_key from public.ledger_transactions where transfer_id = $1 order by posted_at', [
        transferId,
      ])
    ).rows.map((r) => r.idempotency_key as string)

  beforeAll(async () => {
    db = new Client({ connectionString: DB_URL })
    await db.connect()
    for (const [id, phone] of [
      [ADMIN, '15550000090'],
      [SENDER, '15550000091'],
    ] as const) {
      await db.query(`insert into auth.users (id, phone) values ($1, $2) on conflict (id) do nothing`, [id, phone])
    }
    const recipient = await db.query(
      `insert into public.recipients (user_id, first_name, last_name, relationship, country)
       values ($1, 'Ana', 'García López', 'mother', 'MX') returning id`,
      [SENDER],
    )
    const destination = await db.query(
      `insert into public.payout_destinations (recipient_id, method, currency, details)
       values ($1, 'bank_account', 'MXN', '{}') returning id`,
      [recipient.rows[0].id],
    )
    const dest = destination.rows[0].id as string

    // A FUNDED row parked on a human-actioned hold.
    await seedTransfer(T_HELD, dest)
    await db.query(
      `update public.transfers set payout_hold_reason = 'velocity_review', payout_held_at = now() where id = $1`,
      [T_HELD],
    )

    // #254: failed before ever reaching Bridge — no provider ref, so the
    // interlock passes on not_submitted and the tail posts ONE batch.
    for (const id of [T_PRESUBMIT, T_ABANDONED]) {
      await seedTransfer(id, dest)
      await transitionTransfer({ transferId: id, fromState: 'FUNDED', toState: 'PAYOUT_FAILED', actor: 'worker:payout' })
    }
    // A claim taken long ago and never finished — the STOP state.
    await db.query(
      `update public.transfers set refund_claimed_at = now() - interval '1 day', refund_claimed_by = 'ops:someone-else' where id = $1`,
      [T_ABANDONED],
    )

    // Reached Bridge, then failed: the interlock must ask Bridge, which does not resolve here.
    await seedTransfer(T_SUBMITTED, dest)
    await transitionTransfer({
      transferId: T_SUBMITTED,
      fromState: 'FUNDED',
      toState: 'SUBMITTED',
      actor: 'worker:payout',
      providerTransferRef: `bridge_ref_${T_SUBMITTED}`,
      ledgerEntries: submittedLedgerEntries({ sendAmountMinor: S, actualSourceAmountMinor: S }),
    })
    await transitionTransfer({ transferId: T_SUBMITTED, fromState: 'SUBMITTED', toState: 'PAYOUT_FAILED', actor: 'worker:payment-event' })

    enqueuePayoutSubmit.mockResolvedValue('job-1')
    app = await buildApp()
  })

  afterAll(async () => {
    await app?.close()
    // truncate bypasses the append-only row triggers (precedent: every db test).
    await db.query('truncate table public.ops_actions')
    await db.query('truncate table public.ledger_entries, public.ledger_transactions cascade')
    await db.query('truncate table public.payment_events, public.transfer_transitions, public.disclosures')
    await db.query('delete from public.idempotency_keys where user_id = $1', [ADMIN])
    await db.query('delete from public.transfers where user_id = $1', [SENDER])
    await db.query('delete from public.quotes where user_id = $1', [SENDER])
    await db.query(
      `delete from public.payout_destinations where recipient_id in
       (select id from public.recipients where user_id = $1)`,
      [SENDER],
    )
    await db.query('delete from public.recipients where user_id = $1', [SENDER])
    await db.query('delete from auth.users where id in ($1, $2)', [ADMIN, SENDER])
    await db.end()
  })

  describe('POST /v1/ops/transfers/hold-release', () => {
    it('clears the hold, records provenance with the admin as actor, and enqueues the submit', async () => {
      const res = await post('/v1/ops/transfers/hold-release', 'db-release-1').send({
        transferId: T_HELD,
        reason: 'velocity_review',
        note: NOTE,
      })
      expect(res.status).toBe(200)
      expect(res.body).toEqual({ transferId: T_HELD, outcome: 'released', enqueued: true })

      const row = await transferRow(T_HELD)
      expect(row.state).toBe('FUNDED')
      expect(row.payout_hold_reason).toBeNull()
      expect(row.payout_held_at).toBeNull()

      const actions = await opsActions(T_HELD)
      expect(actions).toHaveLength(1)
      expect(actions[0]).toMatchObject({
        actor: `ops:${ADMIN}`,
        action: 'hold_release',
        reason: 'velocity_review',
        note: NOTE,
        before: { payoutHoldReason: 'velocity_review' },
        after: { payoutHoldReason: null, payoutHeldAt: null },
      })
      expect(actions[0].before.payoutHeldAt).toEqual(expect.any(String))
      expect(actions[0].request_id).toEqual(expect.any(String))
      expect(enqueuePayoutSubmit).toHaveBeenCalledWith(T_HELD, 'api')
    })

    it('replays the 200 for the same key + body and writes NOTHING twice', async () => {
      const res = await post('/v1/ops/transfers/hold-release', 'db-release-1').send({
        transferId: T_HELD,
        reason: 'velocity_review',
        note: NOTE,
      })
      expect(res.status).toBe(200)
      expect(res.body).toEqual({ transferId: T_HELD, outcome: 'released', enqueued: true })
      expect(await opsActions(T_HELD)).toHaveLength(1)
      expect(enqueuePayoutSubmit).toHaveBeenCalledTimes(1)
    })

    it('a fresh attempt on the now-unheld row is refused with 409 conflict and leaves no provenance', async () => {
      const res = await post('/v1/ops/transfers/hold-release', 'db-release-2').send({
        transferId: T_HELD,
        reason: 'velocity_review',
        note: NOTE,
      })
      expect(res.status).toBe(409)
      expect(res.body.error.code).toBe('conflict')
      expect(res.body.error.details).toEqual([{ path: 'transferId', issue: 'no hold on this transfer' }])
      expect(await opsActions(T_HELD)).toHaveLength(1)
    })
  })

  describe('POST /v1/ops/transfers/refund', () => {
    it('pre-submit (#254): refunds through the processor, settles REFUNDED with ONE batch, records the actor — and keeps the note off the transition', async () => {
      const res = await post('/v1/ops/transfers/refund', 'db-refund-1').send({ transferId: T_PRESUBMIT, note: NOTE })
      expect(res.status).toBe(200)
      expect(res.body).toEqual({
        transferId: T_PRESUBMIT,
        outcome: 'refunded',
        ledgerComplete: true,
        ledgerKeys: expect.arrayContaining([`${T_PRESUBMIT}:REFUNDED`]),
      })
      expect(res.body.ledgerKeys).not.toContain(`${T_PRESUBMIT}:bridge_return`)

      const row = await transferRow(T_PRESUBMIT)
      expect(row.state).toBe('REFUNDED')
      expect(row.refund_payment_ref).toMatch(/^mock(void|refund)_/)
      expect(row.refund_claimed_at).not.toBeNull()

      const keys = await ledgerKeys(T_PRESUBMIT)
      expect(keys).toContain(`${T_PRESUBMIT}:REFUNDED`)
      expect(keys).not.toContain(`${T_PRESUBMIT}:bridge_return`)

      const transitions = await db.query(
        'select from_state, to_state, actor, reason from public.transfer_transitions where transfer_id = $1 order by created_at',
        [T_PRESUBMIT],
      )
      const last = transitions.rows.at(-1)
      expect(last).toMatchObject({ from_state: 'PAYOUT_FAILED', to_state: 'REFUNDED', actor: `ops:${ADMIN}` })
      expect(last.reason).toBe('ops board refund — AUTO_REFUND off')
      expect(JSON.stringify(transitions.rows)).not.toContain(NOTE)

      const actions = await opsActions(T_PRESUBMIT)
      expect(actions).toHaveLength(1)
      expect(actions[0]).toMatchObject({
        actor: `ops:${ADMIN}`,
        action: 'refund',
        reason: 'refunded',
        note: NOTE,
        before: { state: 'PAYOUT_FAILED', claimStatus: 'unclaimed', preSubmit: true },
        after: { state: 'REFUNDED', outcome: 'refunded', ledgerComplete: true },
      })
    })

    it('replays the 200 for the same key + body: no second batch, no second provenance row', async () => {
      const before = (await ledgerKeys(T_PRESUBMIT)).length
      const res = await post('/v1/ops/transfers/refund', 'db-refund-1').send({ transferId: T_PRESUBMIT, note: NOTE })
      expect(res.status).toBe(200)
      expect(res.body.outcome).toBe('refunded')
      expect((await ledgerKeys(T_PRESUBMIT)).length).toBe(before)
      expect(await opsActions(T_PRESUBMIT)).toHaveLength(1)
    })

    it('an abandoned claim is refused with 409 claim_abandoned BEFORE any write', async () => {
      const res = await post('/v1/ops/transfers/refund', 'db-refund-2').send({ transferId: T_ABANDONED, note: NOTE })
      expect(res.status).toBe(409)
      expect(res.body.error.code).toBe('claim_abandoned')
      const row = await transferRow(T_ABANDONED)
      expect(row.state).toBe('PAYOUT_FAILED')
      expect(row.refund_payment_ref).toBeNull()
      expect(row.refund_claimed_at).not.toBeNull()
      expect(await opsActions(T_ABANDONED)).toHaveLength(0)
      expect(await ledgerKeys(T_ABANDONED)).toEqual([`${T_ABANDONED}:FUNDED`])
    })

    it('a submitted row whose Bridge cannot be reached answers 502 provider_unavailable with nothing written', async () => {
      const res = await post('/v1/ops/transfers/refund', 'db-refund-3').send({ transferId: T_SUBMITTED, note: NOTE })
      expect(res.status).toBe(502)
      expect(res.body.error.code).toBe('provider_unavailable')
      const row = await transferRow(T_SUBMITTED)
      expect(row.state).toBe('PAYOUT_FAILED')
      expect(row.refund_claimed_at).toBeNull()
      expect(await opsActions(T_SUBMITTED)).toHaveLength(0)
      // A non-2xx released the idempotency claim: the same key may be reused
      // for the retry the message asks for.
      const again = await post('/v1/ops/transfers/refund', 'db-refund-3').send({ transferId: T_SUBMITTED, note: NOTE })
      expect(again.status).toBe(502)
    })
  })
})
