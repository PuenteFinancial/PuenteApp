import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

const from = vi.fn()
vi.mock('../services/supabase.js', () => ({
  supabaseAdmin: { from: (...args: unknown[]) => from(...args) },
}))

const enqueueSubmit = vi.hoisted(() => vi.fn())
const enqueueEvent = vi.hoisted(() => vi.fn())
vi.mock('../services/queue.js', () => ({
  enqueuePayoutSubmit: (...args: unknown[]) => enqueueSubmit(...args),
  enqueuePaymentEventProcess: (...args: unknown[]) => enqueueEvent(...args),
}))

const { sweepPayouts } = await import('./payout-sweep.js')

function transfersChain(result: { data: unknown; error: unknown }) {
  const or = vi.fn().mockResolvedValue(result)
  const is = vi.fn().mockReturnValue({ or })
  const eq = vi.fn().mockReturnValue({ is })
  const select = vi.fn().mockReturnValue({ eq })
  return { select, eq, is, or }
}

function eventsChain(result: { data: unknown; error: unknown }) {
  const lt = vi.fn().mockResolvedValue(result)
  const eq = vi.fn().mockReturnValue({ lt })
  const select = vi.fn().mockReturnValue({ eq })
  return { select, eq, lt }
}

function setup(
  transfers: { data: unknown; error: unknown },
  events: { data: unknown; error: unknown },
) {
  const t = transfersChain(transfers)
  const e = eventsChain(events)
  from.mockImplementation((table: string) => {
    if (table === 'transfers') return t
    if (table === 'payment_events') return e
    throw new Error(`unexpected supabase.from('${table}')`)
  })
  return { t, e }
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(new Date('2026-07-20T12:00:00.000Z'))
})

afterEach(() => vi.useRealTimers())

describe('sweepPayouts', () => {
  it('returns 0 and enqueues nothing when both scans are empty', async () => {
    const { t, e } = setup({ data: [], error: null }, { data: [], error: null })
    expect(await sweepPayouts()).toBe(0)
    expect(enqueueSubmit).not.toHaveBeenCalled()
    expect(enqueueEvent).not.toHaveBeenCalled()
    // The sweep scan shape: FUNDED, unheld, unclaimed OR stale-claim-no-ref
    expect(t.eq).toHaveBeenCalledWith('state', 'FUNDED')
    expect(t.is).toHaveBeenCalledWith('payout_hold_reason', null)
    expect(t.or).toHaveBeenCalledWith(
      'submit_attempted_at.is.null,and(submit_attempted_at.lt.2026-07-20T11:50:00.000Z,provider_transfer_ref.is.null)',
    )
    // Stale-received events: strictly older than 5 minutes
    expect(e.eq).toHaveBeenCalledWith('status', 'received')
    expect(e.lt).toHaveBeenCalledWith('received_at', '2026-07-20T11:55:00.000Z')
  })

  it('enqueues a submit per eligible transfer and a process per stale event', async () => {
    setup(
      { data: [{ id: 'tr-1' }, { id: 'tr-2' }], error: null },
      { data: [{ id: 'ev-1' }], error: null },
    )
    expect(await sweepPayouts()).toBe(3)
    expect(enqueueSubmit).toHaveBeenCalledTimes(2)
    expect(enqueueSubmit).toHaveBeenNthCalledWith(1, 'tr-1')
    expect(enqueueSubmit).toHaveBeenNthCalledWith(2, 'tr-2')
    expect(enqueueEvent).toHaveBeenCalledWith('ev-1')
  })

  it('attempts every enqueue before throwing on a failure', async () => {
    setup(
      { data: [{ id: 'tr-1' }, { id: 'tr-2' }], error: null },
      { data: [{ id: 'ev-1' }], error: null },
    )
    enqueueSubmit.mockRejectedValueOnce(new Error('boss down')).mockResolvedValueOnce('job-2')
    await expect(sweepPayouts()).rejects.toThrow(/1 enqueue\(s\) failed/)
    expect(enqueueSubmit).toHaveBeenCalledTimes(2)
    expect(enqueueEvent).toHaveBeenCalledTimes(1) // events still swept
  })

  it('throws when the transfers scan fails, before any enqueue', async () => {
    setup({ data: null, error: { message: 'boom' } }, { data: [], error: null })
    await expect(sweepPayouts()).rejects.toThrow(/transfers select failed: boom/)
    expect(enqueueSubmit).not.toHaveBeenCalled()
  })

  it('throws when the events scan fails, before any enqueue', async () => {
    setup({ data: [], error: null }, { data: null, error: { message: 'boom' } })
    await expect(sweepPayouts()).rejects.toThrow(/events select failed: boom/)
    expect(enqueueEvent).not.toHaveBeenCalled()
  })
})
