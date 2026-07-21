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

const { processPaymentEvent } = await import('./payment-event-process.js')
const { TransferRpcError } = await import('../services/transfers.js')

// from() dispenues results per table in call order.
const queues: Record<string, unknown[]> = {}
function q(table: string, ...results: unknown[]) {
  queues[table] = (queues[table] ?? []).concat(results)
}
function chain(result: unknown) {
  const c: Record<string, unknown> = {}
  for (const m of ['select', 'eq', 'in', 'update']) c[m] = () => c
  c.maybeSingle = () => Promise.resolve(result)
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
const transfer = (state: string) => ({
  data: { id: 'tr-1', state, send_amount_minor: 19801 },
  error: null,
})
const stateRow = (state: string) => ({ data: { state }, error: null })

beforeEach(() => {
  vi.clearAllMocks()
  for (const k of Object.keys(queues)) delete queues[k]
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
    q('payment_events', event({ event_type: 'returned' }))
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
