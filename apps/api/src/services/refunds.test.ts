import { describe, it, expect, beforeEach, vi } from 'vitest'

// The PAYOUT_FAILED → REFUNDED refund tail, extracted from the payment-event
// job (slice-7 PR6a) so the automated path and the operator CLI run the SAME
// code. Mirrors risk.test.ts: hoisted `from` spy, thenable chain builder,
// dynamic import after the mocks are in place.

const from = vi.hoisted(() => vi.fn())
vi.mock('./supabase.js', () => ({ supabaseAdmin: { from: (...a: unknown[]) => from(...a) } }))

// real ledger-entry builders (the batches are asserted line-for-line)
const transition = vi.hoisted(() => vi.fn())
vi.mock('./transfers.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./transfers.js')>()
  return { ...actual, transitionTransfer: (...a: unknown[]) => transition(...a) }
})

const postLedger = vi.hoisted(() => vi.fn())
vi.mock('./ledger.js', () => ({ postLedgerTransaction: (...a: unknown[]) => postLedger(...a) }))

const refund = vi.hoisted(() => vi.fn())
vi.mock('./funding/index.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./funding/index.js')>()
  // real undoModeForRef — step 3 picks its REFUNDED batch off the ref prefix
  const fake = { refund: (...a: unknown[]) => refund(...a) }
  return { ...actual, getFundingProcessor: () => fake, processorFor: () => fake }
})

const resolveCancellationRequest = vi.hoisted(() => vi.fn())
vi.mock('./cancellations.js', () => ({
  resolveCancellationRequest: (...a: unknown[]) => resolveCancellationRequest(...a),
}))

const captureMessage = vi.hoisted(() => vi.fn())
const setFingerprint = vi.hoisted(() => vi.fn())
vi.mock('@sentry/node', () => ({
  withScope: (fn: (s: unknown) => void) => fn({ setFingerprint, setContext: vi.fn() }),
  captureMessage: (...a: unknown[]) => captureMessage(...a),
}))

const getBridgeTransfer = vi.hoisted(() => vi.fn())
vi.mock('./bridge.js', () => ({ getBridgeTransfer: (...a: unknown[]) => getBridgeTransfer(...a) }))

const {
  refundPayoutFailure,
  verifyPrincipalReturned,
  listRefundBacklog,
  refundLedgerBatches,
  releaseStaleRefundClaim,
  refundClaimStatus,
  isClaimAbandoned,
  CLAIM_STALE_AFTER_MS,
} = await import('./refunds.js')

// ── PostgREST-ish builder: from() dispenses results per table in call order,
// every filter method is recorded so the filters themselves can be asserted.
const queues: Record<string, unknown[]> = {}
const filters: Array<{ table: string; method: string; args: unknown[]; builder: number }> = []

function q(table: string, ...results: unknown[]): void {
  queues[table] = (queues[table] ?? []).concat(results)
}

// Each from() gets its own builder id, so a filter can be attributed to the
// query that made it — `eq` on the load must not be mistaken for `eq` on the
// disbursement persist, whose scoping is what keeps that UPDATE from closing
// every other parked transfer's null-gate.
let builderId = 0

function chain(table: string, result: unknown): Record<string, unknown> {
  const c: Record<string, unknown> = {}
  const id = ++builderId
  for (const m of ['select', 'eq', 'is', 'not', 'in', 'or', 'lt', 'limit', 'update']) {
    c[m] = (...args: unknown[]) => {
      filters.push({ table, method: m, args, builder: id })
      return c
    }
  }
  c.maybeSingle = () => Promise.resolve(result)
  // the persist + the event lookup await the builder directly
  c.then = (resolve: (v: unknown) => void) => resolve(result)
  return c
}

// a real UUID: the interlock interpolates the id into a PostgREST `or` filter
// string, so it charset-checks the id first
const T = '00000000-0000-4000-8000-000000000081'
const S = 19801
const FEE = 199

// A transfer parked at PAYOUT_FAILED with the principal returned and no refund
// disbursed yet — the row the tail exists to clear.
const parked = (over: Record<string, unknown> = {}) => ({
  data: {
    id: T,
    state: 'PAYOUT_FAILED',
    send_amount_minor: S,
    fee_amount_minor: FEE,
    margin_minor: 0,
    refund_payment_ref: null,
    funding_payment_ref: 'mockpay_1',
    idempotency_key: 'bridge-key-1',
    ...over,
  },
  error: null,
})

const verifiable = (over: Record<string, unknown> = {}) => ({
  data: { id: T, state: 'PAYOUT_FAILED', provider_transfer_ref: 'bridge_tr_1', ...over },
  error: null,
})

// The claim sits between the load and the ref persist, so a full disbursement
// run dispenses THREE `transfers` results: parked(), claimWon, persistOk.
const claimWon = { data: [{ id: T }], error: null }
const claimLost = { data: [], error: null }
const persistOk = { data: null, error: null }

const minutesAgo = (n: number) => new Date(Date.now() - n * 60_000).toISOString()

const filtersFor = (table: string, method: string) =>
  filters.filter((f) => f.table === table && f.method === method).map((f) => f.args)

// There are now TWO update builders on `transfers` in a disbursement run — the
// claim and the ref persist — so tests must name the one they mean by the column
// it sets, never by "the first update".
const updateWith = (all: typeof filters, column: string) =>
  all.find(
    (f) => f.method === 'update' && Object.hasOwn(f.args[0] as Record<string, unknown>, column),
  )

beforeEach(() => {
  vi.clearAllMocks()
  for (const k of Object.keys(queues)) delete queues[k]
  filters.length = 0
  postLedger.mockResolvedValue({ id: 'lt-1' })
  refund.mockResolvedValue({ provider: 'mock', ref: 'mockrefund_x', status: 'succeeded' })
  transition.mockResolvedValue({ id: T, state: 'REFUNDED' })
  resolveCancellationRequest.mockResolvedValue(true)
  from.mockImplementation((table: string) =>
    chain(table, queues[table]?.shift() ?? { data: null, error: null }),
  )
})

describe('refundPayoutFailure', () => {
  it('posts both batches under distinct keys, disburses once, and settles REFUNDED', async () => {
    q('transfers', parked(), claimWon, persistOk) // load, claim, ref persist

    await expect(
      refundPayoutFailure({ transferId: T, actor: 'ops:jphelps', reason: 'operator-triggered' }),
    ).resolves.toEqual({ done: true, outcome: 'refunded' })

    // 1) bridge_return — stand-alone post under its own key
    expect(postLedger).toHaveBeenCalledTimes(1)
    expect(postLedger.mock.calls[0]![0]).toMatchObject({
      transferId: T,
      transition: 'bridge_return',
    })
    expect((postLedger.mock.calls[0]![0] as { entries: unknown }).entries).toEqual([
      { accountCode: 'cash_clearing', direction: 'debit', money: { amountMinor: S, currency: 'USD' } },
      {
        accountCode: 'due_from_bridge',
        direction: 'credit',
        money: { amountMinor: S, currency: 'USD' },
      },
    ])

    // 2) the disbursement — full amount incl. fee, keyed off the stable bridge key
    expect(refund).toHaveBeenCalledTimes(1)
    expect(refund.mock.calls[0]![0]).toMatchObject({
      transferId: T,
      paymentRef: 'mockpay_1',
      amountMinor: S + FEE,
      currency: 'USD',
      idempotencyKey: 'bridge-key-1:refund',
    })

    // 3) REFUNDED — a DISTINCT posting key from bridge_return
    expect(transition).toHaveBeenCalledTimes(1)
    const refunded = transition.mock.calls[0]![0] as Record<string, unknown>
    expect(refunded).toMatchObject({
      transferId: T,
      fromState: 'PAYOUT_FAILED',
      toState: 'REFUNDED',
    })
    expect(refunded.ledgerEntries).toEqual([
      { account_code: 'transfer_payable', direction: 'debit', amount_minor: S, currency: 'USD' },
      { account_code: 'fee_revenue', direction: 'debit', amount_minor: FEE, currency: 'USD' },
      { account_code: 'cash_clearing', direction: 'credit', amount_minor: S + FEE, currency: 'USD' },
    ])
  })

  it('threads the caller’s actor and reason to the transition (the only durable record of who did this)', async () => {
    q('transfers', parked(), claimWon, persistOk)

    await refundPayoutFailure({
      transferId: T,
      actor: 'ops:jphelps',
      reason: 'operator-triggered refund — AUTO_REFUND off',
    })

    expect(transition.mock.calls[0]![0]).toMatchObject({
      actor: 'ops:jphelps',
      reason: 'operator-triggered refund — AUTO_REFUND off',
    })
  })

  it('null-gates the disbursement: a set refund_payment_ref skips refund() but still settles REFUNDED', async () => {
    q('transfers', parked({ refund_payment_ref: 'mockrefund_prev' }))

    await expect(
      refundPayoutFailure({ transferId: T, actor: 'worker:payment-event', reason: 'r' }),
    ).resolves.toEqual({ done: true, outcome: 'already_disbursed' })

    expect(refund).not.toHaveBeenCalled() // gate closed — no second disbursement
    expect(postLedger).toHaveBeenCalledTimes(1) // bridge_return is idempotent on its key
    expect(transition).toHaveBeenCalledTimes(1)
  })

  // PR-S2: the undo's MODE picks the REFUNDED batch. Under real ACH timing the
  // Stripe adapter usually VOIDS (the PI is still processing when a payout
  // fails), and posting the cash batch for a void would credit cash_clearing
  // for money that never moved.
  it('a VOIDED undo settles with the FUNDED reversal — no cash line', async () => {
    q('transfers', parked(), claimWon, persistOk)
    refund.mockResolvedValue({
      provider: 'stripe',
      ref: 'pi_stripe1',
      status: 'succeeded',
      mode: 'voided',
    })

    await expect(
      refundPayoutFailure({ transferId: T, actor: 'ops:jphelps', reason: 'r' }),
    ).resolves.toEqual({ done: true, outcome: 'refunded' })

    const settle = transition.mock.calls[0]![0] as Record<string, unknown>
    expect(settle.ledgerEntries).toEqual([
      { account_code: 'transfer_payable', direction: 'debit', amount_minor: S, currency: 'USD' },
      { account_code: 'fee_revenue', direction: 'debit', amount_minor: FEE, currency: 'USD' },
      {
        account_code: 'funding_receivable',
        direction: 'credit',
        amount_minor: S + FEE,
        currency: 'USD',
      },
    ])
    expect(settle.ledgerDescription).toContain('voided')
    // bridge_return is unchanged — Bridge really did return the payout principal
    expect(postLedger.mock.calls[0]![0]).toMatchObject({ transition: 'bridge_return' })
  })

  it('crash-recovery reads the mode off the persisted ref: a pi_ ref settles with the reversal batch', async () => {
    q('transfers', parked({ refund_payment_ref: 'pi_stripe1' }))

    await expect(
      refundPayoutFailure({ transferId: T, actor: 'worker:payment-event', reason: 'r' }),
    ).resolves.toEqual({ done: true, outcome: 'already_disbursed' })

    expect(refund).not.toHaveBeenCalled()
    const settle = transition.mock.calls[0]![0] as Record<string, unknown>
    expect(
      (settle.ledgerEntries as Array<{ account_code: string }>).map((e) => e.account_code),
    ).toEqual(['transfer_payable', 'fee_revenue', 'funding_receivable'])
  })

  it('scopes the refund-ref persist to THIS transfer and to a null gate', async () => {
    q('transfers', parked(), claimWon, persistOk)

    await refundPayoutFailure({ transferId: T, actor: 'a', reason: 'r' })

    // Attributed to the UPDATE's own builder: an unscoped update would read
    // `set refund_payment_ref = … where refund_payment_ref is null` across the
    // WHOLE table, closing every other parked transfer's null-gate so its real
    // refund tail skips the disbursement and settles REFUNDED without paying
    // the sender — and the backlog would then read empty.
    const update = updateWith(filters, 'refund_payment_ref')
    expect(update?.args[0]).toMatchObject({ refund_payment_ref: 'mockrefund_x' })
    const persistFilters = filters
      .filter((f) => f.builder === update?.builder && f.method !== 'update')
      .map((f) => [f.method, ...f.args])
    expect(persistFilters).toEqual([
      ['eq', 'id', T],
      ['is', 'refund_payment_ref', null],
    ])
  })

  it('reports an already-settled transfer as done without touching the ledger', async () => {
    q('transfers', parked({ state: 'REFUNDED', refund_payment_ref: 'mockrefund_prev' }))

    await expect(
      refundPayoutFailure({ transferId: T, actor: 'ops:jphelps', reason: 'r' }),
    ).resolves.toEqual({ done: true, outcome: 'already_settled' })

    // a replay from a TERMINAL state posts nothing at all — not even the
    // idempotent bridge_return batch
    expect(postLedger).not.toHaveBeenCalled()
    expect(refund).not.toHaveBeenCalled()
    expect(transition).not.toHaveBeenCalled()
  })

  it('never refunds a transfer that is not PAYOUT_FAILED (a delivered transfer must not reverse)', async () => {
    q('transfers', parked({ state: 'COMPLETED' }))

    await expect(
      refundPayoutFailure({ transferId: T, actor: 'a', reason: 'r' }),
    ).resolves.toEqual({ done: false, reason: 'not_payout_failed', state: 'COMPLETED' })

    expect(postLedger).not.toHaveBeenCalled()
    expect(refund).not.toHaveBeenCalled()
    expect(transition).not.toHaveBeenCalled()
  })

  it('reports a vanished transfer rather than posting anything', async () => {
    q('transfers', { data: null, error: null })

    await expect(
      refundPayoutFailure({ transferId: T, actor: 'a', reason: 'r' }),
    ).resolves.toEqual({ done: false, reason: 'transfer_not_found' })

    expect(postLedger).not.toHaveBeenCalled()
    expect(refund).not.toHaveBeenCalled()
  })

  it('fails closed on a load error — never treats a broken read as “nothing to refund”', async () => {
    q('transfers', { data: null, error: { message: 'db down' } })

    await expect(refundPayoutFailure({ transferId: T, actor: 'a', reason: 'r' })).rejects.toThrow(
      /refund transfer load failed/,
    )
    expect(postLedger).not.toHaveBeenCalled()
  })

  it('throws when the refund-ref persist fails (leaves the caller to retry)', async () => {
    q('transfers', parked(), claimWon, { data: null, error: { message: 'persist boom' } })

    await expect(refundPayoutFailure({ transferId: T, actor: 'a', reason: 'r' })).rejects.toThrow(
      /refund ref persist failed/,
    )
    expect(transition).not.toHaveBeenCalled() // never settles REFUNDED on an unrecorded disbursement
  })
})

// ── the refund claim (slice-7 PR6b-0) ──────────────────────────────────────
// The disbursement gate. Before this, `refund_payment_ref is null` was a read
// separated from its write and two concurrent runs both paid the sender — and
// nothing caught it, because MockFundingProcessor.refund() ignores the
// idempotency key by design.
describe('the refund claim', () => {
  it('takes the claim before calling the processor, with the caller’s actor', async () => {
    q('transfers', parked(), claimWon, persistOk)

    await refundPayoutFailure({ transferId: T, actor: 'ops:jphelps', reason: 'r' })

    const claim = updateWith(filters, 'refund_claimed_at')
    expect(claim?.args[0]).toMatchObject({ refund_claimed_by: 'ops:jphelps' })
    expect((claim?.args[0] as Record<string, unknown>).refund_claimed_at).toEqual(expect.any(String))

    // THE predicate. `refund_claimed_at is null` and nothing else: no staleness
    // term, because a machine must never retake a claim — only
    // releaseStaleRefundClaim clears one, and only after a human has looked.
    const claimFilters = filters
      .filter((f) => f.builder === claim?.builder && f.method !== 'update')
      .map((f) => [f.method, ...f.args])
    expect(claimFilters).toEqual([
      ['eq', 'id', T],
      ['is', 'refund_payment_ref', null],
      ['is', 'refund_claimed_at', null],
      ['select', 'id'],
    ])
  })

  it('claims BEFORE disbursing, never after', async () => {
    q('transfers', parked(), claimWon, persistOk)
    const order: string[] = []
    from.mockImplementation((table: string) => {
      const result = queues[table]?.shift() ?? { data: null, error: null }
      const c = chain(table, result)
      const update = c.update as (...a: unknown[]) => unknown
      c.update = (...a: unknown[]) => {
        if (Object.hasOwn(a[0] as Record<string, unknown>, 'refund_claimed_at')) order.push('claim')
        return update(...a)
      }
      return c
    })
    refund.mockImplementation(() => {
      order.push('refund')
      return Promise.resolve({ provider: 'mock', ref: 'mockrefund_x', status: 'succeeded' })
    })

    await refundPayoutFailure({ transferId: T, actor: 'a', reason: 'r' })

    expect(order).toEqual(['claim', 'refund'])
  })

  it('a loser never reaches the processor and never settles the state', async () => {
    // load → claim lost → re-read shows a LIVE claim held by someone else
    q(
      'transfers',
      parked(),
      claimLost,
      parked({ refund_claimed_at: minutesAgo(2), refund_claimed_by: 'worker:payment-event' }),
    )

    const outcome = await refundPayoutFailure({ transferId: T, actor: 'ops:jphelps', reason: 'r' })

    expect(outcome).toMatchObject({
      done: false,
      reason: 'claim_taken',
      claimedBy: 'worker:payment-event',
    })
    expect(refund).not.toHaveBeenCalled()
    expect(transition).not.toHaveBeenCalled() // must NOT settle a refund it did not make
  })

  it('reports an abandoned claim distinctly — it is the one a human must judge', async () => {
    q(
      'transfers',
      parked(),
      claimLost,
      parked({ refund_claimed_at: minutesAgo(31), refund_claimed_by: 'ops:someone' }),
    )

    const outcome = await refundPayoutFailure({ transferId: T, actor: 'ops:jphelps', reason: 'r' })

    expect(outcome).toMatchObject({ done: false, reason: 'claim_abandoned', claimedBy: 'ops:someone' })
    expect(refund).not.toHaveBeenCalled()
    expect(transition).not.toHaveBeenCalled()
  })

  // The RPC treats a transition whose target IS the current state as a replay:
  // it returns the row and appends/posts NOTHING. So a loser that fell through
  // to it would write nothing and still report `already_disbursed`, which the
  // CLI prints as "state settled by this run" — credit for a run that did
  // nothing, and the verify query would show a different actor.
  it('reports already_settled — not already_disbursed — when the winner already finished', async () => {
    q(
      'transfers',
      parked(),
      claimLost,
      parked({ state: 'REFUNDED', refund_payment_ref: 'mockrefund_winner' }),
    )

    await expect(
      refundPayoutFailure({ transferId: T, actor: 'ops:jphelps', reason: 'r' }),
    ).resolves.toEqual({ done: true, outcome: 'already_settled' })

    expect(refund).not.toHaveBeenCalled()
    expect(transition).not.toHaveBeenCalled()
  })

  // The bug the two-operator rig caught. The loser used to fall through to the
  // transition here; the RPC treats a transition to the CURRENT state as a
  // replay (appends nothing, posts nothing) and returns the row either way, so
  // the loser reported `already_disbursed` — printed as "state settled by this
  // run" and "refunded by ops:<loser>" — while transfer_transitions recorded
  // somebody else. A loser must write nothing and say nothing happened.
  it('a loser whose winner persisted the ref mid-flight still writes NOTHING', async () => {
    q(
      'transfers',
      parked(),
      claimLost,
      parked({
        refund_payment_ref: 'mockrefund_winner',
        refund_claimed_at: minutesAgo(1),
        refund_claimed_by: 'ops:winner',
      }),
    )

    const outcome = await refundPayoutFailure({ transferId: T, actor: 'ops:loser', reason: 'r' })

    expect(outcome).toMatchObject({ done: false, reason: 'claim_taken', claimedBy: 'ops:winner' })
    expect(refund).not.toHaveBeenCalled()
    expect(transition).not.toHaveBeenCalled()
  })

  // The genuine crash-recovery heal, which is a DIFFERENT shape: no claim is
  // contended because the ref was already set on the FIRST load, so this run is
  // alone and really does finish the state.
  it('still heals a crashed run whose ref was set before this run loaded it', async () => {
    q('transfers', parked({ refund_payment_ref: 'mockrefund_prev' }))

    await expect(
      refundPayoutFailure({ transferId: T, actor: 'ops:jphelps', reason: 'r' }),
    ).resolves.toEqual({ done: true, outcome: 'already_disbursed' })

    expect(refund).not.toHaveBeenCalled()
    expect(transition).toHaveBeenCalledTimes(1)
  })

  // Documented at length in the service: a null stamp on the re-read would mean
  // the holder released the claim between our attempt and the read, which only
  // releaseStaleRefundClaim does. It must read as TAKEN (silent), because being
  // wrong toward silence is safe here and being wrong toward a page is not.
  it('reads a released-in-the-gap claim as taken, not abandoned', async () => {
    q('transfers', parked(), claimLost, parked({ refund_claimed_at: null, refund_claimed_by: null }))

    await expect(
      refundPayoutFailure({ transferId: T, actor: 'ops:jphelps', reason: 'r' }),
    ).resolves.toEqual({ done: false, reason: 'claim_taken', claimedAt: null, claimedBy: null })
    expect(refund).not.toHaveBeenCalled()
  })

  it('reports a transfer that vanished under the re-read', async () => {
    q('transfers', parked(), claimLost, { data: null, error: null })

    await expect(
      refundPayoutFailure({ transferId: T, actor: 'a', reason: 'r' }),
    ).resolves.toEqual({ done: false, reason: 'transfer_not_found' })
    expect(refund).not.toHaveBeenCalled()
  })

  it('takes NO claim when the disbursement already exists', async () => {
    q('transfers', parked({ refund_payment_ref: 'mockrefund_prev' }))

    await refundPayoutFailure({ transferId: T, actor: 'a', reason: 'r' })

    // The crash-recovery path is untouched by the claim: nothing to gate, since
    // the money is already out and only the state is missing.
    expect(updateWith(filters, 'refund_claimed_at')).toBeUndefined()
    expect(transition).toHaveBeenCalledTimes(1)
  })

  it('fails closed on a claim error — a broken query must not read as a lost race', async () => {
    q('transfers', parked(), { data: null, error: { message: 'claim boom' } })

    await expect(refundPayoutFailure({ transferId: T, actor: 'a', reason: 'r' })).rejects.toThrow(
      /refund claim failed/,
    )
    expect(refund).not.toHaveBeenCalled()
  })

  it('refuses to disburse against a missing funding ref, and takes no claim', async () => {
    q('transfers', parked({ funding_payment_ref: null }))

    await expect(refundPayoutFailure({ transferId: T, actor: 'a', reason: 'r' })).rejects.toThrow(
      /no funding_payment_ref/,
    )

    // Never send the processor an empty payment reference, and never hold a
    // claim on a row we cannot pay — the claim would age into an abandoned
    // alert about a disbursement that was never even attempted.
    expect(refund).not.toHaveBeenCalled()
    expect(updateWith(filters, 'refund_claimed_at')).toBeUndefined()
  })

  it('fails closed on a null-without-error claim result too', async () => {
    // `(data ?? []).length === 1` would coalesce this to a lost race and refuse
    // silently — the same fail-open the error branch above exists to prevent.
    q('transfers', parked(), { data: null, error: null })

    await expect(refundPayoutFailure({ transferId: T, actor: 'a', reason: 'r' })).rejects.toThrow(
      /refund claim failed/,
    )
    expect(refund).not.toHaveBeenCalled()
  })

  it('does NOT release the claim when the processor throws', async () => {
    q('transfers', parked(), claimWon)
    refund.mockRejectedValue(new Error('processor timeout'))

    await expect(refundPayoutFailure({ transferId: T, actor: 'a', reason: 'r' })).rejects.toThrow(
      /processor timeout/,
    )

    // The whole point. A timeout and a definitive rejection throw identically
    // (FundingProcessor has no error taxonomy), so the money MAY have gone out.
    // Releasing here would hand the next run a green light to pay twice; instead
    // the claim stands and goes abandoned for a human to judge.
    const writes = filters.filter((f) => f.method === 'update').map((f) => f.args[0])
    expect(writes).toHaveLength(1) // the claim itself, and nothing after it
    expect(writes[0]).toMatchObject({ refund_claimed_by: 'a' })
    expect(transition).not.toHaveBeenCalled()
  })

  it('leaves the claim standing when the ref persist throws', async () => {
    q('transfers', parked(), claimWon, { data: null, error: { message: 'persist boom' } })

    await expect(refundPayoutFailure({ transferId: T, actor: 'a', reason: 'r' })).rejects.toThrow(
      /refund ref persist failed/,
    )

    // Worst case of all: the sender WAS paid and we failed to record it. The
    // claim must survive so the row goes abandoned rather than free.
    const clears = filters
      .filter((f) => f.method === 'update')
      .filter((f) => (f.args[0] as Record<string, unknown>).refund_claimed_at === null)
    expect(clears).toHaveLength(0)
  })
})

// ── tail 1 of the cancellation story (slice-7 PR6b) ────────────────────────
// The sender asked to cancel, the payout then FAILED, and this tail has made
// them whole. Nothing further is owed, so the request closes.
describe('cancellation request settlement', () => {
  it('closes a pending request when the refund settles', async () => {
    q('transfers', parked(), claimWon, persistOk)

    await refundPayoutFailure({ transferId: T, actor: 'worker:payment-event', reason: 'r' })

    expect(resolveCancellationRequest).toHaveBeenCalledWith({
      transferId: T,
      status: 'resolved_refunded',
      resolution: expect.stringContaining('refunded in full'),
      resolvedBy: 'worker:payment-event',
    })
  })

  // The self-heal, and the reason this hooks more than the transition. If a
  // resolve fails after a successful transition, EVERY later run short-circuits
  // at already_settled — so if that exit did not retry, the request would sit
  // pending forever on a transfer that was refunded.
  it('re-attempts the close from already_settled, which is its only retry', async () => {
    q('transfers', parked({ state: 'REFUNDED', refund_payment_ref: 'mockrefund_prev' }))

    await expect(
      refundPayoutFailure({ transferId: T, actor: 'ops:jphelps', reason: 'r' }),
    ).resolves.toEqual({ done: true, outcome: 'already_settled' })

    expect(resolveCancellationRequest).toHaveBeenCalledTimes(1)
    expect(postLedger).not.toHaveBeenCalled() // still writes NOTHING to the ledger
  })

  it('re-attempts the close from the lost-claim already_settled exit too', async () => {
    q('transfers', parked(), claimLost, parked({ state: 'REFUNDED', refund_payment_ref: 'r1' }))

    await refundPayoutFailure({ transferId: T, actor: 'ops:jphelps', reason: 'r' })

    expect(resolveCancellationRequest).toHaveBeenCalledTimes(1)
  })

  it('does NOT close the request on any refusal — the sender has not been paid', async () => {
    q('transfers', parked({ state: 'COMPLETED' }))
    await refundPayoutFailure({ transferId: T, actor: 'a', reason: 'r' })
    expect(resolveCancellationRequest).not.toHaveBeenCalled()

    vi.clearAllMocks()
    resolveCancellationRequest.mockResolvedValue(true)
    q('transfers', parked(), claimLost, parked({ refund_claimed_at: minutesAgo(2) }))
    await refundPayoutFailure({ transferId: T, actor: 'a', reason: 'r' })
    expect(resolveCancellationRequest).not.toHaveBeenCalled()
  })

  // Bookkeeping hanging off a money path: the sender HAS been paid, and a
  // failure to file that fact must not undo or fail the refund.
  it('a failed close never fails the refund — it pages instead', async () => {
    resolveCancellationRequest.mockRejectedValue(new Error('db down'))
    q('transfers', parked(), claimWon, persistOk)

    await expect(
      refundPayoutFailure({ transferId: T, actor: 'a', reason: 'r' }),
    ).resolves.toEqual({ done: true, outcome: 'refunded' })

    expect(transition).toHaveBeenCalledTimes(1) // the refund still settled
    expect(setFingerprint).toHaveBeenCalledWith(['cancellation-resolve-failed', T])
    expect(captureMessage.mock.calls.at(-1)?.[1]).toBe('error')
  })
})

describe('isClaimAbandoned', () => {
  it('is exclusive of the window and inclusive at it', () => {
    const now = Date.now()
    expect(isClaimAbandoned(null, now)).toBe(false)
    expect(isClaimAbandoned(new Date(now - CLAIM_STALE_AFTER_MS + 1000).toISOString(), now)).toBe(
      false,
    )
    expect(isClaimAbandoned(new Date(now - CLAIM_STALE_AFTER_MS).toISOString(), now)).toBe(true)
  })

  // Date.parse returns NaN on garbage and EVERY NaN comparison is false, so the
  // natural expression silently classifies a corrupt stamp as "in flight" — the
  // SILENT branch — forever. It would never age into claim_abandoned, so the
  // sweep would re-drive it every 5 minutes with no alert, indefinitely. Fail
  // toward the branch that fetches a human.
  it('treats an unparseable stamp as abandoned, never as in-flight', () => {
    expect(isClaimAbandoned('not-a-timestamp')).toBe(true)
    expect(isClaimAbandoned('')).toBe(true)
  })

  it('does not treat a future stamp as abandoned', () => {
    const now = Date.now()
    expect(isClaimAbandoned(new Date(now + 60_000).toISOString(), now)).toBe(false)
  })
})

describe('releaseStaleRefundClaim', () => {
  it('clears only an abandoned claim on an undisbursed transfer', async () => {
    q('transfers', { data: [{ id: T }], error: null })

    await expect(releaseStaleRefundClaim(T)).resolves.toBe(true)

    const update = updateWith(filters, 'refund_claimed_at')
    expect(update?.args[0]).toEqual({ refund_claimed_at: null, refund_claimed_by: null })
    const guards = filters
      .filter((f) => f.builder === update?.builder && f.method !== 'update')
      .map((f) => [f.method, ...f.args.slice(0, 2)])
    // Never disturb a completed disbursement; never yank a LIVE claim out from
    // under a run that is mid-flight.
    // values asserted too: `.is('refund_payment_ref', 'x')` would satisfy a
    // name-only check while no longer gating on an undisbursed transfer.
    expect(guards.map((g) => g.slice(0, 3))).toEqual([
      ['eq', 'id', T],
      ['is', 'refund_payment_ref', null],
      ['lt', 'refund_claimed_at', expect.any(String)],
      ['select', 'id'],
    ])
    const lt = filters.find((f) => f.method === 'lt')
    expect(Date.now() - Date.parse(lt?.args[1] as string)).toBeGreaterThanOrEqual(
      CLAIM_STALE_AFTER_MS,
    )
  })

  it('reports false when nothing moved, so the caller re-refuses', async () => {
    q('transfers', { data: [], error: null })
    await expect(releaseStaleRefundClaim(T)).resolves.toBe(false)
  })

  it('throws on a release error rather than reporting a silent no-op', async () => {
    q('transfers', { data: null, error: { message: 'boom' } })
    await expect(releaseStaleRefundClaim(T)).rejects.toThrow(/refund claim release failed/)
  })
})

describe('verifyPrincipalReturned', () => {
  it('confirms only when the recorded event AND live Bridge agree', async () => {
    q('transfers', verifiable())
    q('payment_events', { data: [{ event_type: 'refunded' }], error: null })
    getBridgeTransfer.mockResolvedValue({
      bridgeTransferId: 'bridge_tr_1',
      state: 'returned',
      sourceAmount: '198.01',
    })

    await expect(verifyPrincipalReturned(T)).resolves.toEqual({
      returned: true,
      bridgeState: 'returned',
      eventType: 'refunded',
    })
    expect(getBridgeTransfer).toHaveBeenCalledWith('bridge_tr_1')
  })

  it('refuses when Bridge disagrees with the recorded event (refund_failed = principal stuck at Bridge)', async () => {
    q('transfers', verifiable())
    q('payment_events', { data: [{ event_type: 'refunded' }], error: null })
    getBridgeTransfer.mockResolvedValue({
      bridgeTransferId: 'bridge_tr_1',
      state: 'refund_failed',
      sourceAmount: '',
    })

    await expect(verifyPrincipalReturned(T)).resolves.toMatchObject({
      returned: false,
      reason: 'bridge_disagrees',
      bridgeState: 'refund_failed',
    })
  })

  it('refuses when no returned/refunded event was ever recorded, even if Bridge says returned', async () => {
    q('transfers', verifiable())
    q('payment_events', { data: [], error: null })
    getBridgeTransfer.mockResolvedValue({
      bridgeTransferId: 'bridge_tr_1',
      state: 'returned',
      sourceAmount: '198.01',
    })

    await expect(verifyPrincipalReturned(T)).resolves.toMatchObject({
      returned: false,
      reason: 'no_return_event',
    })
  })

  it('scopes the event lookup to the terminal return states and to this transfer', async () => {
    q('transfers', verifiable())
    q('payment_events', { data: [{ event_type: 'returned' }], error: null })
    getBridgeTransfer.mockResolvedValue({ bridgeTransferId: 'bridge_tr_1', state: 'returned', sourceAmount: '' })

    await verifyPrincipalReturned(T)

    expect(filtersFor('payment_events', 'in')[0]).toEqual(['event_type', ['returned', 'refunded']])
    const or = String(filtersFor('payment_events', 'or')[0]![0])
    expect(or).toContain(`transfer_id.eq.${T}`)
    expect(or).toContain('provider_ref.eq.bridge_tr_1')
  })

  it('refuses an unsubmitted transfer without calling Bridge', async () => {
    q('transfers', verifiable({ provider_transfer_ref: null }))

    await expect(verifyPrincipalReturned(T)).resolves.toEqual({
      returned: false,
      reason: 'not_submitted',
    })
    expect(getBridgeTransfer).not.toHaveBeenCalled()
  })

  it('refuses a vanished transfer', async () => {
    q('transfers', { data: null, error: null })

    await expect(verifyPrincipalReturned(T)).resolves.toEqual({
      returned: false,
      reason: 'transfer_not_found',
    })
  })

  it('propagates a Bridge API failure — an unreachable Bridge is never a confirmation', async () => {
    q('transfers', verifiable())
    q('payment_events', { data: [{ event_type: 'refunded' }], error: null })
    getBridgeTransfer.mockRejectedValue(new Error('Bridge API request failed with status 503'))

    await expect(verifyPrincipalReturned(T)).rejects.toThrow(/status 503/)
  })

  it('fails closed on an event-query error', async () => {
    q('transfers', verifiable())
    q('payment_events', { data: null, error: { message: 'db down' } })

    await expect(verifyPrincipalReturned(T)).rejects.toThrow(/principal-return event query failed/)
  })

  it('refuses to build the event filter from a malformed transfer id', async () => {
    // PostgREST `or` takes a filter STRING, not bound parameters — an id like
    // `x),or(1.eq.1` would otherwise rewrite the predicate.
    q('transfers', verifiable({ id: 'x),or(1.eq.1' }))

    await expect(verifyPrincipalReturned('x),or(1.eq.1')).rejects.toThrow(/malformed transfer id/)
    expect(getBridgeTransfer).not.toHaveBeenCalled()
  })
})

describe('listRefundBacklog', () => {
  const parkedRow = (over: Record<string, unknown> = {}) => ({
    id: T,
    send_amount_minor: S,
    fee_amount_minor: FEE,
    margin_minor: 0,
    provider_transfer_ref: 'bridge_tr_1',
    refund_payment_ref: null,
    created_at: '2026-07-27T00:00:00.000Z',
    refund_claimed_at: null,
    refund_claimed_by: null,
    ...over,
  })

  it('scopes to submitted rows parked at PAYOUT_FAILED, and returns no PII', async () => {
    q('transfers', { data: [parkedRow()], error: null })

    const rows = await listRefundBacklog()

    expect(rows).toHaveLength(1)
    // ids, amounts and timestamps only — never names, phone, or destination
    // details. refund_claimed_by is an operator id, not a person's name.
    expect(Object.keys(rows[0]!).sort()).toEqual([
      'claimStatus',
      'created_at',
      'fee_amount_minor',
      'id',
      'margin_minor',
      'provider_transfer_ref',
      'refund_claimed_at',
      'refund_claimed_by',
      'refund_payment_ref',
      'send_amount_minor',
    ])
    expect(filtersFor('transfers', 'eq')).toContainEqual(['state', 'PAYOUT_FAILED'])
    expect(filtersFor('transfers', 'not')).toContainEqual(['provider_transfer_ref', 'is', null])
  })

  // A crash between the disbursement and the REFUNDED transition leaves the ref
  // SET at PAYOUT_FAILED — the sender was paid but {id}:REFUNDED was never
  // posted, so the ledger is wrong about that transfer. Filtering on
  // `refund_payment_ref is null` (as the poller does) would hide exactly the
  // rows nothing else can heal on this path.
  it('does NOT hide rows whose disbursement already went out', async () => {
    q('transfers', { data: [parkedRow({ refund_payment_ref: 'mockrefund_prev' })], error: null })

    const rows = await listRefundBacklog()

    expect(rows[0]!.refund_payment_ref).toBe('mockrefund_prev')
    expect(filtersFor('transfers', 'is')).not.toContainEqual(['refund_payment_ref', null])
  })

  // The window belongs to the service: an operator reading --list must never be
  // handed two timestamps and asked to do the arithmetic by eye.
  it('classifies each row so the operator is never given raw window arithmetic', async () => {
    q('transfers', {
      data: [
        parkedRow({ id: 'a' }),
        parkedRow({ id: 'b', refund_claimed_at: minutesAgo(2), refund_claimed_by: 'ops:x' }),
        parkedRow({ id: 'c', refund_claimed_at: minutesAgo(31), refund_claimed_by: 'ops:y' }),
      ],
      error: null,
    })

    const rows = await listRefundBacklog()

    expect(rows.map((r) => r.claimStatus)).toEqual(['unclaimed', 'claimed', 'abandoned'])
    expect(rows[2]!.refund_claimed_by).toBe('ops:y')
  })

  it('fails closed rather than reporting an empty backlog', async () => {
    q('transfers', { data: null, error: { message: 'db down' } })
    await expect(listRefundBacklog()).rejects.toThrow(/refund backlog query failed/)
  })
})

describe('refundClaimStatus', () => {
  it('classifies one transfer, so a dry run can warn before --confirm', async () => {
    q('transfers', {
      data: { refund_claimed_at: minutesAgo(31), refund_claimed_by: 'ops:y' },
      error: null,
    })

    await expect(refundClaimStatus(T)).resolves.toEqual({
      claimStatus: 'abandoned',
      claimedAt: expect.any(String),
      claimedBy: 'ops:y',
    })
  })

  it('reports unclaimed for a free transfer, and null for one that is gone', async () => {
    q(
      'transfers',
      { data: { refund_claimed_at: null, refund_claimed_by: null }, error: null },
      { data: null, error: null },
    )

    await expect(refundClaimStatus(T)).resolves.toMatchObject({ claimStatus: 'unclaimed' })
    await expect(refundClaimStatus(T)).resolves.toBeNull()
  })

  it('classifies a live claim as claimed, which is what the CLI renders as IN PROGRESS', async () => {
    q('transfers', {
      data: { refund_claimed_at: minutesAgo(2), refund_claimed_by: 'worker:payment-event' },
      error: null,
    })

    await expect(refundClaimStatus(T)).resolves.toMatchObject({
      claimStatus: 'claimed',
      claimedBy: 'worker:payment-event',
    })
  })

  it('throws on a read error rather than reporting "unclaimed"', async () => {
    q('transfers', { data: null, error: { message: 'db down' } })
    await expect(refundClaimStatus(T)).rejects.toThrow(/refund claim status query failed/)
  })
})

describe('refundLedgerBatches', () => {
  it('reads back the posted batches so the operator can verify both keys landed', async () => {
    q('ledger_transactions', {
      data: [
        { transition: 'bridge_return', idempotency_key: `${T}:bridge_return` },
        { transition: 'REFUNDED', idempotency_key: `${T}:REFUNDED` },
      ],
      error: null,
    })

    await expect(refundLedgerBatches(T)).resolves.toEqual([
      { transition: 'bridge_return', idempotency_key: `${T}:bridge_return` },
      { transition: 'REFUNDED', idempotency_key: `${T}:REFUNDED` },
    ])
    expect(filtersFor('ledger_transactions', 'eq')).toContainEqual(['transfer_id', T])
  })

  it('fails closed on a query error', async () => {
    q('ledger_transactions', { data: null, error: { message: 'db down' } })
    await expect(refundLedgerBatches(T)).rejects.toThrow(/ledger batch query failed/)
  })
})
