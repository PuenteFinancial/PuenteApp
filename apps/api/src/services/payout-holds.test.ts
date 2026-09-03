import { describe, it, expect, vi, beforeEach } from 'vitest'

const from = vi.fn()
vi.mock('./supabase.js', () => ({
  supabaseAdmin: { from: (...args: unknown[]) => from(...args) },
}))

const enqueuePayoutSubmit = vi.hoisted(() => vi.fn())
vi.mock('./queue.js', () => ({
  enqueuePayoutSubmit: (...args: unknown[]) => enqueuePayoutSubmit(...args),
}))

const captureMessage = vi.hoisted(() => vi.fn())
const setFingerprint = vi.hoisted(() => vi.fn())
vi.mock('@sentry/node', () => ({
  withScope: (fn: (scope: unknown) => void) => fn({ setFingerprint, setContext: vi.fn() }),
  captureMessage: (...args: unknown[]) => captureMessage(...args),
}))

const { releaseSenderKycHolds } = await import('./payout-holds.js')

const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() }

// transfers.update().eq().eq().eq().select() — the guarded release
function transfersTable(result: { data: unknown; error: unknown }) {
  const select = vi.fn(async (..._args: unknown[]) => result)
  const eq3 = vi.fn((..._args: unknown[]) => ({ select }))
  const eq2 = vi.fn((..._args: unknown[]) => ({ eq: eq3 }))
  const eq1 = vi.fn((..._args: unknown[]) => ({ eq: eq2 }))
  const update = vi.fn((..._args: unknown[]) => ({ eq: eq1 }))
  from.mockReturnValue({ update })
  return { update, eq1, eq2, eq3, select }
}

beforeEach(() => {
  from.mockReset()
  enqueuePayoutSubmit.mockReset().mockResolvedValue('job-1')
  captureMessage.mockReset()
  setFingerprint.mockReset()
  log.info.mockClear()
  log.warn.mockClear()
  log.error.mockClear()
})

describe('releaseSenderKycHolds', () => {
  it("clears only this sender's FUNDED sender_kyc_pending rows and re-enqueues each", async () => {
    const t = transfersTable({ data: [{ id: 'tr-1' }, { id: 'tr-2' }], error: null })

    const released = await releaseSenderKycHolds('user-1', log)

    expect(released).toEqual(['tr-1', 'tr-2'])
    expect(t.update).toHaveBeenCalledWith({ payout_hold_reason: null, payout_held_at: null })
    expect(t.eq1).toHaveBeenCalledWith('user_id', 'user-1')
    expect(t.eq2).toHaveBeenCalledWith('state', 'FUNDED')
    expect(t.eq3).toHaveBeenCalledWith('payout_hold_reason', 'sender_kyc_pending')
    expect(t.select).toHaveBeenCalledWith('id')
    expect(enqueuePayoutSubmit).toHaveBeenCalledTimes(2)
    expect(enqueuePayoutSubmit).toHaveBeenCalledWith('tr-1', 'api')
    expect(enqueuePayoutSubmit).toHaveBeenCalledWith('tr-2', 'api')
    expect(log.info).toHaveBeenCalledTimes(2)
    expect(captureMessage).not.toHaveBeenCalled()
  })

  it('is a quiet no-op when nothing was held', async () => {
    transfersTable({ data: [], error: null })
    expect(await releaseSenderKycHolds('user-1', log)).toEqual([])
    expect(enqueuePayoutSubmit).not.toHaveBeenCalled()
    expect(log.info).not.toHaveBeenCalled()
  })

  it('an enqueue failure is logged, not thrown — the sweep resubmits within a minute', async () => {
    transfersTable({ data: [{ id: 'tr-1' }], error: null })
    enqueuePayoutSubmit.mockRejectedValueOnce(new Error('boss down'))
    expect(await releaseSenderKycHolds('user-1', log)).toEqual(['tr-1'])
    expect(log.warn).toHaveBeenCalledTimes(1)
  })

  it('a failed release pages (money waiting on nobody) and returns nothing', async () => {
    transfersTable({ data: null, error: { code: 'XX000' } })
    expect(await releaseSenderKycHolds('user-1', log)).toEqual([])
    expect(setFingerprint).toHaveBeenCalledWith(['sender-kyc-release-failed', 'user-1'])
    expect(captureMessage).toHaveBeenCalledWith('sender_kyc_pending release failed', 'error')
    expect(enqueuePayoutSubmit).not.toHaveBeenCalled()
  })
})
