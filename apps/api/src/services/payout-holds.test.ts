import { describe, it, expect, vi, beforeEach } from 'vitest'

const from = vi.fn()
vi.mock('./supabase.js', () => ({
  supabaseAdmin: { from: (...args: unknown[]) => from(...args) },
}))

const enqueuePayoutSubmit = vi.hoisted(() => vi.fn())
vi.mock('./queue.js', () => ({
  enqueuePayoutSubmit: (...args: unknown[]) => enqueuePayoutSubmit(...args),
}))

const recordOpsAction = vi.hoisted(() => vi.fn())
vi.mock('./ops-actions.js', () => ({
  recordOpsAction: (...args: unknown[]) => recordOpsAction(...args),
}))

const captureMessage = vi.hoisted(() => vi.fn())
const setFingerprint = vi.hoisted(() => vi.fn())
vi.mock('@sentry/node', () => ({
  withScope: (fn: (scope: unknown) => void) => fn({ setFingerprint, setContext: vi.fn() }),
  captureMessage: (...args: unknown[]) => captureMessage(...args),
}))

const { releaseSenderKycHolds, releaseHold, releaseDestinationPayabilityHolds, RELEASABLE_HOLD_REASONS } =
  await import('./payout-holds.js')

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
  recordOpsAction.mockReset().mockResolvedValue(true)
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

// ---------------------------------------------------------------------------
// releaseDestinationPayabilityHolds: the LATE-registration auto-release.
// ---------------------------------------------------------------------------

// transfers.update().eq().eq().eq().in().select() — one .in() more than the
// KYC release, and that .in() IS the narrowing this whole function is for.
function payabilityTable(result: { data: unknown; error: unknown }) {
  const select = vi.fn(async (..._args: unknown[]) => result)
  const inFilter = vi.fn((..._args: unknown[]) => ({ select }))
  const eq3 = vi.fn((..._args: unknown[]) => ({ in: inFilter }))
  const eq2 = vi.fn((..._args: unknown[]) => ({ eq: eq3 }))
  const eq1 = vi.fn((..._args: unknown[]) => ({ eq: eq2 }))
  const update = vi.fn((..._args: unknown[]) => ({ eq: eq1 }))
  from.mockReturnValue({ update })
  return { update, eq1, eq2, eq3, inFilter, select }
}

const registration = (destinationIds: string[]) => ({
  userId: 'user-1',
  destinationIds,
  actor: 'webhook:bridge',
  requestId: 'req-9',
})

describe('releaseDestinationPayabilityHolds', () => {
  it('releases only FUNDED payability holds on the destinations this pass registered', async () => {
    const t = payabilityTable({ data: [{ id: 'tr-1' }], error: null })

    const released = await releaseDestinationPayabilityHolds(registration(['dest-1', 'dest-2']), log)

    expect(released).toEqual(['tr-1'])
    expect(t.update).toHaveBeenCalledWith({ payout_hold_reason: null, payout_held_at: null })
    expect(t.eq1).toHaveBeenCalledWith('user_id', 'user-1')
    expect(t.eq2).toHaveBeenCalledWith('state', 'FUNDED')
    // The compare-and-swap: a row re-held for another reason is left alone.
    expect(t.eq3).toHaveBeenCalledWith('payout_hold_reason', 'payability')
    // The narrowing that keeps the other payability causes held.
    expect(t.inFilter).toHaveBeenCalledWith('payout_destination_id', ['dest-1', 'dest-2'])
    expect(t.select).toHaveBeenCalledWith('id')
  })

  it('re-enqueues the submit for each released transfer', async () => {
    payabilityTable({ data: [{ id: 'tr-1' }, { id: 'tr-2' }], error: null })

    await releaseDestinationPayabilityHolds(registration(['dest-1']), log)

    expect(enqueuePayoutSubmit).toHaveBeenCalledTimes(2)
    expect(enqueuePayoutSubmit).toHaveBeenCalledWith('tr-1', 'api')
    expect(enqueuePayoutSubmit).toHaveBeenCalledWith('tr-2', 'api')
    expect(log.info).toHaveBeenCalledTimes(2)
  })

  it('records an ops_actions row per release, so the board shows the system did it', async () => {
    payabilityTable({ data: [{ id: 'tr-1' }], error: null })

    await releaseDestinationPayabilityHolds(registration(['dest-1']), log)

    expect(recordOpsAction).toHaveBeenCalledTimes(1)
    expect(recordOpsAction).toHaveBeenCalledWith(
      {
        actor: 'webhook:bridge',
        action: 'hold_release',
        transferId: 'tr-1',
        reason: 'payability',
        note: null,
        before: { payoutHoldReason: 'payability', providerAccountRef: 'missing' },
        after: { payoutHoldReason: null, providerAccountRef: 'registered' },
        requestId: 'req-9',
      },
      log,
    )
  })

  it('never queries when the pass registered nothing', async () => {
    // The common case by far: an approval webhook for a sender with no
    // pending destinations must not cost a write.
    const t = payabilityTable({ data: [], error: null })
    expect(await releaseDestinationPayabilityHolds(registration([]), log)).toEqual([])
    expect(t.update).not.toHaveBeenCalled()
    expect(recordOpsAction).not.toHaveBeenCalled()
    expect(enqueuePayoutSubmit).not.toHaveBeenCalled()
  })

  it('is quiet when the destinations registered but nothing was held on them', async () => {
    payabilityTable({ data: [], error: null })
    expect(await releaseDestinationPayabilityHolds(registration(['dest-1']), log)).toEqual([])
    expect(recordOpsAction).not.toHaveBeenCalled()
    expect(enqueuePayoutSubmit).not.toHaveBeenCalled()
    expect(log.info).not.toHaveBeenCalled()
  })

  it('an enqueue failure is logged, not thrown — the sweep resubmits within a minute', async () => {
    payabilityTable({ data: [{ id: 'tr-1' }], error: null })
    enqueuePayoutSubmit.mockRejectedValueOnce(new Error('boss down'))

    expect(await releaseDestinationPayabilityHolds(registration(['dest-1']), log)).toEqual(['tr-1'])
    expect(log.warn).toHaveBeenCalledTimes(1)
  })

  it('a failed release pages and returns nothing, leaving the hold for the board', async () => {
    payabilityTable({ data: null, error: { code: 'XX000' } })

    expect(await releaseDestinationPayabilityHolds(registration(['dest-1']), log)).toEqual([])
    expect(setFingerprint).toHaveBeenCalledWith(['payability-registration-release-failed', 'user-1'])
    expect(captureMessage).toHaveBeenCalledWith(
      'payability release after destination registration failed',
      'error',
    )
    expect(enqueuePayoutSubmit).not.toHaveBeenCalled()
    expect(recordOpsAction).not.toHaveBeenCalled()
  })

  it('the release it writes is one an operator is still allowed to make by hand', async () => {
    // If payability ever left RELEASABLE_HOLD_REASONS this auto-release would
    // be clearing a hold the board no longer offers — a divergence worth
    // failing on rather than discovering in production.
    expect(RELEASABLE_HOLD_REASONS).toContain('payability')
  })
})

// ---------------------------------------------------------------------------
// releaseHold (ops board slice 1 / O-B): the runbook SQL as a service.
// ---------------------------------------------------------------------------

const TRANSFER = 'cccccccc-1111-4222-8333-444444444444'
const ACTOR = 'ops:aaaaaaaa-1111-4222-8333-444444444444'
const HELD_AT = '2026-09-08T11:00:00.000Z'
const NOTE = 'Spoke with the sender; both sends today are legitimate.'

type HoldRow = { id: string; state: string; payout_hold_reason: string | null; payout_held_at: string | null }

// The service reads (select().eq().maybeSingle()) then writes (update chain).
// `reads` is consumed in order: pre-read first, then the optional post-CAS
// re-read. `updated` is the UPDATE's returned rows.
function holdScenario(reads: Array<HoldRow | null>, updated: Array<{ id: string }> | { error: { message: string } }) {
  const readQueue = [...reads]
  const maybeSingle = vi.fn(async () => ({ data: readQueue.shift() ?? null, error: null }))
  const selectEq = vi.fn(() => ({ maybeSingle }))
  const select = vi.fn(() => ({ eq: selectEq }))

  const updateResult = 'error' in updated ? { data: null, error: updated.error } : { data: updated, error: null }
  const updateSelect = vi.fn(async (..._args: unknown[]) => updateResult)
  const eq3 = vi.fn((..._args: unknown[]) => ({ select: updateSelect }))
  const eq2 = vi.fn((..._args: unknown[]) => ({ eq: eq3 }))
  const eq1 = vi.fn((..._args: unknown[]) => ({ eq: eq2 }))
  const update = vi.fn((..._args: unknown[]) => ({ eq: eq1 }))

  from.mockImplementation(() => ({ select, update }))
  return { select, selectEq, maybeSingle, update, eq1, eq2, eq3, updateSelect }
}

const held = (reason: string | null, state = 'FUNDED'): HoldRow => ({
  id: TRANSFER,
  state,
  payout_hold_reason: reason,
  payout_held_at: reason ? HELD_AT : null,
})

const input = { transferId: TRANSFER, reason: 'velocity_review' as const, actor: ACTOR, note: NOTE, requestId: 'req-1' }

describe('releaseHold', () => {
  it('offers exactly the four human-actioned reasons — sender_kyc_pending is not one', () => {
    expect([...RELEASABLE_HOLD_REASONS].sort()).toEqual(['fx_drift', 'payability', 'submit_error', 'velocity_review'])
  })

  it('releases with the runbook compare-and-swap, records provenance, and enqueues the submit', async () => {
    const s = holdScenario([held('velocity_review')], [{ id: TRANSFER }])

    const out = await releaseHold(input, log)

    expect(out).toEqual({ done: true, outcome: 'released', enqueued: true })
    // Pre-read columns: the four the classification and the `before` need.
    expect(s.select).toHaveBeenCalledWith('id, state, payout_hold_reason, payout_held_at')
    expect(s.selectEq).toHaveBeenCalledWith('id', TRANSFER)
    // The CAS, verbatim from docs/runbooks/payout-holds.md.
    expect(s.update).toHaveBeenCalledWith({ payout_hold_reason: null, payout_held_at: null })
    expect(s.eq1).toHaveBeenCalledWith('id', TRANSFER)
    expect(s.eq2).toHaveBeenCalledWith('state', 'FUNDED')
    expect(s.eq3).toHaveBeenCalledWith('payout_hold_reason', 'velocity_review')
    expect(s.updateSelect).toHaveBeenCalledWith('id')
    // Provenance: fixed keys, the reason as machine vocabulary, the note verbatim.
    expect(recordOpsAction).toHaveBeenCalledTimes(1)
    expect(recordOpsAction).toHaveBeenCalledWith(
      {
        actor: ACTOR,
        action: 'hold_release',
        transferId: TRANSFER,
        reason: 'velocity_review',
        note: NOTE,
        before: { payoutHoldReason: 'velocity_review', payoutHeldAt: HELD_AT },
        after: { payoutHoldReason: null, payoutHeldAt: null },
        requestId: 'req-1',
      },
      log,
    )
    expect(enqueuePayoutSubmit).toHaveBeenCalledWith(TRANSFER, 'api')
    expect(log.info).toHaveBeenCalledWith(
      expect.objectContaining({ audit: true, transferId: TRANSFER, reason: 'velocity_review', actor: ACTOR }),
      'payout hold released by ops',
    )
    // The note is operator free text: never in the audit log line.
    expect(JSON.stringify(log.info.mock.calls)).not.toContain(NOTE)
  })

  it('an enqueue failure still counts as released (sweep heals) and says so', async () => {
    holdScenario([held('velocity_review')], [{ id: TRANSFER }])
    enqueuePayoutSubmit.mockRejectedValueOnce(new Error('boss down'))

    expect(await releaseHold(input, log)).toEqual({ done: true, outcome: 'released', enqueued: false })
    expect(recordOpsAction).toHaveBeenCalledTimes(1)
    expect(log.warn).toHaveBeenCalledTimes(1)
  })

  it('a failed provenance write does not undo or hide the release', async () => {
    holdScenario([held('velocity_review')], [{ id: TRANSFER }])
    recordOpsAction.mockResolvedValue(false)
    expect(await releaseHold(input, log)).toMatchObject({ done: true, outcome: 'released' })
    expect(enqueuePayoutSubmit).toHaveBeenCalledTimes(1)
  })

  describe('refuses before writing', () => {
    it.each([
      [null, { done: false, reason: 'transfer_not_found' }],
      [held('velocity_review', 'SUBMITTED'), { done: false, reason: 'not_funded', state: 'SUBMITTED' }],
      [held(null), { done: false, reason: 'not_held' }],
      [held('fx_drift'), { done: false, reason: 'hold_reason_mismatch', actual: 'fx_drift' }],
      // The auto-released hold: an operator must never clear it by hand.
      [held('sender_kyc_pending'), { done: false, reason: 'hold_reason_mismatch', actual: 'sender_kyc_pending' }],
    ])('pre-read %j → %j, no UPDATE, no provenance, no enqueue', async (row, expected) => {
      const s = holdScenario([row], [{ id: TRANSFER }])
      expect(await releaseHold(input, log)).toEqual(expected)
      expect(s.update).not.toHaveBeenCalled()
      expect(recordOpsAction).not.toHaveBeenCalled()
      expect(enqueuePayoutSubmit).not.toHaveBeenCalled()
    })
  })

  describe('loses the race between pre-read and UPDATE', () => {
    it('re-reads once and reports what is true now (row moved to SUBMITTED)', async () => {
      const s = holdScenario([held('velocity_review'), held(null, 'SUBMITTED')], [])
      expect(await releaseHold(input, log)).toEqual({ done: false, reason: 'not_funded', state: 'SUBMITTED' })
      expect(s.maybeSingle).toHaveBeenCalledTimes(2)
      expect(recordOpsAction).not.toHaveBeenCalled()
      expect(enqueuePayoutSubmit).not.toHaveBeenCalled()
    })

    it('re-held under another reason → hold_reason_mismatch', async () => {
      holdScenario([held('velocity_review'), held('submit_error')], [])
      expect(await releaseHold(input, log)).toEqual({ done: false, reason: 'hold_reason_mismatch', actual: 'submit_error' })
    })

    it('someone else released it first → not_held (never a phantom release)', async () => {
      holdScenario([held('velocity_review'), held(null)], [])
      expect(await releaseHold(input, log)).toEqual({ done: false, reason: 'not_held' })
    })

    it('re-read still matches (unreachable in practice) → not_held rather than a fake success', async () => {
      holdScenario([held('velocity_review'), held('velocity_review')], [])
      expect(await releaseHold(input, log)).toEqual({ done: false, reason: 'not_held' })
    })
  })

  describe('fails closed', () => {
    it('throws when the pre-read errors', async () => {
      const maybeSingle = vi.fn(async () => ({ data: null, error: { message: 'boom' } }))
      from.mockImplementation(() => ({ select: () => ({ eq: () => ({ maybeSingle }) }) }))
      await expect(releaseHold(input, log)).rejects.toThrow('hold release transfer load failed')
    })

    it('throws when the UPDATE errors — nothing recorded, nothing enqueued', async () => {
      holdScenario([held('velocity_review')], { error: { message: 'boom' } })
      await expect(releaseHold(input, log)).rejects.toThrow('hold release update failed')
      expect(recordOpsAction).not.toHaveBeenCalled()
      expect(enqueuePayoutSubmit).not.toHaveBeenCalled()
    })
  })
})
