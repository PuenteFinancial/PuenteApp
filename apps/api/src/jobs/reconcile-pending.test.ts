import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

const from = vi.fn()

vi.mock('../services/supabase.js', () => ({
  supabaseAdmin: {
    from: (...args: unknown[]) => from(...args),
  },
}))

const transition = vi.hoisted(() => vi.fn())

vi.mock('../services/transfers.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../services/transfers.js')>()
  return {
    ...actual,
    transitionTransfer: (...args: unknown[]) => transition(...args),
  }
})

const { reconcilePendingTransfers } = await import('./reconcile-pending.js')
const { TransferRpcError } = await import('../services/transfers.js')

function mockStaleSelect(result: { data: unknown; error: unknown }) {
  const lt = vi.fn().mockResolvedValue(result)
  const eq = vi.fn().mockReturnValue({ lt })
  const select = vi.fn().mockReturnValue({ eq })
  from.mockReturnValue({ select })
  return { select, eq, lt }
}

beforeEach(() => {
  from.mockReset()
  transition.mockReset()
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(new Date('2026-07-20T12:00:00.000Z'))
})

afterEach(() => vi.useRealTimers())

describe('reconcilePendingTransfers', () => {
  it('selects PENDING_PAYMENT older than 30 minutes and returns 0 when none', async () => {
    const { select, eq, lt } = mockStaleSelect({ data: [], error: null })

    const count = await reconcilePendingTransfers()

    expect(count).toBe(0)
    expect(transition).not.toHaveBeenCalled()
    expect(from).toHaveBeenCalledWith('transfers')
    expect(select).toHaveBeenCalledWith('id')
    expect(eq).toHaveBeenCalledWith('state', 'PENDING_PAYMENT')
    expect(lt).toHaveBeenCalledWith('created_at', '2026-07-20T11:30:00.000Z')
  })

  it('transitions each stale row to PAYMENT_FAILED with no ledger entries', async () => {
    mockStaleSelect({ data: [{ id: 'tr-1' }, { id: 'tr-2' }, { id: 'tr-3' }], error: null })
    transition.mockResolvedValue({})

    const count = await reconcilePendingTransfers()

    expect(count).toBe(3)
    expect(transition).toHaveBeenCalledTimes(3)
    for (const [i, id] of ['tr-1', 'tr-2', 'tr-3'].entries()) {
      const [input] = transition.mock.calls[i] as [Record<string, unknown>]
      expect(input).toEqual({
        transferId: id,
        fromState: 'PENDING_PAYMENT',
        toState: 'PAYMENT_FAILED',
        actor: 'worker:reconcile-pending',
        reason: 'funding_not_received_within_30_minutes',
      })
      expect('ledgerEntries' in input).toBe(false)
    }
  })

  it.each(['transition_conflict', 'transfer_not_found'] as const)(
    'skips a row lost to a concurrent actor (%s) without failing the batch',
    async (code) => {
      mockStaleSelect({ data: [{ id: 'tr-1' }, { id: 'tr-2' }, { id: 'tr-3' }], error: null })
      transition
        .mockResolvedValueOnce({})
        .mockRejectedValueOnce(new TransferRpcError(code))
        .mockResolvedValueOnce({})

      const count = await reconcilePendingTransfers()

      expect(count).toBe(2)
      expect(transition).toHaveBeenCalledTimes(3)
    },
  )

  it('attempts every remaining row before throwing on an unexpected error', async () => {
    mockStaleSelect({ data: [{ id: 'tr-1' }, { id: 'tr-2' }, { id: 'tr-3' }], error: null })
    transition
      .mockRejectedValueOnce(new Error('connection reset'))
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({})

    await expect(reconcilePendingTransfers()).rejects.toThrow(/1\/3 transitions failed/)
    expect(transition).toHaveBeenCalledTimes(3)
  })

  it('throws when the stale-row select fails', async () => {
    mockStaleSelect({ data: null, error: { message: 'boom' } })

    await expect(reconcilePendingTransfers()).rejects.toThrow(/select failed: boom/)
    expect(transition).not.toHaveBeenCalled()
  })
})
