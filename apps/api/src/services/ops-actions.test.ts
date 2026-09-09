import { describe, it, expect, vi, beforeEach } from 'vitest'

// recordOpsAction is the SECONDARY record of an ops write: the contract under
// test is (1) the insert carries exactly the fixed-key shape the caller built,
// and (2) it never throws — a failed provenance row pages, it does not turn a
// completed money movement into a 500.

const from = vi.fn()
vi.mock('./supabase.js', () => ({
  supabaseAdmin: { from: (...args: unknown[]) => from(...args) },
}))

const captureMessage = vi.hoisted(() => vi.fn())
const setFingerprint = vi.hoisted(() => vi.fn())
const setContext = vi.hoisted(() => vi.fn())
vi.mock('@sentry/node', () => ({
  withScope: (fn: (scope: unknown) => void) => fn({ setFingerprint, setContext }),
  captureMessage: (...args: unknown[]) => captureMessage(...args),
}))

const { recordOpsAction } = await import('./ops-actions.js')

const log = { error: vi.fn() }

const INPUT = {
  actor: 'ops:aaaaaaaa-1111-4222-8333-444444444444',
  action: 'hold_release' as const,
  transferId: 'cccccccc-1111-4222-8333-444444444444',
  reason: 'velocity_review',
  note: 'Verified the sender by phone; two sends today are hers.',
  before: { payoutHoldReason: 'velocity_review', payoutHeldAt: '2026-09-08T11:00:00.000Z' },
  after: { payoutHoldReason: null, payoutHeldAt: null },
  requestId: 'req-1',
}

beforeEach(() => {
  from.mockReset()
  captureMessage.mockReset()
  setFingerprint.mockReset()
  setContext.mockReset()
  log.error.mockClear()
})

describe('recordOpsAction', () => {
  it('inserts the row with the fixed-key shape and reports success', async () => {
    const insert = vi.fn(async () => ({ error: null }))
    from.mockReturnValue({ insert })

    expect(await recordOpsAction(INPUT, log)).toBe(true)

    expect(from).toHaveBeenCalledWith('ops_actions')
    expect(insert).toHaveBeenCalledWith({
      actor: INPUT.actor,
      action: 'hold_release',
      transfer_id: INPUT.transferId,
      reason: 'velocity_review',
      note: INPUT.note,
      before: INPUT.before,
      after: INPUT.after,
      request_id: 'req-1',
    })
    expect(log.error).not.toHaveBeenCalled()
    expect(captureMessage).not.toHaveBeenCalled()
  })

  it('a rejected insert pages per action and returns false — never throws', async () => {
    from.mockReturnValue({ insert: vi.fn(async () => ({ error: { code: '23514' } })) })

    expect(await recordOpsAction(INPUT, log)).toBe(false)

    expect(setFingerprint).toHaveBeenCalledWith(['ops-actions-write-failed', 'hold_release'])
    expect(captureMessage).toHaveBeenCalledWith('ops_actions write failed', 'error')
    expect(log.error).toHaveBeenCalledTimes(1)
    // The operator's note is free text and stays out of logs and Sentry.
    const logged = JSON.stringify(log.error.mock.calls[0])
    const context = JSON.stringify(setContext.mock.calls[0])
    expect(logged).not.toContain(INPUT.note)
    expect(context).not.toContain(INPUT.note)
    expect(logged).toContain('23514')
  })

  it('a thrown client error is caught the same way', async () => {
    from.mockImplementation(() => {
      throw new Error('fetch failed')
    })

    await expect(recordOpsAction(INPUT, log)).resolves.toBe(false)
    expect(setFingerprint).toHaveBeenCalledWith(['ops-actions-write-failed', 'hold_release'])
    expect(captureMessage).toHaveBeenCalledTimes(1)
  })

  it('carries a null transfer for treasury-level actions', async () => {
    const insert = vi.fn(async () => ({ error: null }))
    from.mockReturnValue({ insert })
    await recordOpsAction(
      { ...INPUT, action: 'float_topup', transferId: null, reason: null, note: null, before: {}, after: { amountMinor: 1 } },
      log,
    )
    expect(insert).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'float_topup', transfer_id: null, reason: null, note: null }),
    )
  })
})
