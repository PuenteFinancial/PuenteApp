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

// ── Slice 2: reading the record back ─────────────────────────────────────────

const { deriveChanges, listRecentOpsActions, listOpsActionsForTransfer, ACTIVITY_FEED_LIMIT } = await import('./ops-actions.js')

// from('ops_actions').select().eq()?.order().limit() → thenable result
function readChain(result: { data?: unknown; error?: unknown }) {
  const resolved = { data: result.data ?? null, error: result.error ?? null }
  const b: Record<string, ReturnType<typeof vi.fn>> & { then?: (resolve: (v: unknown) => void) => void } = {} as never
  for (const m of ['select', 'eq', 'order', 'limit'] as const) b[m] = vi.fn(() => b)
  b.then = (resolve) => resolve(resolved)
  from.mockReturnValue(b)
  return b
}

const RAW = {
  id: 'act-1',
  created_at: '2026-09-09T12:00:00.000Z',
  actor: 'ops:u1',
  action: 'hold_release',
  transfer_id: 'cccccccc-1111-4222-8333-444444444444',
  reason: 'velocity_review',
}

describe('deriveChanges', () => {
  it('lists changed keys in first-seen order, strings raw, other values as JSON, null for absent', () => {
    expect(
      deriveChanges(
        { payoutHoldReason: 'velocity_review', payoutHeldAt: '2026-09-09T11:00:00.000Z', same: 1 },
        { payoutHoldReason: null, payoutHeldAt: null, same: 1, ledgerComplete: true, nested: { a: 1 } },
      ),
    ).toEqual([
      { key: 'payoutHoldReason', before: 'velocity_review', after: null },
      { key: 'payoutHeldAt', before: '2026-09-09T11:00:00.000Z', after: null },
      { key: 'ledgerComplete', before: null, after: 'true' },
      { key: 'nested', before: null, after: '{"a":1}' },
    ])
  })

  it('treats a non-object side as empty instead of throwing', () => {
    expect(deriveChanges(null, { outcome: 'refunded' })).toEqual([{ key: 'outcome', before: null, after: 'refunded' }])
    expect(deriveChanges(['x'], 'nope')).toEqual([])
    expect(deriveChanges({}, {})).toEqual([])
  })
})

describe('listRecentOpsActions', () => {
  it('selects ONLY the six feed columns, newest first, bounded by the limit', async () => {
    const c = readChain({ data: [RAW] })
    const rows = await listRecentOpsActions()
    expect(from).toHaveBeenCalledWith('ops_actions')
    expect(c.select).toHaveBeenCalledWith('id, created_at, actor, action, transfer_id, reason')
    expect(c.order).toHaveBeenCalledWith('created_at', { ascending: false })
    expect(c.limit).toHaveBeenCalledWith(ACTIVITY_FEED_LIMIT)
    expect(c.eq).not.toHaveBeenCalled()
    expect(rows).toEqual([
      { id: 'act-1', createdAt: RAW.created_at, actor: 'ops:u1', action: 'hold_release', transferId: RAW.transfer_id, reason: 'velocity_review' },
    ])
    // What is not selected cannot leak: no note/before/after key on a feed row.
    expect(Object.keys(rows[0]!).sort()).toEqual(['action', 'actor', 'createdAt', 'id', 'reason', 'transferId'])
  })

  it('fails closed on a read error', async () => {
    readChain({ error: { message: 'db down' } })
    await expect(listRecentOpsActions()).rejects.toThrow('ops activity feed select failed: db down')
  })
})

describe('listOpsActionsForTransfer', () => {
  it('reads the history with note + before/after, scoped to the transfer, and derives the changes', async () => {
    const c = readChain({
      data: [
        {
          ...RAW,
          note: 'Verified by phone.',
          before: { payoutHoldReason: 'velocity_review', payoutHeldAt: '2026-09-09T11:00:00.000Z' },
          after: { payoutHoldReason: null, payoutHeldAt: null },
          request_id: 'req-1',
        },
      ],
    })
    const rows = await listOpsActionsForTransfer(RAW.transfer_id)
    expect(c.select).toHaveBeenCalledWith('id, created_at, actor, action, transfer_id, reason, note, before, after, request_id')
    expect(c.eq).toHaveBeenCalledWith('transfer_id', RAW.transfer_id)
    expect(c.order).toHaveBeenCalledWith('created_at', { ascending: false })
    expect(c.limit).toHaveBeenCalledWith(1000)
    expect(rows).toEqual([
      {
        id: 'act-1',
        createdAt: RAW.created_at,
        actor: 'ops:u1',
        action: 'hold_release',
        transferId: RAW.transfer_id,
        reason: 'velocity_review',
        note: 'Verified by phone.',
        changes: [
          { key: 'payoutHoldReason', before: 'velocity_review', after: null },
          { key: 'payoutHeldAt', before: '2026-09-09T11:00:00.000Z', after: null },
        ],
        requestId: 'req-1',
      },
    ])
    // The raw jsonb never reaches the caller.
    expect('before' in rows[0]!).toBe(false)
  })

  it('throws at the PostgREST cap rather than presenting a truncated history as complete', async () => {
    readChain({ data: Array.from({ length: 1000 }, (_, i) => ({ ...RAW, id: `a${i}`, note: null, before: {}, after: {}, request_id: null })) })
    await expect(listOpsActionsForTransfer(RAW.transfer_id)).rejects.toThrow(/1000-row PostgREST cap/)
  })
})
