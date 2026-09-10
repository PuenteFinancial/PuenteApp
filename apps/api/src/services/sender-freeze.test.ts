import { describe, it, expect, vi, beforeEach } from 'vitest'

const from = vi.fn()
vi.mock('./supabase.js', () => ({
  supabaseAdmin: { from: (...args: unknown[]) => from(...args) },
}))

const recordOpsAction = vi.hoisted(() => vi.fn())
vi.mock('./ops-actions.js', () => ({
  recordOpsAction: (...args: unknown[]) => recordOpsAction(...args),
}))

const releaseSenderSuspendedHolds = vi.hoisted(() => vi.fn())
vi.mock('./payout-holds.js', () => ({
  releaseSenderSuspendedHolds: (...args: unknown[]) => releaseSenderSuspendedHolds(...args),
}))

vi.mock('@sentry/node', () => ({ addBreadcrumb: vi.fn() }))

const { unfreezeSender, listSenderSuspendedHolds, listSenderOpenDisputes } = await import(
  './sender-freeze.js'
)

const USER_ID = 'dddddddd-1111-4222-8333-444444444444'
const OPERATOR = 'aaaaaaaa-1111-4222-8333-444444444444'
const NOTE = 'sender repaid the returned debit; bank confirmed by phone'
const FROZEN_AT = '2026-09-10T18:15:00.123456+00:00'
const LATER = '2026-09-10T19:00:00.000000+00:00'

const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() }

/**
 * users.select().eq().maybeSingle() for each read, and
 * users.update().eq().eq().select() for the compare-and-swap. `reads` is
 * consumed in order so a test can make the pre-read and the post-race re-read
 * disagree.
 */
function stubUsers(reads: Array<{ data: unknown; error?: unknown }>, updateResult: { data: unknown; error?: unknown }) {
  const updateSelect = vi.fn(async () => ({ error: null, ...updateResult }))
  const updateEq3 = vi.fn(() => ({ select: updateSelect }))
  const updateEq2 = vi.fn(() => ({ eq: updateEq3 }))
  const updateEq1 = vi.fn(() => ({ eq: updateEq2 }))
  const update = vi.fn(() => ({ eq: updateEq1 }))
  let read = 0
  const maybeSingle = vi.fn(async () => {
    const next = reads[Math.min(read, reads.length - 1)]!
    read += 1
    return { error: null, ...next }
  })
  const selectEq = vi.fn(() => ({ maybeSingle }))
  const select = vi.fn(() => ({ eq: selectEq }))
  from.mockReturnValue({ select, update })
  return { update, updateEq1, updateEq2, updateEq3, readCount: () => read }
}

const call = () => unfreezeSender({ userId: USER_ID, actor: `ops:${OPERATOR}`, note: NOTE, requestId: null }, log)

beforeEach(() => {
  from.mockReset()
  recordOpsAction.mockReset().mockResolvedValue(true)
  releaseSenderSuspendedHolds.mockReset().mockResolvedValue([])
  log.info.mockClear()
  log.warn.mockClear()
  log.error.mockClear()
})

describe('unfreezeSender', () => {
  it("restores 'active', records the decision, then clears the holds the freeze left", async () => {
    const t = stubUsers([{ data: { id: USER_ID, status: 'suspended', updated_at: FROZEN_AT } }], { data: [{ id: USER_ID }] })
    releaseSenderSuspendedHolds.mockResolvedValue(['tr-1', 'tr-2'])

    const out = await call()

    expect(out).toEqual({ done: true, previousStatus: 'suspended', releasedTransferIds: ['tr-1', 'tr-2'] })
    expect(t.update).toHaveBeenCalledWith({ status: 'active' })
    // The compare-and-swap: id AND still-suspended. Without the second clause a
    // concurrent re-freeze would be silently overwritten.
    expect(t.updateEq1).toHaveBeenCalledWith('id', USER_ID)
    expect(t.updateEq2).toHaveBeenCalledWith('status', 'suspended')
    // The version guard: this UPDATE applies only to the exact row state the
    // pre-read classified, so a re-freeze in between is refused, not lifted.
    expect(t.updateEq3).toHaveBeenCalledWith('updated_at', FROZEN_AT)
    expect(releaseSenderSuspendedHolds).toHaveBeenCalledWith(
      { userId: USER_ID, actor: `ops:${OPERATOR}`, requestId: null },
      log,
    )
  })

  it('writes the decision row an examiner reads: who, why, and which direction', async () => {
    // The freeze has provenance; before this the unfreeze had none, and an
    // unfreeze is the half where a human chose to let a suspected-fraud account
    // transact again.
    stubUsers([{ data: { id: USER_ID, status: 'suspended', updated_at: FROZEN_AT } }], { data: [{ id: USER_ID }] })

    await call()

    expect(recordOpsAction).toHaveBeenCalledWith(
      expect.objectContaining({
        actor: `ops:${OPERATOR}`,
        action: 'sender_unfreeze',
        // An unfreeze is about the account, not one of the several transfers a
        // frozen sender may have.
        transferId: null,
        note: NOTE,
        before: { status: 'suspended' },
        after: { status: 'active' },
      }),
      log,
    )
  })

  it('unfreezes BEFORE releasing, because releasing first only re-holds', async () => {
    // payout-submit re-reads users.status on every run, so a release that ran
    // first would be undone by the next sweep.
    const order: string[] = []
    const updateSelect = vi.fn(async () => {
      order.push('unfreeze')
      return { data: [{ id: USER_ID }], error: null }
    })
    from.mockReturnValue({
      select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: { id: USER_ID, status: 'suspended', updated_at: FROZEN_AT }, error: null }) }) }),
      update: () => ({ eq: () => ({ eq: () => ({ eq: () => ({ select: updateSelect }) }) }) }),
    })
    releaseSenderSuspendedHolds.mockImplementation(async () => {
      order.push('release')
      return []
    })

    await call()

    expect(order).toEqual(['unfreeze', 'release'])
  })

  it('refuses an unknown user without writing anything', async () => {
    stubUsers([{ data: null }], { data: [] })
    expect(await call()).toEqual({ done: false, reason: 'user_not_found' })
    expect(recordOpsAction).not.toHaveBeenCalled()
    expect(releaseSenderSuspendedHolds).not.toHaveBeenCalled()
  })

  it.each(['active', 'waitlist'])('refuses status %s — it lifts a freeze, it never grants access', async (status) => {
    stubUsers([{ data: { id: USER_ID, status, updated_at: FROZEN_AT } }], { data: [] })
    expect(await call()).toEqual({ done: false, reason: 'not_suspended', status })
    expect(recordOpsAction).not.toHaveBeenCalled()
  })

  it('a second run is a refusal, not a silent success', async () => {
    // Replaying an unfreeze must not write a second decision row, which would
    // read as two operators independently clearing the same account.
    stubUsers([{ data: { id: USER_ID, status: 'active', updated_at: LATER } }], { data: [] })
    expect(await call()).toEqual({ done: false, reason: 'not_suspended', status: 'active' })
  })

  it('a lost race re-reads and reports the truth rather than claiming an unfreeze', async () => {
    // Pre-read said suspended; the CAS matched nothing because someone else got
    // there first. The re-read is what the caller is told.
    stubUsers(
      [{ data: { id: USER_ID, status: 'suspended', updated_at: FROZEN_AT } }, { data: { id: USER_ID, status: 'active', updated_at: LATER } }],
      { data: [] },
    )

    expect(await call()).toEqual({ done: false, reason: 'not_suspended', status: 'active' })
    expect(recordOpsAction).not.toHaveBeenCalled()
    expect(releaseSenderSuspendedHolds).not.toHaveBeenCalled()
  })

  it('refuses to lift a DIFFERENT freeze than the one the operator investigated', async () => {
    // The sequence a status-only guard accepts: suspended (dispute A) →
    // someone unfreezes → a second dispute arrives → suspended (dispute B) →
    // this UPDATE clears dispute B, which the operator never saw. The window is
    // not milliseconds: an unfreeze follows an investigation. So the row still
    // reads 'suspended' here and the answer is still no.
    stubUsers(
      [
        { data: { id: USER_ID, status: 'suspended', updated_at: FROZEN_AT } },
        { data: { id: USER_ID, status: 'suspended', updated_at: LATER } },
      ],
      { data: [] },
    )

    expect(await call()).toEqual({ done: false, reason: 'changed_underneath' })
    expect(recordOpsAction).not.toHaveBeenCalled()
    expect(releaseSenderSuspendedHolds).not.toHaveBeenCalled()
  })

  it('a broken read throws — it must never be reported as "not suspended"', async () => {
    stubUsers([{ data: null, error: { message: 'connection reset' } }], { data: [] })
    await expect(call()).rejects.toThrow(/sender load failed/)
  })

  it('a failed audit row does not undo an unfreeze that already committed', async () => {
    stubUsers([{ data: { id: USER_ID, status: 'suspended', updated_at: FROZEN_AT } }], { data: [{ id: USER_ID }] })
    recordOpsAction.mockResolvedValue(false)

    const out = await call()

    expect(out).toMatchObject({ done: true })
    // recordOpsAction pages on its own; the release still runs.
    expect(releaseSenderSuspendedHolds).toHaveBeenCalled()
  })

  it('a failed hold release does not fail the unfreeze', async () => {
    // The release pages itself and each hold stays operator-releasable from the
    // board. Reporting the unfreeze as failed would invite a retry that the
    // compare-and-swap would then refuse.
    stubUsers([{ data: { id: USER_ID, status: 'suspended', updated_at: FROZEN_AT } }], { data: [{ id: USER_ID }] })
    releaseSenderSuspendedHolds.mockResolvedValue([])

    expect(await call()).toEqual({ done: true, previousStatus: 'suspended', releasedTransferIds: [] })
  })
})

describe('listSenderOpenDisputes', () => {
  it("reads both shapes an open clawback takes, scoped to this sender", async () => {
    // The check no compare-and-swap can do: a second dispute on an
    // already-frozen sender moves nothing on the account, so the operator has
    // to be shown it.
    const order = vi.fn(async () => ({ data: [{ id: 'tr-1' }], error: null }))
    const or = vi.fn(() => ({ order }))
    const eq = vi.fn(() => ({ or }))
    const select = vi.fn(() => ({ eq }))
    from.mockReturnValue({ select })

    expect(await listSenderOpenDisputes(USER_ID)).toEqual(['tr-1'])
    expect(eq).toHaveBeenCalledWith('user_id', USER_ID)
    expect(or).toHaveBeenCalledWith('payout_hold_reason.eq.funding_disputed,state.eq.FUNDING_REVERSED')
  })

  it('throws rather than showing a falsely empty dispute list', async () => {
    // An unfreeze decided against "no open disputes" that was really a failed
    // read is the exact outcome this read exists to prevent.
    from.mockReturnValue({
      select: () => ({ eq: () => ({ or: () => ({ order: async () => ({ data: null, error: { message: 'nope' } }) }) }) }),
    })
    await expect(listSenderOpenDisputes(USER_ID)).rejects.toThrow(/sender dispute list failed/)
  })
})

describe('listSenderSuspendedHolds', () => {
  it("lists only this sender's FUNDED rows held on the freeze", async () => {
    const eq3 = vi.fn(async () => ({ data: [{ id: 'tr-1' }], error: null }))
    const eq2 = vi.fn(() => ({ eq: eq3 }))
    const eq1 = vi.fn(() => ({ eq: eq2 }))
    const select = vi.fn(() => ({ eq: eq1 }))
    from.mockReturnValue({ select })

    expect(await listSenderSuspendedHolds(USER_ID)).toEqual(['tr-1'])
    expect(eq1).toHaveBeenCalledWith('user_id', USER_ID)
    expect(eq2).toHaveBeenCalledWith('state', 'FUNDED')
    expect(eq3).toHaveBeenCalledWith('payout_hold_reason', 'sender_suspended')
  })

  it('throws on a broken read so a dry run never shows a falsely empty list', async () => {
    from.mockReturnValue({
      select: () => ({ eq: () => ({ eq: () => ({ eq: async () => ({ data: null, error: { message: 'nope' } }) }) }) }),
    })
    await expect(listSenderSuspendedHolds(USER_ID)).rejects.toThrow(/sender hold list failed/)
  })
})
