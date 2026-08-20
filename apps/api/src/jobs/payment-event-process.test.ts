import { describe, it, expect, beforeEach, vi } from 'vitest'

// Mapping-driven suite for the payment-event processor: every action kind
// (ignore / transition / catch-up / fail / unknown), the benign-conflict path,
// the never-reverse-COMPLETED / never-advance-a-failed guards, and the
// retryable-error path that leaves the row 'received' and rethrows.

const from = vi.fn()
vi.mock('../services/supabase.js', () => ({
  supabaseAdmin: { from: (...args: unknown[]) => from(...args) },
}))

const transition = vi.hoisted(() => vi.fn())
vi.mock('../services/transfers.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../services/transfers.js')>()
  return { ...actual, transitionTransfer: (...a: unknown[]) => transition(...a) }
})

const markProcessed = vi.hoisted(() => vi.fn())
const markIgnored = vi.hoisted(() => vi.fn())
vi.mock('../services/payment-events.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../services/payment-events.js')>()
  return {
    ...actual, // real mapBridgeState
    markProcessed: (...a: unknown[]) => markProcessed(...a),
    markIgnored: (...a: unknown[]) => markIgnored(...a),
  }
})

const captureMessage = vi.hoisted(() => vi.fn())
const setFingerprint = vi.hoisted(() => vi.fn())
vi.mock('@sentry/node', () => ({
  withScope: (fn: (s: unknown) => void) => fn({ setFingerprint, setContext: vi.fn() }),
  captureMessage: (...a: unknown[]) => captureMessage(...a),
}))

// PR2 refund-tail collaborators
const envMock = vi.hoisted(() => ({ AUTO_REFUND: false }))
vi.mock('../config/env.js', () => ({ env: envMock }))

const postLedger = vi.hoisted(() => vi.fn())
vi.mock('../services/ledger.js', () => ({ postLedgerTransaction: (...a: unknown[]) => postLedger(...a) }))

const pendingCancellationFor = vi.hoisted(() => vi.fn())
const resolveCancellationRequest = vi.hoisted(() => vi.fn())
vi.mock('../services/cancellations.js', () => ({
  pendingCancellationFor: (...a: unknown[]) => pendingCancellationFor(...a),
  resolveCancellationRequest: (...a: unknown[]) => resolveCancellationRequest(...a),
}))

const refund = vi.hoisted(() => vi.fn())
vi.mock('../services/funding/index.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../services/funding/index.js')>()
  // real undoModeForRef — the tail picks its REFUNDED batch off the ref prefix
  return { ...actual, getFundingProcessor: () => ({ refund: (...a: unknown[]) => refund(...a) }) }
})

const { processPaymentEvent } = await import('./payment-event-process.js')
const { TransferRpcError } = await import('../services/transfers.js')

// from() dispenues results per table in call order.
const queues: Record<string, unknown[]> = {}
function q(table: string, ...results: unknown[]) {
  queues[table] = (queues[table] ?? []).concat(results)
}
// captures the receipt disclosures.upsert(payload, opts) calls for assertions
const upsertCalls: unknown[][] = []
// Every filter method is recorded with a per-builder id (the cancellations.ts
// harness idiom) so a query's CONTRACT can be asserted — the deposit-evidence
// query's filters are the sole input to §1005.34 condition (2), and a dropped
// event_type filter or a flipped sort order must fail a test, not route money.
const filters: Array<{ table: string; method: string; args: unknown[]; builder: number }> = []
let builderId = 0
function chain(table: string, result: unknown) {
  const c: Record<string, unknown> = {}
  const id = ++builderId
  for (const m of ['select', 'eq', 'in', 'is', 'order', 'limit', 'update']) {
    c[m] = (...args: unknown[]) => {
      filters.push({ table, method: m, args, builder: id })
      return c
    }
  }
  c.upsert = (...args: unknown[]) => {
    upsertCalls.push(args)
    return c
  }
  c.maybeSingle = () => Promise.resolve(result)
  // the refund-ref persist + receipt upsert await the builder directly
  c.then = (resolve: (v: unknown) => void) => resolve(result)
  return c
}

const event = (over: Record<string, unknown> = {}) => ({
  data: {
    id: 'ev-1',
    source: 'bridge',
    event_type: 'payment_processed',
    transfer_id: 'tr-1',
    provider_ref: 'bt-1',
    status: 'received',
    ...over,
  },
  error: null,
})
const transfer = (state: string, over: Record<string, unknown> = {}) => ({
  data: {
    id: 'tr-1',
    user_id: 'user-1',
    state,
    // Matches event().provider_ref — a genuine payout event, so the slice-3
    // onramp guard short-circuits without a deposit_instructions read.
    provider_transfer_ref: 'bt-1',
    send_amount_minor: 19801,
    margin_minor: 0,
    // PR2 refund-tail fields (harmless for the pre-PR2 tests that ignore them)
    fee_amount_minor: 199,
    refund_payment_ref: null,
    funding_payment_ref: 'mockpay_1',
    idempotency_key: 'bridge-key-1',
    // PR3 receipt fields
    receive_amount_minor: 396014,
    fx_rate: 19.9997,
    // PR7 receipt fields (§1005.31(b)(2)(iii) recipient join)
    payout_destination_id: 'pd-1',
    ...over,
  },
  error: null,
})
const stateRow = (state: string) => ({ data: { state }, error: null })
// The evidence bound's payout-ref read (earliestDepositEvidenceAt, slice 3):
// queued as a `transfers` row immediately before each evidence query.
const payoutRefRow = () => ({ data: { provider_transfer_ref: 'bt-1' }, error: null })
// The refund claim's guarded UPDATE (slice-7 PR6b-0) sits between the tail's
// row re-read and the ref persist, so any drive that DISBURSES queues it.
const claimWon = { data: [{ id: 'tr-1' }], error: null }

// Queue writeReceipt's tail for a COMPLETED drive: its guard read (transfers —
// state + the write-once completed_at, the PR7 date source), the user locale
// load (users), the recipient join (payout_destinations), and the receipt
// upsert (disclosures).
const DELIVERED_AT = '2026-07-29T18:00:00.000Z'
const completedRow = (state = 'COMPLETED') => ({
  data: { state, completed_at: state === 'COMPLETED' ? DELIVERED_AT : null },
  error: null,
})
function queueReceipt(finalState = 'COMPLETED', preferredLanguage = 'es') {
  q('transfers', completedRow(finalState))
  q('users', { data: { preferred_language: preferredLanguage }, error: null })
  q('payout_destinations', {
    data: { recipients: { first_name: 'María', last_name: 'Hernández García' } },
    error: null,
  })
  q('disclosures', { data: null, error: null })
}

beforeEach(() => {
  vi.clearAllMocks()
  for (const k of Object.keys(queues)) delete queues[k]
  upsertCalls.length = 0
  filters.length = 0
  envMock.AUTO_REFUND = false
  postLedger.mockResolvedValue({ id: 'lt-1' })
  refund.mockResolvedValue({ provider: 'mock', ref: 'mockrefund_x', status: 'succeeded' })
  pendingCancellationFor.mockResolvedValue(null)
  resolveCancellationRequest.mockResolvedValue(true)
  from.mockImplementation((table: string) => {
    const next = queues[table]?.shift()
    if (next === undefined) throw new Error(`unexpected from('${table}')`)
    return chain(table, next)
  })
})

describe('processPaymentEvent — short-circuits', () => {
  it('does nothing when the event is not received (replay)', async () => {
    q('payment_events', event({ status: 'processed' }))
    await processPaymentEvent('ev-1')
    expect(transition).not.toHaveBeenCalled()
    expect(markProcessed).not.toHaveBeenCalled()
  })

  it('returns quietly when the event row vanished', async () => {
    q('payment_events', { data: null, error: null })
    await processPaymentEvent('ev-1')
    expect(transition).not.toHaveBeenCalled()
  })

  it('ignores a no-op Bridge state (awaiting_funds) without loading a transfer', async () => {
    q('payment_events', event({ event_type: 'awaiting_funds' }))
    await processPaymentEvent('ev-1')
    expect(markIgnored).toHaveBeenCalledWith('ev-1')
    expect(transition).not.toHaveBeenCalled()
  })

  it('marks an unknown Bridge state ignored with the state in the reason', async () => {
    q('payment_events', event({ event_type: 'flarghled' }))
    await processPaymentEvent('ev-1')
    expect(markIgnored).toHaveBeenCalledWith('ev-1', expect.stringContaining('flarghled'))
    expect(transition).not.toHaveBeenCalled()
  })

  it('ignores (not fails) when no transfer resolves', async () => {
    q('payment_events', event({ transfer_id: null, provider_ref: null, event_type: 'payment_submitted' }))
    await processPaymentEvent('ev-1')
    expect(markIgnored).toHaveBeenCalledWith('ev-1', 'no transfer for event')
  })
})

describe('processPaymentEvent — transitions', () => {
  it('payment_submitted drives SUBMITTED → IN_FLIGHT (no ledger)', async () => {
    q('payment_events', event({ event_type: 'payment_submitted' }))
    q('transfers', transfer('SUBMITTED'), stateRow('SUBMITTED'))
    transition.mockResolvedValue({})
    await processPaymentEvent('ev-1')
    expect(transition).toHaveBeenCalledTimes(1)
    const [input] = transition.mock.calls[0] as [Record<string, unknown>]
    expect(input).toMatchObject({ fromState: 'SUBMITTED', toState: 'IN_FLIGHT', actor: 'worker:payment-event' })
    expect('ledgerEntries' in input).toBe(false)
    expect(markProcessed).toHaveBeenCalledWith('ev-1')
  })

  // ── tail 2 of the cancellation story (slice-7 PR6b) ────────────────────
  // The sender asked to cancel, and the payout COMPLETED anyway. A TIMELY ask is
  // owed a full refund regardless — the accepted double-pay — so the transfer
  // routes to UNDER_REVIEW for a human to execute the correction payment.
  const pending = (over: Record<string, unknown> = {}) => ({
    id: 'cr-1',
    transfer_id: 'tr-1',
    requested_at: new Date(Date.now() - 60_000).toISOString(),
    requested_state: 'SUBMITTED',
    within_window: true,
    status: 'pending',
    ...over,
  })

  it('timely PRE-DEPOSIT cancellation + COMPLETED → UNDER_REVIEW with NO ledger, request left pending', async () => {
    // The true race: the ask (60s ago) beat our earliest deposit evidence (30s
    // ago). Both §1005.34 conditions held → owed → routed for the correction.
    pendingCancellationFor.mockResolvedValue(pending())
    q('payment_events', event({ event_type: 'payment_processed' }))
    q('transfers', transfer('IN_FLIGHT'), stateRow('IN_FLIGHT'), stateRow('IN_FLIGHT'))
    queueReceipt()
    q('transfers', payoutRefRow())
    q('payment_events', {
      data: [{ received_at: new Date(Date.now() - 30_000).toISOString() }],
      error: null,
    }) // earliest deposit evidence — AFTER the request
    transition.mockResolvedValue({})

    await processPaymentEvent('ev-1')

    const review = transition.mock.calls
      .map((c) => (c as [Record<string, unknown>])[0])
      .find((i) => i.toState === 'UNDER_REVIEW')
    expect(review).toMatchObject({ fromState: 'COMPLETED', toState: 'UNDER_REVIEW', actor: 'system' })
    // NO ledger: nothing has moved. The correction payment posts when the
    // operator executes it; UNDER_REVIEW is a holding state, not an event.
    expect('ledgerEntries' in review!).toBe(false)
    // The request stays PENDING — it is not resolved until the refund happens.
    expect(resolveCancellationRequest).not.toHaveBeenCalled()
    expect(setFingerprint).toHaveBeenCalledWith(['cancellation-correction-owed', 'tr-1'])
    expect(markProcessed).toHaveBeenCalledWith('ev-1')

    // The evidence query's CONTRACT — the sole input to condition (2). Dropping
    // the event_type filter makes the earliest *any* event (e.g. one recorded
    // at submission) the "deposit", killing the owed bucket entirely; flipping
    // the sort routes on the LATEST evidence and over-pays. Attributed to the
    // one builder that ordered by received_at.
    const evidence = filters.find(
      (f) => f.table === 'payment_events' && f.method === 'order',
    )
    const evidenceFilters = filters
      .filter((f) => f.builder === evidence?.builder && f.method !== 'select')
      .map((f) => [f.method, ...f.args])
    expect(evidenceFilters).toEqual([
      ['eq', 'transfer_id', 'tr-1'],
      ['eq', 'event_type', 'payment_processed'],
      // Slice 3: bound to the PAYOUT object — the onramp's payment_processed
      // (the sender's USD deposit) must never read as SPEI deposit evidence.
      ['eq', 'provider_ref', 'bt-1'],
      ['order', 'received_at', { ascending: true }],
      ['limit', 1],
    ])
  })

  // The tie. Date.parse truncates Postgres µs to ms, so two distinct DB
  // instants inside the same millisecond compare EQUAL — ties are realistic,
  // not academic. Ambiguity breaks toward the sender: a tie routes to review
  // for a human with Bridge's authoritative timestamp, never to the not-owed
  // bucket (review fix — `>=` used to send ties there).
  it('a request whose timestamp TIES the deposit evidence routes to UNDER_REVIEW', async () => {
    const instant = new Date(Date.now() - 60_000).toISOString()
    pendingCancellationFor.mockResolvedValue(pending({ requested_at: instant }))
    q('payment_events', event({ event_type: 'payment_processed' }))
    q('transfers', transfer('IN_FLIGHT'), stateRow('IN_FLIGHT'), stateRow('IN_FLIGHT'))
    queueReceipt()
    q('transfers', payoutRefRow())
    q('payment_events', { data: [{ received_at: instant }], error: null })
    transition.mockResolvedValue({})

    await processPaymentEvent('ev-1')

    const states = transition.mock.calls.map((c) => (c as [Record<string, unknown>])[0].toState)
    expect(states).toContain('UNDER_REVIEW')
    expect(setFingerprint).toHaveBeenCalledWith(['cancellation-correction-owed', 'tr-1'])
    expect(setFingerprint).not.toHaveBeenCalledWith(['cancellation-after-deposit', 'tr-1'])
  })

  // The documented legal posture of the fallback: no evidence at all = "treat
  // the request as first" = the owed path. A refactor inverting it (epoch, or
  // null read as "no deposit race") would silently send the no-evidence case
  // to the deny bucket.
  it('no deposit evidence at all → the request is treated as first and routes to UNDER_REVIEW', async () => {
    pendingCancellationFor.mockResolvedValue(pending())
    q('payment_events', event({ event_type: 'payment_processed' }))
    q('transfers', transfer('IN_FLIGHT'), stateRow('IN_FLIGHT'), stateRow('IN_FLIGHT'))
    queueReceipt()
    q('transfers', payoutRefRow())
    q('payment_events', { data: [], error: null }) // nothing recorded
    transition.mockResolvedValue({})

    await processPaymentEvent('ev-1')

    const states = transition.mock.calls.map((c) => (c as [Record<string, unknown>])[0].toState)
    expect(states).toContain('UNDER_REVIEW')
    expect(setFingerprint).toHaveBeenCalledWith(['cancellation-correction-owed', 'tr-1'])
  })

  // Receipt-before-routing, pinned with a STATEFUL mock (review fix — the
  // ordering was previously guarded only by a comment). Routing first would
  // move the row to UNDER_REVIEW, writeReceipt's COMPLETED guard would skip,
  // the event would retire processed, and the Reg E receipt would be
  // permanently lost for exactly the transfers under legal review (the deny
  // exit returns to COMPLETED without writing one either).
  it('writes the Reg E receipt BEFORE routing to UNDER_REVIEW — a swap loses the receipt', async () => {
    pendingCancellationFor.mockResolvedValue(pending())
    q('payment_events', event({ event_type: 'payment_processed' }))
    q('transfers', transfer('IN_FLIGHT'), stateRow('IN_FLIGHT'), stateRow('IN_FLIGHT'))
    queueReceipt()
    q('transfers', payoutRefRow())
    q('payment_events', {
      data: [{ received_at: new Date(Date.now() - 30_000).toISOString() }],
      error: null,
    })
    // Once the routing transition lands, every later transfers read sees
    // UNDER_REVIEW — exactly what the real database would show.
    let reviewed = false
    transition.mockImplementation((input: { toState?: string }) => {
      if (input.toState === 'UNDER_REVIEW') reviewed = true
      return Promise.resolve({})
    })
    from.mockImplementation((table: string) => {
      let next = queues[table]?.shift()
      if (next === undefined) throw new Error(`unexpected from('${table}')`)
      const asState = next as { data?: { state?: string } | null }
      if (table === 'transfers' && reviewed && asState?.data?.state) {
        next = { data: { ...asState.data, state: 'UNDER_REVIEW' }, error: null }
      }
      return chain(table, next)
    })

    await processPaymentEvent('ev-1')

    expect(upsertCalls).toHaveLength(1) // the receipt landed despite the routing
    const states = transition.mock.calls.map((c) => (c as [Record<string, unknown>])[0].toState)
    expect(states).toContain('UNDER_REVIEW')
  })

  // Condition (2) of §1005.34, and the COMMON case on an instant rail: the
  // deposit landed before the sender asked. In-window by the clock, owed
  // NOTHING — the transfer must stay COMPLETED and a human denies with
  // Bridge's timestamp. Before this bucket existed, every in-window cancel on
  // a delivered transfer routed to the correction payment — paying twice in
  // cases the reg never required.
  it('in-window but AFTER-deposit cancellation → stays COMPLETED, deny-with-evidence alert', async () => {
    pendingCancellationFor.mockResolvedValue(pending())
    q('payment_events', event({ event_type: 'payment_processed' }))
    q('transfers', transfer('IN_FLIGHT'), stateRow('IN_FLIGHT'), stateRow('IN_FLIGHT'))
    queueReceipt()
    q('transfers', payoutRefRow())
    q('payment_events', {
      data: [{ received_at: new Date(Date.now() - 120_000).toISOString() }],
      error: null,
    }) // earliest deposit evidence — BEFORE the request (60s ago)

    await processPaymentEvent('ev-1')

    const states = transition.mock.calls.map((c) => (c as [Record<string, unknown>])[0].toState)
    expect(states).not.toContain('UNDER_REVIEW')
    expect(setFingerprint).toHaveBeenCalledWith(['cancellation-after-deposit', 'tr-1'])
    expect(setFingerprint).not.toHaveBeenCalledWith(['cancellation-correction-owed', 'tr-1'])
    expect(markProcessed).toHaveBeenCalledWith('ev-1')
  })

  // Denial is never automatic, and we must not flip a delivered transfer's state
  // for a request we will not honour — that would be a lie in the state log.
  it('OUT-of-window cancellation + COMPLETED → stays COMPLETED, different alert', async () => {
    pendingCancellationFor.mockResolvedValue(pending({ within_window: false }))
    q('payment_events', event({ event_type: 'payment_processed' }))
    q('transfers', transfer('IN_FLIGHT'), stateRow('IN_FLIGHT'), stateRow('IN_FLIGHT'))
    queueReceipt()
    transition.mockResolvedValue({})

    await processPaymentEvent('ev-1')

    const states = transition.mock.calls.map((c) => (c as [Record<string, unknown>])[0].toState)
    expect(states).not.toContain('UNDER_REVIEW')
    expect(setFingerprint).toHaveBeenCalledWith(['cancellation-out-of-window', 'tr-1'])
    expect(setFingerprint).not.toHaveBeenCalledWith(['cancellation-correction-owed', 'tr-1'])
  })

  it('no cancellation request → no review, no alert at all', async () => {
    pendingCancellationFor.mockResolvedValue(null)
    q('payment_events', event({ event_type: 'payment_processed' }))
    q('transfers', transfer('IN_FLIGHT'), stateRow('IN_FLIGHT'), stateRow('IN_FLIGHT'))
    queueReceipt()
    transition.mockResolvedValue({})

    await processPaymentEvent('ev-1')

    const states = transition.mock.calls.map((c) => (c as [Record<string, unknown>])[0].toState)
    expect(states).toEqual(['COMPLETED'])
    // The guard that catches a mis-wired lookup: any throw inside the routing is
    // caught and turned into an alert, so a broken query would otherwise look
    // exactly like a healthy delivery.
    expect(captureMessage).not.toHaveBeenCalled()
  })

  it('payment_processed from IN_FLIGHT posts the COMPLETED ledger batch', async () => {
    q('payment_events', event({ event_type: 'payment_processed' }))
    q('transfers', transfer('IN_FLIGHT'), stateRow('IN_FLIGHT'), stateRow('IN_FLIGHT'))
    queueReceipt()
    transition.mockResolvedValue({})
    await processPaymentEvent('ev-1')
    expect(transition).toHaveBeenCalledTimes(1)
    const [input] = transition.mock.calls[0] as [Record<string, unknown>]
    expect(input).toMatchObject({ fromState: 'IN_FLIGHT', toState: 'COMPLETED' })
    expect(input.ledgerEntries).toEqual([
      { account_code: 'transfer_payable', direction: 'debit', amount_minor: 19801, currency: 'USD' },
      { account_code: 'due_from_bridge', direction: 'credit', amount_minor: 19801, currency: 'USD' },
    ])
    expect(markProcessed).toHaveBeenCalledWith('ev-1')
  })

  it('payment_processed from SUBMITTED catches up IN_FLIGHT then COMPLETED', async () => {
    q('payment_events', event({ event_type: 'payment_processed' }))
    // resolve, currentState=SUBMITTED, afterCatchup=IN_FLIGHT
    q('transfers', transfer('SUBMITTED'), stateRow('SUBMITTED'), stateRow('IN_FLIGHT'))
    queueReceipt()
    transition.mockResolvedValue({})
    await processPaymentEvent('ev-1')
    expect(transition).toHaveBeenCalledTimes(2)
    expect((transition.mock.calls[0] as [Record<string, unknown>])[0]).toMatchObject({
      fromState: 'SUBMITTED', toState: 'IN_FLIGHT',
    })
    const second = (transition.mock.calls[1] as [Record<string, unknown>])[0]
    expect(second).toMatchObject({ fromState: 'IN_FLIGHT', toState: 'COMPLETED' })
    expect(second.ledgerEntries).toBeDefined()
  })

  it('already-COMPLETED payment_processed makes no transition (replay-safe)', async () => {
    q('payment_events', event({ event_type: 'payment_processed' }))
    q('transfers', transfer('COMPLETED'), stateRow('COMPLETED'), stateRow('COMPLETED'))
    queueReceipt() // writeReceipt still runs on a replay — the upsert is idempotent
    await processPaymentEvent('ev-1')
    expect(transition).not.toHaveBeenCalled()
    expect(markProcessed).toHaveBeenCalledWith('ev-1')
  })
})

describe('processPaymentEvent — failures', () => {
  it('undeliverable moves SUBMITTED → PAYOUT_FAILED with no ledger', async () => {
    q('payment_events', event({ event_type: 'undeliverable' }))
    q('transfers', transfer('SUBMITTED'), stateRow('SUBMITTED'))
    transition.mockResolvedValue({})
    await processPaymentEvent('ev-1')
    const [input] = transition.mock.calls[0] as [Record<string, unknown>]
    expect(input).toMatchObject({ fromState: 'SUBMITTED', toState: 'PAYOUT_FAILED' })
    expect('ledgerEntries' in input).toBe(false)
    expect(markProcessed).toHaveBeenCalledWith('ev-1')
  })

  it('refund_failed raises an ops Sentry alert and fails the transfer', async () => {
    q('payment_events', event({ event_type: 'refund_failed' }))
    q('transfers', transfer('IN_FLIGHT'), stateRow('IN_FLIGHT'))
    transition.mockResolvedValue({})
    await processPaymentEvent('ev-1')
    expect(setFingerprint).toHaveBeenCalledWith(['payout-refund-failed'])
    expect(transition).toHaveBeenCalledWith(expect.objectContaining({ toState: 'PAYOUT_FAILED' }))
  })

  it('never reverses a COMPLETED transfer on a late fail event', async () => {
    q('payment_events', event({ event_type: 'error' }))
    q('transfers', transfer('COMPLETED'), stateRow('COMPLETED'))
    await processPaymentEvent('ev-1')
    expect(transition).not.toHaveBeenCalled()
    expect(setFingerprint).toHaveBeenCalledWith(['payout-fail-after-terminal'])
    expect(markProcessed).toHaveBeenCalledWith('ev-1')
  })

  it('already PAYOUT_FAILED is benign — no transition', async () => {
    q('payment_events', event({ event_type: 'error' }))
    q('transfers', transfer('PAYOUT_FAILED'), stateRow('PAYOUT_FAILED'))
    await processPaymentEvent('ev-1')
    expect(transition).not.toHaveBeenCalled()
    expect(markProcessed).toHaveBeenCalledWith('ev-1')
  })

  it('transition_conflict is benign → markProcessed, no rethrow', async () => {
    q('payment_events', event({ event_type: 'payment_submitted' }))
    q('transfers', transfer('SUBMITTED'), stateRow('SUBMITTED'))
    transition.mockRejectedValue(new TransferRpcError('transition_conflict'))
    await processPaymentEvent('ev-1')
    expect(markProcessed).toHaveBeenCalledWith('ev-1')
  })

  it('a retryable error rethrows WITHOUT marking the row — status stays received', async () => {
    q('payment_events', event({ event_type: 'payment_submitted' }))
    q('transfers', transfer('SUBMITTED'), stateRow('SUBMITTED'))
    transition.mockRejectedValue(new Error('db down'))
    await expect(processPaymentEvent('ev-1')).rejects.toThrow('db down')
    // Must NOT mark processed/ignored — leaving status 'received' is what lets
    // pg-boss retry + sweep + poll re-run and eventually complete the transfer.
    expect(markProcessed).not.toHaveBeenCalled()
    expect(markIgnored).not.toHaveBeenCalled()
  })

  it('a success event on an already-failed transfer warns and never transitions', async () => {
    q('payment_events', event({ event_type: 'payment_processed' }))
    q('transfers', transfer('PAYOUT_FAILED'), stateRow('PAYOUT_FAILED'))
    await processPaymentEvent('ev-1')
    expect(transition).not.toHaveBeenCalled()
    expect(setFingerprint).toHaveBeenCalledWith(['payout-success-after-terminal'])
    expect(markProcessed).toHaveBeenCalledWith('ev-1')
  })
})

describe('processPaymentEvent — refund tail (PR2)', () => {
  it('refunded + AUTO_REFUND on → bridge_return post, one refund, REFUNDED batch', async () => {
    envMock.AUTO_REFUND = true
    q('payment_events', event({ event_type: 'refunded' }))
    q(
      'transfers',
      transfer('SUBMITTED'), // resolveTransfer
      stateRow('SUBMITTED'), // failTransfer currentState
      transfer('PAYOUT_FAILED'), // refundPayoutFailure re-reads the full row
      claimWon, // the refund claim
      { data: null, error: null }, // refund_payment_ref persist
    )
    transition.mockResolvedValue({})

    await processPaymentEvent('ev-1')

    // SUBMITTED → PAYOUT_FAILED, then PAYOUT_FAILED → REFUNDED
    expect(transition).toHaveBeenCalledTimes(2)
    expect((transition.mock.calls[0] as [Record<string, unknown>])[0]).toMatchObject({
      toState: 'PAYOUT_FAILED',
    })
    const refunded = (transition.mock.calls[1] as [Record<string, unknown>])[0]
    expect(refunded).toMatchObject({
      fromState: 'PAYOUT_FAILED',
      toState: 'REFUNDED',
      // the job's actor survives the delegation to services/refunds.ts
      actor: 'worker:payment-event',
    })
    expect(refunded.ledgerEntries).toEqual([
      { account_code: 'transfer_payable', direction: 'debit', amount_minor: 19801, currency: 'USD' },
      { account_code: 'fee_revenue', direction: 'debit', amount_minor: 199, currency: 'USD' },
      { account_code: 'cash_clearing', direction: 'credit', amount_minor: 20000, currency: 'USD' },
    ])

    // bridge_return posted stand-alone under its own distinct key
    expect(postLedger).toHaveBeenCalledTimes(1)
    expect(postLedger.mock.calls[0]![0]).toMatchObject({
      transferId: 'tr-1',
      transition: 'bridge_return',
    })

    // refunded exactly once, full amount incl. fee, keyed off the stable bridge key
    expect(refund).toHaveBeenCalledTimes(1)
    expect(refund.mock.calls[0]![0]).toMatchObject({
      amountMinor: 20000,
      currency: 'USD',
      paymentRef: 'mockpay_1',
      idempotencyKey: 'bridge-key-1:refund',
    })
    expect(markProcessed).toHaveBeenCalledWith('ev-1')
  })

  it('refund_in_flight parks at PAYOUT_FAILED with NO refund drive', async () => {
    envMock.AUTO_REFUND = true
    q('payment_events', event({ event_type: 'refund_in_flight' }))
    q('transfers', transfer('SUBMITTED'), stateRow('SUBMITTED'))
    transition.mockResolvedValue({})

    await processPaymentEvent('ev-1')

    expect(transition).toHaveBeenCalledTimes(1)
    expect((transition.mock.calls[0] as [Record<string, unknown>])[0]).toMatchObject({
      toState: 'PAYOUT_FAILED',
    })
    expect(postLedger).not.toHaveBeenCalled()
    expect(refund).not.toHaveBeenCalled()
    expect(markProcessed).toHaveBeenCalledWith('ev-1')
  })

  it('AUTO_REFUND off → PAYOUT_FAILED + ops alert, no ledger, no disbursement', async () => {
    envMock.AUTO_REFUND = false
    q('payment_events', event({ event_type: 'refunded' }))
    q('transfers', transfer('SUBMITTED'), stateRow('SUBMITTED'), stateRow('PAYOUT_FAILED'))
    transition.mockResolvedValue({})

    await processPaymentEvent('ev-1')

    expect(transition).toHaveBeenCalledTimes(1) // only the fail — no REFUNDED
    expect(setFingerprint).toHaveBeenCalledWith(['payout-refund-gated', 'tr-1'])
    expect(postLedger).not.toHaveBeenCalled()
    expect(refund).not.toHaveBeenCalled()
    expect(markProcessed).toHaveBeenCalledWith('ev-1')
  })

  it('AUTO_REFUND off → no “manual refund required” alert for a transfer that actually delivered', async () => {
    envMock.AUTO_REFUND = false
    q('payment_events', event({ event_type: 'refunded' }))
    q(
      'transfers',
      transfer('COMPLETED'), // resolveTransfer
      stateRow('COMPLETED'), // failTransfer → fail-after-terminal
      stateRow('COMPLETED'), // the gate re-reads before alerting
    )

    await processPaymentEvent('ev-1')

    // the gate alert is for a PARKED transfer; a delivered one must not page ops
    expect(setFingerprint).not.toHaveBeenCalledWith(['payout-refund-gated', 'tr-1'])
    expect(postLedger).not.toHaveBeenCalled()
    expect(refund).not.toHaveBeenCalled()
    expect(markProcessed).toHaveBeenCalledWith('ev-1')
  })

  // The claim's two refusals are NOT one signal. The poller re-drives every
  // PAYOUT_FAILED row whose refund_payment_ref is null, so a live claim would
  // page on every re-drive until the winner finished — and an ops queue that
  // cries wolf on healthy concurrency is how the real alert gets ignored.
  it('claim_taken → silent: a live claim is healthy concurrency, not an incident', async () => {
    envMock.AUTO_REFUND = true
    q('payment_events', event({ event_type: 'refunded' }))
    q(
      'transfers',
      transfer('PAYOUT_FAILED'), // resolveTransfer
      stateRow('PAYOUT_FAILED'), // failTransfer no-op
      transfer('PAYOUT_FAILED'), // refundPayoutFailure re-read
      { data: [], error: null }, // claim LOST
      transfer('PAYOUT_FAILED', {
        refund_claimed_at: new Date(Date.now() - 2 * 60_000).toISOString(),
        refund_claimed_by: 'ops:jphelps',
      }), // re-read: a live claim
    )

    await processPaymentEvent('ev-1')

    expect(refund).not.toHaveBeenCalled()
    expect(transition).not.toHaveBeenCalled()
    expect(captureMessage).not.toHaveBeenCalled()
    // The event must stay 'received'. markProcessed drops it out of
    // payout-sweep's selection (it takes status='received' only), and nothing
    // else re-drives a refund — payout-poll enqueues only when recordEvent
    // reports `inserted`, i.e. at most once per (source,state). Retiring it
    // here is the difference between "the sweep finishes this refund" and
    // "the sender is never paid and no alert ever fires".
    expect(markProcessed).not.toHaveBeenCalled()
  })

  it('claim_abandoned → its OWN alert, because the sender may already be paid', async () => {
    envMock.AUTO_REFUND = true
    q('payment_events', event({ event_type: 'refunded' }))
    q(
      'transfers',
      transfer('PAYOUT_FAILED'),
      stateRow('PAYOUT_FAILED'),
      transfer('PAYOUT_FAILED'),
      { data: [], error: null }, // claim LOST
      transfer('PAYOUT_FAILED', {
        refund_claimed_at: new Date(Date.now() - 31 * 60_000).toISOString(),
        refund_claimed_by: 'worker:payment-event',
      }), // re-read: abandoned
    )

    await processPaymentEvent('ev-1')

    expect(refund).not.toHaveBeenCalled()
    // Fingerprinted per transfer so the poller's repeated re-drives collapse
    // into ONE issue, and distinct from payout-refund-refused because the
    // response differs in kind: this one cannot be auto-retried.
    expect(setFingerprint).toHaveBeenCalledWith(['payout-refund-claim-abandoned', 'tr-1'])
    expect(setFingerprint).not.toHaveBeenCalledWith(['payout-refund-refused', 'tr-1'])
    expect(captureMessage).toHaveBeenCalledTimes(1)
    // 'error', not 'warning': this is a sender who may still be owed, the same
    // class as payout-refund-refused. Alert routing that pages on error only
    // would otherwise drop the one branch documented as "page a human".
    expect(captureMessage.mock.calls[0]![1]).toBe('error')
    // Same as claim_taken: unresolved, so the sweep must keep re-driving it.
    // That is also what keeps the alert firing until a human --reclaims.
    expect(markProcessed).not.toHaveBeenCalled()
  })

  // The deterministic stranding this pair exists to prevent: a processor throw
  // leaves the claim standing (by design), pg-boss retries ~15s later, and that
  // retry loses the claim to ITS OWN dead claim — well inside the 10-minute
  // window, so it reads as claim_taken rather than claim_abandoned.
  it('a processor throw then its own retry does NOT retire the event', async () => {
    envMock.AUTO_REFUND = true
    q('payment_events', event({ event_type: 'refunded' }))
    q(
      'transfers',
      transfer('PAYOUT_FAILED'),
      stateRow('PAYOUT_FAILED'),
      transfer('PAYOUT_FAILED'),
      { data: [], error: null }, // claim LOST — to the dead claim from the throw
      transfer('PAYOUT_FAILED', {
        refund_claimed_at: new Date(Date.now() - 15_000).toISOString(),
        refund_claimed_by: 'worker:payment-event',
      }),
    )

    await processPaymentEvent('ev-1')

    expect(markProcessed).not.toHaveBeenCalled()
    expect(captureMessage).not.toHaveBeenCalled()
  })

  it('refund_payment_ref already set (webhook+poll duplicate) → skips refund(), still settles REFUNDED', async () => {
    envMock.AUTO_REFUND = true
    q('payment_events', event({ event_type: 'refunded' }))
    q(
      'transfers',
      transfer('PAYOUT_FAILED', { refund_payment_ref: 'mockrefund_prev' }), // resolveTransfer
      stateRow('PAYOUT_FAILED'), // failTransfer currentState (already failed → no-op)
      transfer('PAYOUT_FAILED', { refund_payment_ref: 'mockrefund_prev' }), // refundPayoutFailure re-read
    )
    transition.mockResolvedValue({})

    await processPaymentEvent('ev-1')

    expect(postLedger).toHaveBeenCalledTimes(1) // bridge_return is idempotent
    expect(refund).not.toHaveBeenCalled() // gate closed — no second disbursement
    expect(transition).toHaveBeenCalledTimes(1) // only REFUNDED (fail was a no-op)
    expect((transition.mock.calls[0] as [Record<string, unknown>])[0]).toMatchObject({
      toState: 'REFUNDED',
    })
    expect(markProcessed).toHaveBeenCalledWith('ev-1')
  })

  it('refunded after an earlier PAYOUT_FAILED (out-of-order) still drives the refund', async () => {
    envMock.AUTO_REFUND = true
    q('payment_events', event({ event_type: 'refunded' }))
    q(
      'transfers',
      transfer('PAYOUT_FAILED'), // already failed via a prior error event
      stateRow('PAYOUT_FAILED'), // failTransfer no-op
      transfer('PAYOUT_FAILED'), // refundPayoutFailure re-read
      claimWon, // the refund claim
      { data: null, error: null }, // persist
    )
    transition.mockResolvedValue({})

    await processPaymentEvent('ev-1')

    expect(postLedger).toHaveBeenCalledTimes(1)
    expect(refund).toHaveBeenCalledTimes(1)
    expect(transition).toHaveBeenCalledWith(expect.objectContaining({ toState: 'REFUNDED' }))
    expect(markProcessed).toHaveBeenCalledWith('ev-1')
  })

  it('never refunds a COMPLETED transfer on a late refunded event', async () => {
    envMock.AUTO_REFUND = true
    q('payment_events', event({ event_type: 'refunded' }))
    q(
      'transfers',
      transfer('COMPLETED'), // resolveTransfer
      stateRow('COMPLETED'), // failTransfer → fail-after-terminal (alert, no step)
      transfer('COMPLETED'), // refundPayoutFailure re-read → not PAYOUT_FAILED → refuses
    )

    await processPaymentEvent('ev-1')

    expect(setFingerprint).toHaveBeenCalledWith(['payout-fail-after-terminal'])
    // the tail refuses too, but the transfer DELIVERED — the sender is owed
    // nothing, so the "sender still owed" page must stay quiet or it trains ops
    // to ignore the one alert that means money is actually stuck
    expect(setFingerprint).not.toHaveBeenCalledWith(['payout-refund-refused', 'tr-1'])
    expect(postLedger).not.toHaveBeenCalled()
    expect(refund).not.toHaveBeenCalled()
    expect(transition).not.toHaveBeenCalled()
    expect(markProcessed).toHaveBeenCalledWith('ev-1')
  })

  it('a duplicate returned/refunded landing on an already-REFUNDED transfer is benign (no false fail-after-terminal alert)', async () => {
    envMock.AUTO_REFUND = true
    q('payment_events', event({ event_type: 'refunded' }))
    q(
      'transfers',
      transfer('REFUNDED', { refund_payment_ref: 'mockrefund_prev' }), // resolveTransfer
      stateRow('REFUNDED'), // failTransfer currentState → benign (already refunded)
      transfer('REFUNDED', { refund_payment_ref: 'mockrefund_prev' }), // → already_settled (done, nothing written)
    )

    await processPaymentEvent('ev-1')

    // must NOT trip the post-delivery-reversal loss fingerprint on a routine dup
    expect(setFingerprint).not.toHaveBeenCalledWith(['payout-fail-after-terminal'])
    // …nor the "sender still owed" page: the refund already happened
    expect(setFingerprint).not.toHaveBeenCalledWith(['payout-refund-refused', 'tr-1'])
    expect(transition).not.toHaveBeenCalled()
    expect(postLedger).not.toHaveBeenCalled()
    expect(refund).not.toHaveBeenCalled()
    expect(markProcessed).toHaveBeenCalledWith('ev-1')
  })

  // The blocker the silent-failure review caught. UNDER_REVIEW's only writer
  // (since PR6b) is the cancellation routing on a DELIVERED transfer — the
  // COMPLETED batch is posted. FAILABLE_STATES used to list it as pre-delivery,
  // so this exact event silently drove UNDER_REVIEW → PAYOUT_FAILED and (flag
  // on) ran the payout-failure tail against delivered books, closing the Reg E
  // request with a false "payout failed" resolution. It must PAGE and freeze,
  // like every other post-delivery contradictory sequence.
  it('a fail event at UNDER_REVIEW pages and does NOT move the row or touch money', async () => {
    envMock.AUTO_REFUND = true
    q('payment_events', event({ event_type: 'refunded' }))
    q(
      'transfers',
      transfer('UNDER_REVIEW'), // resolveTransfer
      stateRow('UNDER_REVIEW'), // failTransfer currentState → not failable → page
      stateRow('UNDER_REVIEW'), // driveRefund's own re-read under AUTO_REFUND
    )
    q('transfers', transfer('UNDER_REVIEW')) // refundPayoutFailure load → refuses (not PAYOUT_FAILED)

    await processPaymentEvent('ev-1')

    expect(setFingerprint).toHaveBeenCalledWith(['payout-fail-after-terminal'])
    expect(transition).not.toHaveBeenCalled() // the row does not move
    expect(refund).not.toHaveBeenCalled() // and no money moves
    expect(postLedger).not.toHaveBeenCalled()
    expect(resolveCancellationRequest).not.toHaveBeenCalled() // the request stays open for the review exits
    expect(markProcessed).toHaveBeenCalledWith('ev-1')
  })

  // The success-side sibling, pinned per the plan: UNDER_REVIEW is outside
  // FORWARD_STATES, so a late success event (a poller race can synthesize one)
  // pages the contradictory-sequence warning rather than silently acting.
  it('a success event at UNDER_REVIEW pages payout-success-after-terminal and moves nothing', async () => {
    q('payment_events', event({ event_type: 'payment_processed' }))
    q(
      'transfers',
      transfer('UNDER_REVIEW'), // resolveTransfer
      stateRow('UNDER_REVIEW'), // drive currentState → not forward → page
    )

    await processPaymentEvent('ev-1')

    expect(setFingerprint).toHaveBeenCalledWith(['payout-success-after-terminal'])
    expect(transition).not.toHaveBeenCalled()
    expect(upsertCalls).toHaveLength(0) // no receipt rewrite either
    expect(markProcessed).toHaveBeenCalledWith('ev-1')
  })

  it('AUTO_REFUND on but the tail refuses in a non-settled state → loud ops alert', async () => {
    envMock.AUTO_REFUND = true
    q('payment_events', event({ event_type: 'refunded' }))
    q(
      'transfers',
      transfer('SUBMITTED'), // resolveTransfer
      stateRow('SUBMITTED'), // failTransfer currentState
      transfer('IN_FLIGHT'), // the row moved between the fail and the service re-read
    )
    transition.mockResolvedValue({})

    await processPaymentEvent('ev-1')

    // markProcessed burns the only retry token, so a silent refusal here would
    // strand the transfer holding the sender's money with nothing to notice
    expect(setFingerprint).toHaveBeenCalledWith(['payout-refund-refused', 'tr-1'])
    expect(captureMessage).toHaveBeenCalledWith(expect.stringContaining('refund tail refused'), 'error')
    expect(postLedger).not.toHaveBeenCalled()
    expect(refund).not.toHaveBeenCalled()
    expect(markProcessed).toHaveBeenCalledWith('ev-1')
  })

  it('a refund-tail error rethrows and leaves the event received (retryable)', async () => {
    envMock.AUTO_REFUND = true
    q('payment_events', event({ event_type: 'refunded' }))
    q('transfers', transfer('SUBMITTED'), stateRow('SUBMITTED'), transfer('PAYOUT_FAILED'))
    transition.mockResolvedValue({})
    postLedger.mockRejectedValue(new Error('ledger db down'))

    await expect(processPaymentEvent('ev-1')).rejects.toThrow('ledger db down')
    expect(refund).not.toHaveBeenCalled() // threw at the bridge_return post, before refund
    expect(markProcessed).not.toHaveBeenCalled() // stays 'received' for retry
  })
})

describe('processPaymentEvent — receipt (PR3)', () => {
  it('payment_processed writes exactly one Reg E receipt from the snapshot terms', async () => {
    q('payment_events', event({ event_type: 'payment_processed' }))
    q('transfers', transfer('IN_FLIGHT'), stateRow('IN_FLIGHT'), stateRow('IN_FLIGHT'))
    queueReceipt('COMPLETED', 'en') // user prefers en
    transition.mockResolvedValue({})

    await processPaymentEvent('ev-1')

    expect(upsertCalls).toHaveLength(1)
    const [payload, opts] = upsertCalls[0] as [Record<string, unknown>, Record<string, unknown>]
    expect(payload).toMatchObject({ transfer_id: 'tr-1', type: 'receipt', locale: 'en' })
    // content built from the immutable snapshot terms (real buildReceiptDisclosure)
    const content = payload['content'] as {
      amounts: Record<string, unknown>
      en: Record<string, unknown>
      es: Record<string, unknown>
    }
    expect(content.amounts).toMatchObject({ totalMinor: 20000, receiveMinor: 396014, fxRate: '19.9997' })
    // PR7: the receipt identifies itself (§1005.31(b)(2)) and carries the
    // recipient + the delivery date sourced from the COMPLETED transition —
    // both languages (parity).
    expect(content.en).toMatchObject({
      title: 'Receipt',
      recipientLine: 'Recipient: María Hernández García',
      dateAvailableLine: 'Date available: July 29, 2026',
    })
    expect(content.es).toMatchObject({
      title: 'Recibo',
      recipientLine: 'Destinatario: María Hernández García',
      dateAvailableLine: 'Fecha de disponibilidad: 29 de julio de 2026',
    })
    // idempotent — one receipt per transfer
    expect(opts).toMatchObject({ onConflict: 'transfer_id,type', ignoreDuplicates: true })
    expect(markProcessed).toHaveBeenCalledWith('ev-1')

    // Query contracts (the harness idiom, comment at `filters`): the date on
    // the receipt comes from the transfer row's write-once completed_at — a
    // regression to the transitions table (whose round-trip duplicate row
    // falsifies the date) must fail here, as must a dropped id filter.
    expect(
      filters.some(
        (f) => f.table === 'transfers' && f.method === 'select' && f.args[0] === 'state, completed_at',
      ),
    ).toBe(true)
    expect(filters.some((f) => f.table === 'transfer_transitions')).toBe(false)
    const destFilters = filters.filter((f) => f.table === 'payout_destinations' && f.method === 'eq')
    expect(destFilters).toEqual([expect.objectContaining({ args: ['id', 'pd-1'] })])
  })

  it('COMPLETED without completed_at rethrows — no receipt with a fabricated date', async () => {
    q('payment_events', event({ event_type: 'payment_processed' }))
    // The guard read reports COMPLETED but the write-once column is missing —
    // a read anomaly; the throw happens before the locale/recipient loads.
    q('transfers', transfer('IN_FLIGHT'), stateRow('IN_FLIGHT'), stateRow('IN_FLIGHT'), {
      data: { state: 'COMPLETED', completed_at: null },
      error: null,
    })
    transition.mockResolvedValue({})

    await expect(processPaymentEvent('ev-1')).rejects.toThrow('COMPLETED without completed_at')
    expect(upsertCalls).toHaveLength(0)
    expect(markProcessed).not.toHaveBeenCalled() // event stays received; retry self-heals
  })

  it('a missing recipient rethrows — the receipt must name the recipient (b)(2)(iii)', async () => {
    q('payment_events', event({ event_type: 'payment_processed' }))
    q('transfers', transfer('IN_FLIGHT'), stateRow('IN_FLIGHT'), stateRow('IN_FLIGHT'), completedRow())
    q('users', { data: { preferred_language: 'es' }, error: null })
    q('payout_destinations', { data: { recipients: null }, error: null })
    transition.mockResolvedValue({})

    await expect(processPaymentEvent('ev-1')).rejects.toThrow('no recipient found')
    expect(upsertCalls).toHaveLength(0)
    expect(markProcessed).not.toHaveBeenCalled()
  })

  it('never writes a receipt when a concurrent fail moved the row off the forward path', async () => {
    q('payment_events', event({ event_type: 'payment_processed' }))
    // resolve SUBMITTED → step to IN_FLIGHT, afterCatchup reads PAYOUT_FAILED
    // (a concurrent fail landed) → skip COMPLETED, writeReceipt re-reads
    // PAYOUT_FAILED → no-op. No users/disclosures queries follow.
    q(
      'transfers',
      transfer('SUBMITTED'),
      stateRow('SUBMITTED'),
      stateRow('PAYOUT_FAILED'),
      stateRow('PAYOUT_FAILED'),
    )
    transition.mockResolvedValue({})

    await processPaymentEvent('ev-1')

    expect(upsertCalls).toHaveLength(0) // a receipt only for a delivered transfer
    expect(markProcessed).toHaveBeenCalledWith('ev-1')
  })

  it('a receipt upsert failure rethrows and leaves the event received (self-heals on retry)', async () => {
    q('payment_events', event({ event_type: 'payment_processed' }))
    q('transfers', transfer('IN_FLIGHT'), stateRow('IN_FLIGHT'), stateRow('IN_FLIGHT'), completedRow())
    q('users', { data: { preferred_language: 'es' }, error: null })
    q('payout_destinations', {
      data: { recipients: { first_name: 'María', last_name: 'Hernández García' } },
      error: null,
    })
    q('disclosures', { data: null, error: { message: 'disclosures db down' } })
    transition.mockResolvedValue({})

    await expect(processPaymentEvent('ev-1')).rejects.toThrow('receipt upsert failed')
    // COMPLETED ledger already posted; the event stays 'received' so a retry
    // re-runs drive() (replay no-op) and re-attempts the idempotent receipt.
    expect(markProcessed).not.toHaveBeenCalled()
  })
})

// ── funding-source events (PR-S2 refund tails) ───────────────────────────────
// These rows are recorded and normally handled inline by the funding webhook
// route; they reach the job only through the crash-recovery path (payout-sweep
// re-enqueues stale 'received' rows source-blind). The branch must re-drive the
// same act and retire the row — mapBridgeState would otherwise read the type as
// an unknown BRIDGE state and mark it ignored, eating a sender-still-owed page.

describe('funding-source events (PR-S2 refund tails)', () => {
  it('refund_failed re-drives the sender-still-owed page and retires the row', async () => {
    q(
      'payment_events',
      event({
        source: 'funding',
        event_type: 'refund_failed',
        transfer_id: 'tr-1',
        provider_ref: 'mockrefund_9',
      }),
    )

    await processPaymentEvent('ev-1')

    expect(setFingerprint).toHaveBeenCalledWith(['funding-refund-failed', 'tr-1'])
    expect(captureMessage).toHaveBeenCalledWith(
      expect.stringContaining('refund FAILED'),
      'error',
    )
    expect(markProcessed).toHaveBeenCalledWith('ev-1')
    // money truth only — never a state move, never a ledger post
    expect(transition).not.toHaveBeenCalled()
    expect(postLedger).not.toHaveBeenCalled()
  })

  it('refund_settled retires silently — the payment_events row is the record', async () => {
    q('payment_events', event({ source: 'funding', event_type: 'refund_settled' }))

    await processPaymentEvent('ev-1')

    expect(captureMessage).not.toHaveBeenCalled()
    expect(markProcessed).toHaveBeenCalledWith('ev-1')
    expect(transition).not.toHaveBeenCalled()
  })

  it('an unknown funding event type marks ignored with the funding label, not the bridge one', async () => {
    q('payment_events', event({ source: 'funding', event_type: 'mystery_event' }))

    await processPaymentEvent('ev-1')

    expect(markIgnored).toHaveBeenCalledWith('ev-1', 'unmapped funding event: mystery_event')
    expect(markProcessed).not.toHaveBeenCalled()
  })
})

// ── funding-ops slice 3: the onramp-event guard ─────────────────────────────
// Bridge ONRAMP events resolve to our transfer via client_reference_id exactly
// like payout events. Without the guard, an onramp payment_processed drives a
// false COMPLETED (+ ledger + receipt) and an onramp returned invokes the
// payout refund tail. The guard matches the event's provider_ref against the
// transfer's own deposit_instructions row and ignores on a POSITIVE match only.

describe('processPaymentEvent — onramp-event guard (funding-ops slice 3)', () => {
  const ONRAMP = 'onramp-bt-77'
  // The payout ref is null before submission (PENDING_PAYMENT / FUNDED) and
  // set after — the guard must hold in every forward state either way.
  const stateRef: Array<[string, string | null]> = [
    ['PENDING_PAYMENT', null],
    ['FUNDED', null],
    ['SUBMITTED', 'bt-1'],
    ['IN_FLIGHT', 'bt-1'],
    ['COMPLETED', 'bt-1'],
  ]

  for (const [state, payoutRef] of stateRef) {
    for (const eventType of ['payment_processed', 'canceled', 'returned'] as const) {
      it(`ignores onramp ${eventType} at ${state} — no drive, no fail, no refund, no page`, async () => {
        envMock.AUTO_REFUND = true // even armed, the refund tail must not fire
        q('payment_events', event({ event_type: eventType, provider_ref: ONRAMP }))
        q('transfers', transfer(state, { provider_transfer_ref: payoutRef }))
        // With the payout ref KNOWN the guard needs no instructions read at
        // all (the harness throws on an unqueued table); before it persists,
        // the positive match decides.
        if (payoutRef === null) {
          q('deposit_instructions', { data: { bridge_transfer_ref: ONRAMP }, error: null })
        }

        await processPaymentEvent('ev-1')

        expect(markIgnored).toHaveBeenCalledWith('ev-1', 'onramp lifecycle event')
        expect(transition).not.toHaveBeenCalled()
        expect(refund).not.toHaveBeenCalled()
        expect(postLedger).not.toHaveBeenCalled()
        // no false payout-success-after-terminal / fail-after-terminal pages
        expect(captureMessage).not.toHaveBeenCalled()
        expect(markProcessed).not.toHaveBeenCalled()
      })
    }
  }

  // Re-attach overwrites deposit_instructions.bridge_transfer_ref (supported
  // recovery flow), so a SUPERSEDED onramp's late event no longer matches the
  // instructions row — with the payout ref known it must still be refused, or
  // an old onramp's canceled/returned/payment_processed would falsely fail,
  // refund, or complete a live payout (Codex review finding, 2026-08-20).
  for (const state of ['SUBMITTED', 'IN_FLIGHT', 'COMPLETED']) {
    it(`ignores a SUPERSEDED onramp's returned at ${state} — ref matches neither payout nor instructions`, async () => {
      envMock.AUTO_REFUND = true
      q('payment_events', event({ event_type: 'returned', provider_ref: 'onramp-OLD' }))
      q('transfers', transfer(state, { provider_transfer_ref: 'bt-1' }))
      // no deposit_instructions queued: the ≠-payout-ref refusal needs no read

      await processPaymentEvent('ev-1')

      expect(markIgnored).toHaveBeenCalledWith('ev-1', 'onramp lifecycle event')
      expect(transition).not.toHaveBeenCalled()
      expect(refund).not.toHaveBeenCalled()
      expect(captureMessage).not.toHaveBeenCalled()
    })
  }

  it('residual: a superseded onramp event PRE-submission proceeds but moves nothing (pages instead)', async () => {
    // Payout ref still null and the instructions point at the replacement
    // onramp — the guard cannot tell this from a racing payout webhook, so it
    // proceeds; the state machine's non-forward guards then refuse to move a
    // PENDING_PAYMENT row and page rather than transition.
    q('payment_events', event({ event_type: 'payment_processed', provider_ref: 'onramp-OLD' }))
    q('transfers', transfer('PENDING_PAYMENT', { provider_transfer_ref: null }), stateRow('PENDING_PAYMENT'))
    q('deposit_instructions', { data: { bridge_transfer_ref: ONRAMP }, error: null })

    await processPaymentEvent('ev-1')

    expect(setFingerprint).toHaveBeenCalledWith(['payout-success-after-terminal'])
    expect(transition).not.toHaveBeenCalled()
    expect(postLedger).not.toHaveBeenCalled()
    expect(markProcessed).toHaveBeenCalledWith('ev-1')
  })

  it('a payout webhook racing ahead of provider_transfer_ref persistence still drives', async () => {
    // ref differs from the (null) payout ref but there is NO instructions
    // match — that shape is a genuine payout event, not an onramp's.
    q('payment_events', event({ event_type: 'payment_submitted', provider_ref: 'bt-1' }))
    q('transfers', transfer('SUBMITTED', { provider_transfer_ref: null }), stateRow('SUBMITTED'))
    q('deposit_instructions', { data: null, error: null })
    transition.mockResolvedValue({})

    await processPaymentEvent('ev-1')

    expect(transition).toHaveBeenCalledTimes(1)
    expect(markProcessed).toHaveBeenCalledWith('ev-1')
  })

  it('a failed deposit_instructions read rethrows and leaves the event received', async () => {
    // pre-submission (null payout ref) — the only shape that needs the read
    q('payment_events', event({ event_type: 'payment_processed', provider_ref: ONRAMP }))
    q('transfers', transfer('PENDING_PAYMENT', { provider_transfer_ref: null }))
    q('deposit_instructions', { data: null, error: { message: 'db down' } })

    await expect(processPaymentEvent('ev-1')).rejects.toThrow('deposit-instructions read failed')
    // never guess on a failed read — the row stays 'received' for retry
    expect(markIgnored).not.toHaveBeenCalled()
    expect(markProcessed).not.toHaveBeenCalled()
    expect(transition).not.toHaveBeenCalled()
  })
})
