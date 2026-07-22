import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

const from = vi.fn()
vi.mock('../services/supabase.js', () => ({
  supabaseAdmin: { from: (...a: unknown[]) => from(...a) },
}))

const getBridgeTransfer = vi.hoisted(() => vi.fn())
vi.mock('../services/bridge.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../services/bridge.js')>()
  return { ...actual, getBridgeTransfer: (...a: unknown[]) => getBridgeTransfer(...a) }
})

const recordEvent = vi.hoisted(() => vi.fn())
vi.mock('../services/payment-events.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../services/payment-events.js')>()
  return { ...actual, recordEvent: (...a: unknown[]) => recordEvent(...a) }
})

const enqueueEvent = vi.hoisted(() => vi.fn())
vi.mock('../services/queue.js', () => ({
  enqueuePaymentEventProcess: (...a: unknown[]) => enqueueEvent(...a),
}))

const captureMessage = vi.hoisted(() => vi.fn())
const setFingerprint = vi.hoisted(() => vi.fn())
vi.mock('@sentry/node', () => ({
  withScope: (fn: (s: unknown) => void) => fn({ setFingerprint, setContext: vi.fn() }),
  captureMessage: (...a: unknown[]) => captureMessage(...a),
}))

const envMock = vi.hoisted(() => ({ AUTO_REFUND: false }))
vi.mock('../config/env.js', () => ({ env: envMock }))

const { pollPayouts } = await import('./payout-poll.js')

function selectResult(result: { data: unknown; error: unknown }) {
  const inFn = vi.fn().mockResolvedValue(result)
  const select = vi.fn().mockReturnValue({ in: inFn })
  from.mockReturnValue({ select })
  return { select, in: inFn }
}

// AUTO_REFUND-on: first from() is the in-flight .in() query, second is the
// refund-pending .eq().not().is() self-heal query.
function selectHeal(inFlight: unknown[], refundPending: unknown[]) {
  const isFn = vi.fn().mockResolvedValue({ data: refundPending, error: null })
  from
    .mockReturnValueOnce({
      select: vi.fn().mockReturnValue({
        in: vi.fn().mockResolvedValue({ data: inFlight, error: null }),
      }),
    })
    .mockReturnValueOnce({
      select: vi.fn().mockReturnValue({
        eq: vi.fn().mockReturnValue({ not: vi.fn().mockReturnValue({ is: isFn }) }),
      }),
    })
  return { is: isFn }
}

beforeEach(() => {
  vi.clearAllMocks()
  envMock.AUTO_REFUND = false
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(new Date('2026-07-21T12:00:00.000Z'))
})
afterEach(() => vi.useRealTimers())

describe('pollPayouts', () => {
  it('selects SUBMITTED/IN_FLIGHT and returns 0 when none', async () => {
    const { select, in: inFn } = selectResult({ data: [], error: null })
    expect(await pollPayouts()).toBe(0)
    expect(select).toHaveBeenCalledWith('id, provider_transfer_ref, submit_attempted_at')
    expect(inFn).toHaveBeenCalledWith('state', ['SUBMITTED', 'IN_FLIGHT'])
    expect(getBridgeTransfer).not.toHaveBeenCalled()
  })

  it('skips rows with no provider_transfer_ref (sweep owns those)', async () => {
    selectResult({ data: [{ id: 'tr-1', provider_transfer_ref: null, submit_attempted_at: null }], error: null })
    expect(await pollPayouts()).toBe(0)
    expect(getBridgeTransfer).not.toHaveBeenCalled()
  })

  it('synthesizes and enqueues a new bridge_poll event', async () => {
    selectResult({
      data: [{ id: 'tr-1', provider_transfer_ref: 'bt-1', submit_attempted_at: '2026-07-21T11:59:00.000Z' }],
      error: null,
    })
    getBridgeTransfer.mockResolvedValue({ bridgeTransferId: 'bt-1', state: 'payment_processed', sourceAmount: '198.55' })
    recordEvent.mockResolvedValue({ id: 'ev-1', inserted: true })
    expect(await pollPayouts()).toBe(1)
    expect(recordEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        source: 'bridge_poll',
        externalEventId: 'bt-1:payment_processed',
        eventType: 'payment_processed',
        transferId: 'tr-1',
        providerRef: 'bt-1',
      }),
    )
    expect(enqueueEvent).toHaveBeenCalledWith('ev-1')
  })

  it('does not re-enqueue an already-recorded state (dedupe)', async () => {
    selectResult({
      data: [{ id: 'tr-1', provider_transfer_ref: 'bt-1', submit_attempted_at: '2026-07-21T11:59:00.000Z' }],
      error: null,
    })
    getBridgeTransfer.mockResolvedValue({ bridgeTransferId: 'bt-1', state: 'payment_submitted', sourceAmount: '198.55' })
    recordEvent.mockResolvedValue({ id: 'ev-1', inserted: false })
    expect(await pollPayouts()).toBe(0)
    expect(enqueueEvent).not.toHaveBeenCalled()
  })

  it('alerts when a transfer sits in_review > 1h past submission', async () => {
    selectResult({
      data: [{ id: 'tr-1', provider_transfer_ref: 'bt-1', submit_attempted_at: '2026-07-21T10:30:00.000Z' }],
      error: null,
    })
    getBridgeTransfer.mockResolvedValue({ bridgeTransferId: 'bt-1', state: 'in_review', sourceAmount: '' })
    recordEvent.mockResolvedValue({ id: 'ev-1', inserted: true })
    await pollPayouts()
    expect(setFingerprint).toHaveBeenCalledWith(['payout-in-review-stale', 'tr-1'])
    expect(captureMessage).toHaveBeenCalled()
  })

  it('does NOT alert for a fresh in_review (routine transient state)', async () => {
    selectResult({
      data: [{ id: 'tr-1', provider_transfer_ref: 'bt-1', submit_attempted_at: '2026-07-21T11:59:00.000Z' }],
      error: null,
    })
    getBridgeTransfer.mockResolvedValue({ bridgeTransferId: 'bt-1', state: 'in_review', sourceAmount: '' })
    recordEvent.mockResolvedValue({ id: 'ev-1', inserted: true })
    await pollPayouts()
    expect(captureMessage).not.toHaveBeenCalled()
  })

  it('AUTO_REFUND off: only the in-flight query runs — PAYOUT_FAILED rows are a human’s job', async () => {
    envMock.AUTO_REFUND = false
    selectResult({ data: [], error: null })
    expect(await pollPayouts()).toBe(0)
    expect(from).toHaveBeenCalledTimes(1) // no second (refund-pending) query
  })

  it('AUTO_REFUND on: re-synthesizes a missed terminal refunded for a PAYOUT_FAILED+refund_null transfer', async () => {
    envMock.AUTO_REFUND = true
    const { is } = selectHeal(
      [], // no in-flight transfers
      [{ id: 'tr-9', provider_transfer_ref: 'bt-9', submit_attempted_at: '2026-07-21T11:00:00.000Z' }],
    )
    getBridgeTransfer.mockResolvedValue({ bridgeTransferId: 'bt-9', state: 'refunded', sourceAmount: '' })
    recordEvent.mockResolvedValue({ id: 'ev-9', inserted: true })

    expect(await pollPayouts()).toBe(1)
    expect(is).toHaveBeenCalledWith('refund_payment_ref', null) // the self-heal gate
    expect(getBridgeTransfer).toHaveBeenCalledWith('bt-9')
    expect(recordEvent).toHaveBeenCalledWith(
      expect.objectContaining({ externalEventId: 'bt-9:refunded', eventType: 'refunded', transferId: 'tr-9' }),
    )
    expect(enqueueEvent).toHaveBeenCalledWith('ev-9')
  })

  it('AUTO_REFUND on: an already-recorded refunded state does not re-enqueue (dedupe)', async () => {
    envMock.AUTO_REFUND = true
    selectHeal([], [{ id: 'tr-9', provider_transfer_ref: 'bt-9', submit_attempted_at: null }])
    getBridgeTransfer.mockResolvedValue({ bridgeTransferId: 'bt-9', state: 'refunded', sourceAmount: '' })
    recordEvent.mockResolvedValue({ id: 'ev-9', inserted: false })
    expect(await pollPayouts()).toBe(0)
    expect(enqueueEvent).not.toHaveBeenCalled()
  })

  it('one transfer failing to poll does not sink the sweep; it throws after all', async () => {
    selectResult({
      data: [
        { id: 'tr-1', provider_transfer_ref: 'bt-1', submit_attempted_at: '2026-07-21T11:59:00.000Z' },
        { id: 'tr-2', provider_transfer_ref: 'bt-2', submit_attempted_at: '2026-07-21T11:59:00.000Z' },
      ],
      error: null,
    })
    getBridgeTransfer
      .mockRejectedValueOnce(new Error('bridge 503'))
      .mockResolvedValueOnce({ bridgeTransferId: 'bt-2', state: 'payment_submitted', sourceAmount: '198.55' })
    recordEvent.mockResolvedValue({ id: 'ev-2', inserted: true })
    await expect(pollPayouts()).rejects.toThrow(/1\/2 polls failed/)
    expect(enqueueEvent).toHaveBeenCalledWith('ev-2') // tr-2 still processed
  })
})
