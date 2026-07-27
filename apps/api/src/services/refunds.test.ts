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
vi.mock('./funding/index.js', () => ({
  getFundingProcessor: () => ({ refund: (...a: unknown[]) => refund(...a) }),
}))

const getBridgeTransfer = vi.hoisted(() => vi.fn())
vi.mock('./bridge.js', () => ({ getBridgeTransfer: (...a: unknown[]) => getBridgeTransfer(...a) }))

const { refundPayoutFailure, verifyPrincipalReturned, listRefundBacklog, refundLedgerBatches } =
  await import('./refunds.js')

// ── PostgREST-ish builder: from() dispenses results per table in call order,
// every filter method is recorded so the filters themselves can be asserted.
const queues: Record<string, unknown[]> = {}
const filters: Array<{ table: string; method: string; args: unknown[] }> = []

function q(table: string, ...results: unknown[]): void {
  queues[table] = (queues[table] ?? []).concat(results)
}

function chain(table: string, result: unknown): Record<string, unknown> {
  const c: Record<string, unknown> = {}
  for (const m of ['select', 'eq', 'is', 'not', 'in', 'or', 'limit', 'update']) {
    c[m] = (...args: unknown[]) => {
      filters.push({ table, method: m, args })
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

const filtersFor = (table: string, method: string) =>
  filters.filter((f) => f.table === table && f.method === method).map((f) => f.args)

beforeEach(() => {
  vi.clearAllMocks()
  for (const k of Object.keys(queues)) delete queues[k]
  filters.length = 0
  postLedger.mockResolvedValue({ id: 'lt-1' })
  refund.mockResolvedValue({ provider: 'mock', ref: 'mockrefund_x', status: 'succeeded' })
  transition.mockResolvedValue({ id: T, state: 'REFUNDED' })
  from.mockImplementation((table: string) =>
    chain(table, queues[table]?.shift() ?? { data: null, error: null }),
  )
})

describe('refundPayoutFailure', () => {
  it('posts both batches under distinct keys, disburses once, and settles REFUNDED', async () => {
    q('transfers', parked(), { data: null, error: null }) // load, then the ref persist

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
    q('transfers', parked(), { data: null, error: null })

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

  it('persists the refund ref under a null-guard so a concurrent run cannot double-write', async () => {
    q('transfers', parked(), { data: null, error: null })

    await refundPayoutFailure({ transferId: T, actor: 'a', reason: 'r' })

    expect(filtersFor('transfers', 'update')[0]![0]).toMatchObject({
      refund_payment_ref: 'mockrefund_x',
    })
    expect(filtersFor('transfers', 'is')).toContainEqual(['refund_payment_ref', null])
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
    ).resolves.toEqual({ done: false, reason: 'not_payout_failed' })

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
    q('transfers', parked(), { data: null, error: { message: 'persist boom' } })

    await expect(refundPayoutFailure({ transferId: T, actor: 'a', reason: 'r' })).rejects.toThrow(
      /refund ref persist failed/,
    )
    expect(transition).not.toHaveBeenCalled() // never settles REFUNDED on an unrecorded disbursement
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
  it('scopes to parked rows the poller provably cannot heal, and returns no PII', async () => {
    q('transfers', {
      data: [
        {
          id: T,
          state: 'PAYOUT_FAILED',
          send_amount_minor: S,
          fee_amount_minor: FEE,
          provider_transfer_ref: 'bridge_tr_1',
          created_at: '2026-07-27T00:00:00.000Z',
        },
      ],
      error: null,
    })

    const rows = await listRefundBacklog()

    expect(rows).toHaveLength(1)
    // ids, amounts and timestamps only — never names, phone, or destination details
    expect(Object.keys(rows[0]!).sort()).toEqual([
      'created_at',
      'fee_amount_minor',
      'id',
      'provider_transfer_ref',
      'send_amount_minor',
      'state',
    ])
    // the same predicate the payout poller uses for its self-heal scan
    expect(filtersFor('transfers', 'eq')).toContainEqual(['state', 'PAYOUT_FAILED'])
    expect(filtersFor('transfers', 'is')).toContainEqual(['refund_payment_ref', null])
    expect(filtersFor('transfers', 'not')).toContainEqual(['provider_transfer_ref', 'is', null])
  })

  it('fails closed rather than reporting an empty backlog', async () => {
    q('transfers', { data: null, error: { message: 'db down' } })
    await expect(listRefundBacklog()).rejects.toThrow(/refund backlog query failed/)
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
