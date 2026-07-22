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

const refund = vi.hoisted(() => vi.fn())
vi.mock('../services/funding/index.js', () => ({
  getFundingProcessor: () => ({ refund: (...a: unknown[]) => refund(...a) }),
}))

const { processPaymentEvent } = await import('./payment-event-process.js')
const { TransferRpcError } = await import('../services/transfers.js')

// from() dispenues results per table in call order.
const queues: Record<string, unknown[]> = {}
function q(table: string, ...results: unknown[]) {
  queues[table] = (queues[table] ?? []).concat(results)
}
// captures the receipt disclosures.upsert(payload, opts) calls for assertions
const upsertCalls: unknown[][] = []
function chain(result: unknown) {
  const c: Record<string, unknown> = {}
  for (const m of ['select', 'eq', 'in', 'is', 'update']) c[m] = () => c
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
    send_amount_minor: 19801,
    // PR2 refund-tail fields (harmless for the pre-PR2 tests that ignore them)
    fee_amount_minor: 199,
    refund_payment_ref: null,
    funding_payment_ref: 'mockpay_1',
    idempotency_key: 'bridge-key-1',
    // PR3 receipt fields
    receive_amount_minor: 396014,
    fx_rate: 19.9997,
    ...over,
  },
  error: null,
})
const stateRow = (state: string) => ({ data: { state }, error: null })

// Queue writeReceipt's tail for a COMPLETED drive: its currentState re-read
// (transfers), the user locale load (users), and the receipt upsert (disclosures).
function queueReceipt(finalState = 'COMPLETED', preferredLanguage = 'es') {
  q('transfers', stateRow(finalState))
  q('users', { data: { preferred_language: preferredLanguage }, error: null })
  q('disclosures', { data: null, error: null })
}

beforeEach(() => {
  vi.clearAllMocks()
  for (const k of Object.keys(queues)) delete queues[k]
  upsertCalls.length = 0
  envMock.AUTO_REFUND = false
  postLedger.mockResolvedValue({ id: 'lt-1' })
  refund.mockResolvedValue({ provider: 'mock', ref: 'mockrefund_x', status: 'succeeded' })
  from.mockImplementation((table: string) => {
    const next = queues[table]?.shift()
    if (next === undefined) throw new Error(`unexpected from('${table}')`)
    return chain(next)
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
      stateRow('PAYOUT_FAILED'), // driveRefund currentState
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
    expect(refunded).toMatchObject({ fromState: 'PAYOUT_FAILED', toState: 'REFUNDED' })
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

  it('refund_payment_ref already set (webhook+poll duplicate) → skips refund(), still settles REFUNDED', async () => {
    envMock.AUTO_REFUND = true
    q('payment_events', event({ event_type: 'refunded' }))
    q(
      'transfers',
      transfer('PAYOUT_FAILED', { refund_payment_ref: 'mockrefund_prev' }), // resolveTransfer
      stateRow('PAYOUT_FAILED'), // failTransfer currentState (already failed → no-op)
      stateRow('PAYOUT_FAILED'), // driveRefund currentState
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
      stateRow('PAYOUT_FAILED'), // driveRefund currentState
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
      stateRow('COMPLETED'), // driveRefund currentState → not PAYOUT_FAILED → return
    )

    await processPaymentEvent('ev-1')

    expect(setFingerprint).toHaveBeenCalledWith(['payout-fail-after-terminal'])
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
      stateRow('REFUNDED'), // driveRefund currentState → not PAYOUT_FAILED → no-op
    )

    await processPaymentEvent('ev-1')

    // must NOT trip the post-delivery-reversal loss fingerprint on a routine dup
    expect(setFingerprint).not.toHaveBeenCalledWith(['payout-fail-after-terminal'])
    expect(transition).not.toHaveBeenCalled()
    expect(postLedger).not.toHaveBeenCalled()
    expect(refund).not.toHaveBeenCalled()
    expect(markProcessed).toHaveBeenCalledWith('ev-1')
  })

  it('a refund-tail error rethrows and leaves the event received (retryable)', async () => {
    envMock.AUTO_REFUND = true
    q('payment_events', event({ event_type: 'refunded' }))
    q('transfers', transfer('SUBMITTED'), stateRow('SUBMITTED'), stateRow('PAYOUT_FAILED'))
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
    const content = payload['content'] as { amounts: Record<string, unknown> }
    expect(content.amounts).toMatchObject({ totalMinor: 20000, receiveMinor: 396014, fxRate: '19.9997' })
    // idempotent — one receipt per transfer
    expect(opts).toMatchObject({ onConflict: 'transfer_id,type', ignoreDuplicates: true })
    expect(markProcessed).toHaveBeenCalledWith('ev-1')
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
    q('transfers', transfer('IN_FLIGHT'), stateRow('IN_FLIGHT'), stateRow('IN_FLIGHT'), stateRow('COMPLETED'))
    q('users', { data: { preferred_language: 'es' }, error: null })
    q('disclosures', { data: null, error: { message: 'disclosures db down' } })
    transition.mockResolvedValue({})

    await expect(processPaymentEvent('ev-1')).rejects.toThrow('receipt upsert failed')
    // COMPLETED ledger already posted; the event stays 'received' so a retry
    // re-runs drive() (replay no-op) and re-attempts the idempotent receipt.
    expect(markProcessed).not.toHaveBeenCalled()
  })
})
