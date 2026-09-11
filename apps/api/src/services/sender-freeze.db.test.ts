// Integration tests against a real local Supabase stack (Docker).
// Gated: RUN_DB_TESTS=1. Proves `unfreezeSender` at the DATABASE level — the
// guarantees the mocked-chain unit tests cannot reach.
//
// The unit tests pin the ARGUMENTS the service passes. They cannot tell you
// that PostgREST accepts `update().eq().eq().eq().select()`, that a timestamptz
// equality filter round-trips the value PostgREST just handed us, or that the
// `moddatetime` trigger on public.users moves `updated_at` on every write. Each
// of those failing is SILENT: the filter matches nothing, the unfreeze reports
// a refusal, and every mocked test still passes. Worse, the opposite failure —
// a filter that does not narrow — would let this lift a freeze nobody
// investigated, which is the whole reason the version guard exists.
//
// What it establishes:
//   - a suspended sender is restored to 'active', with an ops_actions row that
//     survives that table's real CHECKs and its append-only trigger
//   - the sender's `sender_suspended` holds are cleared, and only those: a hold
//     under another reason, a non-FUNDED row, and another sender's hold survive
//   - a SECOND unfreeze refuses (the CAS from the other side)
//   - THE RACE: a freeze that was lifted and re-applied between the read and
//     the write is refused as `changed_underneath`, not lifted. This is the one
//     that needs a real database, because it depends on the moddatetime trigger
//     actually firing.
//
// Fixture idiom follows payout-holds.db.test.ts: FRESH uuids per run and no
// cleanup beyond closing the connection. ops_actions is append-only and holds
// an FK to transfers, so nothing here deletes; leftovers under random ids are
// inert and `supabase db reset` is the janitor.
import crypto from 'node:crypto'
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import { Client } from 'pg'

const runDb = process.env.RUN_DB_TESTS === '1'

const DB_URL = process.env.TEST_DB_URL ?? 'postgresql://postgres:postgres@127.0.0.1:54322/postgres'

// pg-boss is latency-only on this path (the 1-min sweep resubmits anyway) and
// has its own db test. Everything else is real.
const enqueuePayoutSubmit = vi.hoisted(() => vi.fn())
vi.mock('./queue.js', () => ({
  enqueuePayoutSubmit: (...args: unknown[]) => enqueuePayoutSubmit(...args),
}))

const { unfreezeSender, listSenderSuspendedHolds, listSenderOpenDisputes } = await import('./sender-freeze.js')
const { supabaseAdmin } = await import('./supabase.js')

const FROZEN = crypto.randomUUID()
const OTHER_SENDER = crypto.randomUUID()
const OPERATOR = crypto.randomUUID()
const NOTE = 'Sender repaid the returned debit; bank confirmed by phone.'

const S = 19801
const FEE = 199

const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() }

describe.skipIf(!runDb)('unfreezeSender (integration, local Supabase)', () => {
  let db: Client
  let transfers: {
    held: string
    otherReason: string
    notFunded: string
    foreign: string
    foreignDisputed: string
    foreignReversed: string
  }

  const seedDestination = async (userId: string): Promise<string> => {
    const recipient = await db.query(
      `insert into public.recipients (user_id, first_name, last_name, relationship, country)
       values ($1, 'Ana', 'García López', 'mother', 'MX') returning id`,
      [userId],
    )
    const destination = await db.query(
      `insert into public.payout_destinations (recipient_id, method, currency, details)
       values ($1, 'bank_account', 'MXN', '{}') returning id`,
      [recipient.rows[0].id],
    )
    return destination.rows[0].id as string
  }

  const seedTransfer = async (opts: {
    userId: string
    destinationId: string
    holdReason?: string | null
    state?: string
  }): Promise<string> => {
    const transferId = crypto.randomUUID()
    const quote = await db.query(
      `insert into public.quotes (user_id, payout_destination_id, send_amount_minor, send_currency,
         receive_amount_minor, receive_currency, fee_amount_minor, fee_currency,
         fx_rate, source_rate, fx_rate_at, expires_at, status)
       values ($1, $2, ${S}, 'USD', 396014, 'MXN', ${FEE}, 'USD', 19.9997, 20.100251, now(),
         now() + interval '15 minutes', 'consumed') returning id`,
      [opts.userId, opts.destinationId],
    )
    await db.query(
      `insert into public.transfers (id, user_id, payout_destination_id, quote_id,
         send_amount_minor, send_currency, receive_amount_minor, receive_currency,
         fee_amount_minor, fee_currency, fx_rate, fx_rate_at, idempotency_key, state,
         funding_payment_ref, payment_at, payout_hold_reason, payout_held_at)
       values ($1, $2, $3, $4, ${S}, 'USD', 396014, 'MXN', ${FEE}, 'USD', 19.9997, now(), $5,
         $6, $7, now(), $8, $9)`,
      [
        transferId,
        opts.userId,
        opts.destinationId,
        quote.rows[0].id,
        `unfreeze-db-test-${transferId}`,
        opts.state ?? 'FUNDED',
        `mockpay_${transferId}`,
        opts.holdReason ?? null,
        opts.holdReason ? new Date().toISOString() : null,
      ],
    )
    return transferId
  }

  const statusOf = async (userId: string) =>
    (await db.query('select status from public.users where id = $1', [userId])).rows[0].status

  const holdOf = async (transferId: string) =>
    (
      await db.query('select state, payout_hold_reason from public.transfers where id = $1', [transferId])
    ).rows[0]

  const suspend = async () =>
    db.query(`update public.users set status = 'suspended' where id = $1`, [FROZEN])

  beforeAll(async () => {
    db = new Client({ connectionString: DB_URL })
    await db.connect()
    for (const id of [FROZEN, OTHER_SENDER]) {
      await db.query(`insert into auth.users (id, phone) values ($1, $2)`, [
        id,
        `1555${crypto.randomInt(1_000_000, 9_999_999)}`,
      ])
    }
    const destFrozen = await seedDestination(FROZEN)
    const destOther = await seedDestination(OTHER_SENDER)

    transfers = {
      // The one row this unfreeze should clear.
      held: await seedTransfer({ userId: FROZEN, destinationId: destFrozen, holdReason: 'sender_suspended' }),
      // Same sender, held on the dispute against THIS transfer. It outlives the
      // account freeze and is released on its own judgement.
      otherReason: await seedTransfer({ userId: FROZEN, destinationId: destFrozen, holdReason: 'funding_disputed' }),
      // Already past FUNDED — releasing it would be meaningless.
      notFunded: await seedTransfer({
        userId: FROZEN,
        destinationId: destFrozen,
        holdReason: 'sender_suspended',
        state: 'SUBMITTED',
      }),
      // Another sender entirely, frozen for their own reasons.
      foreign: await seedTransfer({ userId: OTHER_SENDER, destinationId: destOther, holdReason: 'sender_suspended' }),
      // Another sender's OPEN CLAWBACKS, one of each shape. These exist to
      // prove the dispute read cannot escape its user scope: PostgREST ANDs a
      // top-level filter with the `or=(...)` group, but that is a claim worth
      // testing rather than believing, because getting it wrong would show one
      // operator another sender's disputes and hide the absence of their own.
      foreignDisputed: await seedTransfer({
        userId: OTHER_SENDER,
        destinationId: destOther,
        holdReason: 'funding_disputed',
      }),
      foreignReversed: await seedTransfer({
        userId: OTHER_SENDER,
        destinationId: destOther,
        state: 'FUNDING_REVERSED',
      }),
    }
    await suspend()
    await db.query(`update public.users set status = 'suspended' where id = $1`, [OTHER_SENDER])
  })

  afterAll(async () => {
    await db.end()
  })

  const run = () =>
    unfreezeSender({ userId: FROZEN, actor: `ops:${OPERATOR}`, note: NOTE, requestId: null }, log)

  it('lists the holds the freeze left, and only this sender FUNDED ones', async () => {
    // What the CLI dry run shows the operator before they confirm.
    expect(await listSenderSuspendedHolds(FROZEN)).toEqual([transfers.held])
  })

  it("restores 'active', writes the decision row, and releases only the freeze's holds", async () => {
    const outcome = await run()

    expect(outcome).toEqual({
      done: true,
      previousStatus: 'suspended',
      releasedTransferIds: [transfers.held],
    })
    expect(await statusOf(FROZEN)).toBe('active')

    // Released.
    expect(await holdOf(transfers.held)).toMatchObject({ payout_hold_reason: null })
    // Untouched: this transfer's own dispute, a row past FUNDED, another sender.
    expect(await holdOf(transfers.otherReason)).toMatchObject({ payout_hold_reason: 'funding_disputed' })
    expect(await holdOf(transfers.notFunded)).toMatchObject({ payout_hold_reason: 'sender_suspended' })
    expect(await holdOf(transfers.foreign)).toMatchObject({ payout_hold_reason: 'sender_suspended' })
    expect(await statusOf(OTHER_SENDER)).toBe('suspended')

    // The decision row, through the real CHECKs and the append-only trigger.
    const decision = await db.query(
      `select actor, action, transfer_id, reason, note, before, after
       from public.ops_actions where actor = $1 and action = 'sender_unfreeze'`,
      [`ops:${OPERATOR}`],
    )
    expect(decision.rows).toHaveLength(1)
    expect(decision.rows[0]).toMatchObject({
      action: 'sender_unfreeze',
      transfer_id: null,
      reason: 'operator_review',
      note: NOTE,
      before: { status: 'suspended' },
      after: { status: 'active' },
    })

    // And one hold_release row for the transfer it actually freed.
    const release = await db.query(
      `select action, reason from public.ops_actions where transfer_id = $1 and action = 'hold_release'`,
      [transfers.held],
    )
    expect(release.rows).toEqual([{ action: 'hold_release', reason: 'sender_suspended' }])
    expect(enqueuePayoutSubmit).toHaveBeenCalledWith(transfers.held, 'api')
  })

  it('a second unfreeze refuses instead of writing a second decision row', async () => {
    expect(await run()).toEqual({ done: false, reason: 'not_suspended', status: 'active' })
  })

  it('the version guard narrows: a stale updated_at matches nothing', async () => {
    // THE RACE, at the level a real database is needed to prove.
    //
    // The window inside unfreezeSender is microseconds and cannot be widened
    // from outside the service, so this asserts the MECHANISM the guard rests
    // on rather than staging the collision: that `moddatetime` on public.users
    // moves `updated_at` on every write, and that the exact PostgREST filter
    // chain the service issues matches ZERO rows once the version it read is
    // stale. Both fail silently if wrong — a timestamptz that does not
    // round-trip would refuse every unfreeze (loud enough), but a filter that
    // does NOT narrow would let this lift a freeze nobody investigated.
    // READ THE VERSION THE WAY THE SERVICE DOES. Not with `pg`: node-postgres
    // hands back a JS Date, whose toISOString() is MILLISECOND precision, while
    // a Postgres timestamptz carries microseconds. Filtering on that truncated
    // value matches nothing, so a guard built on it would refuse every single
    // unfreeze — and the refusal would look exactly like a legitimate race.
    // PostgREST returns the full-precision string, which is what the service
    // reads and what it must send back.
    const versionNow = async (): Promise<string> => {
      const { data } = await supabaseAdmin.from('users').select('updated_at').eq('id', FROZEN).maybeSingle()
      return (data as { updated_at: string }).updated_at
    }

    await suspend()
    const stale = await versionNow()

    // Something else touches the row: an unfreeze and an immediate re-freeze,
    // which is exactly the sequence a status-only compare-and-swap accepts.
    await db.query(`update public.users set status = 'active' where id = $1`, [FROZEN])
    await suspend()
    const fresh = await versionNow()
    // The trigger is what makes the guard possible — assert it fired.
    expect(fresh).not.toEqual(stale)
    expect(new Date(fresh).getTime()).toBeGreaterThanOrEqual(new Date(stale).getTime())

    const { data: staleMatch, error: staleError } = await supabaseAdmin
      .from('users')
      .update({ status: 'active' })
      .eq('id', FROZEN)
      .eq('status', 'suspended')
      .eq('updated_at', stale)
      .select('id')
    expect(staleError).toBeNull()
    expect(staleMatch ?? []).toEqual([])
    expect(await statusOf(FROZEN)).toBe('suspended')

    // ...and the CURRENT version DOES match. Without this half the test would
    // pass just as happily against a filter that never matches anything, which
    // is the failure mode that would take the whole unfreeze path down.
    const { data: freshMatch } = await supabaseAdmin
      .from('users')
      .update({ status: 'active' })
      .eq('id', FROZEN)
      .eq('status', 'suspended')
      .eq('updated_at', fresh)
      .select('id')
    expect(freshMatch ?? []).toHaveLength(1)
  })

  it('a normal unfreeze still succeeds with the guard in place', async () => {
    // The other side of the precision hazard above: prove the SERVICE, not a
    // hand-built chain, completes end to end. A guard that always refuses would
    // be a silent outage of the only unfreeze path there is.
    await suspend()
    const outcome = await run()
    expect(outcome).toMatchObject({ done: true, previousStatus: 'suspended' })
    expect(await statusOf(FROZEN)).toBe('active')
  })

  it('surfaces the disputes a version guard cannot see', async () => {
    // What the guard genuinely CANNOT catch: a second dispute arriving while
    // the operator investigates the first. The freeze is idempotent
    // (`neq('status','suspended')`), so a second dispute on an
    // already-suspended sender writes NO new users row and NO second
    // sender_freeze record. Nothing about the account changes, and no
    // compare-and-swap can notice. The only control is showing the operator
    // what is outstanding before they decide.
    const mine = await listSenderOpenDisputes(FROZEN)
    expect(mine).toEqual([transfers.otherReason])
    // The scope test that matters: another sender has BOTH shapes of open
    // clawback outstanding, and neither may appear here.
    expect(mine).not.toContain(transfers.foreignDisputed)
    expect(mine).not.toContain(transfers.foreignReversed)

    // ...and read from the other side, both shapes DO appear, so the filter is
    // narrowing rather than matching nothing.
    const theirs = await listSenderOpenDisputes(OTHER_SENDER)
    expect(theirs.sort()).toEqual([transfers.foreignDisputed, transfers.foreignReversed].sort())
    expect(theirs).not.toContain(transfers.foreign)
  })
})
