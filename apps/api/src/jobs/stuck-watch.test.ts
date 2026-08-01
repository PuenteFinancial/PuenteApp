import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

// The O1 stuck-transfer pager. Harness mirrors correction-watch.test.ts /
// reconciliation.test.ts: per-table chain mocks + frozen clock + assertable
// Sentry spies — the page's exact shape (fingerprint, context, severity) IS
// the ops contract. The risk seams are mocked so the three no-hold-wait arms
// are each pinned independently.

const from = vi.fn()
vi.mock('../services/supabase.js', () => ({
  supabaseAdmin: {
    from: (...args: unknown[]) => from(...args),
  },
}))

const envMock = vi.hoisted(() => ({
  STUCK_FUNDED_AFTER_MINUTES: 15,
  STUCK_SUBMITTED_AFTER_MINUTES: 30,
  STUCK_IN_FLIGHT_AFTER_MINUTES: 60,
  STUCK_UNDER_REVIEW_AFTER_HOURS: 24,
  WAIT_FOR_CLEARING: false,
  FIRST_TRANSFER_HOLD: false,
}))
vi.mock('../config/env.js', () => ({ env: envMock }))

const assessUnclearedCap = vi.hoisted(() => vi.fn())
const hasClearedHistory = vi.hoisted(() => vi.fn())
vi.mock('../services/risk.js', () => ({
  assessUnclearedCap: (...args: unknown[]) => assessUnclearedCap(...args),
  hasClearedHistory: (...args: unknown[]) => hasClearedHistory(...args),
}))

const captureMessage = vi.hoisted(() => vi.fn())
const setFingerprint = vi.hoisted(() => vi.fn())
const setContext = vi.hoisted(() => vi.fn())
vi.mock('@sentry/node', () => ({
  withScope: (fn: (s: unknown) => void) => fn({ setFingerprint, setContext }),
  captureMessage: (...a: unknown[]) => captureMessage(...a),
}))

const { watchStuckTransfers, coarseAnchor } = await import('./stuck-watch.js')

const NOW = new Date('2026-08-01T12:00:00.000Z')
const nowMs = NOW.getTime()
const minutesAgo = (m: number) => new Date(nowMs - m * 60_000).toISOString()
const hoursAgo = (h: number) => minutesAgo(h * 60)

type Row = {
  id: string
  user_id: string
  state: 'FUNDED' | 'SUBMITTED' | 'IN_FLIGHT' | 'UNDER_REVIEW'
  funding_cleared: boolean
  payout_hold_reason: string | null
  disclosure_accepted_at: string | null
  payment_at: string | null
  submit_attempted_at: string | null
  cancellation_requested_at: string | null
  created_at: string
}

const row = (over: Partial<Row>): Row => ({
  id: 't-1',
  user_id: 'u-1',
  state: 'FUNDED',
  funding_cleared: false,
  payout_hold_reason: null,
  disclosure_accepted_at: minutesAgo(120),
  payment_at: minutesAgo(60),
  submit_attempted_at: null,
  cancellation_requested_at: null,
  created_at: minutesAgo(150),
  ...over,
})

// Thenable chains (supabase builders): transfers bulk = select→in→limit;
// transfers live-state re-read = select→eq→single (distinguished at resolve
// time by whether .single() was called); transitions = select→eq→eq→order→
// limit. Per-transfer maps let multi-candidate tests differ per row.
let transfersResult: { data: unknown; error: unknown }
let transitionByTransfer: Record<string, { data: unknown; error: unknown }>
let transitionEqCalls: Array<[string, string]>
// Live row served to the TOCTOU re-read; defaults to the bulk row's own
// state/hold (i.e. "nothing moved").
let liveStateOverride: Record<string, string>
let liveHoldOverride: Record<string, string | null>

function liveStateResult(id: string): { data: unknown; error: unknown } {
  const rows = (transfersResult.data ?? []) as Array<{
    id: string
    state: string
    payout_hold_reason: string | null
  }>
  const match = rows.find((r) => r.id === id)
  const state = liveStateOverride[id] ?? match?.state
  if (state === undefined) return { data: null, error: { message: 'row not found' } }
  return {
    data: {
      state,
      payout_hold_reason:
        liveHoldOverride[id] !== undefined ? liveHoldOverride[id] : (match?.payout_hold_reason ?? null),
    },
    error: null,
  }
}

let inCalls: Array<[string, unknown]>

function chain(resolveFn: () => { data: unknown; error: unknown }, recordEq?: (a: string, b: string) => void) {
  const c: Record<string, unknown> = {}
  for (const m of ['select', 'limit', 'order']) c[m] = vi.fn().mockReturnValue(c)
  c['in'] = vi.fn((col: string, vals: unknown) => {
    inCalls.push([col, vals])
    return c
  })
  c['eq'] = vi.fn((a: string, b: string) => {
    recordEq?.(a, b)
    return c
  })
  c['then'] = (res: (v: unknown) => unknown, rej: (e: unknown) => unknown) =>
    Promise.resolve(resolveFn()).then(res, rej)
  return c
}

beforeEach(() => {
  from.mockReset()
  captureMessage.mockReset()
  setFingerprint.mockReset()
  setContext.mockReset()
  assessUnclearedCap.mockReset().mockResolvedValue({ ok: true })
  hasClearedHistory.mockReset().mockResolvedValue(false)
  envMock.STUCK_FUNDED_AFTER_MINUTES = 15
  envMock.STUCK_SUBMITTED_AFTER_MINUTES = 30
  envMock.STUCK_IN_FLIGHT_AFTER_MINUTES = 60
  envMock.STUCK_UNDER_REVIEW_AFTER_HOURS = 24
  envMock.WAIT_FOR_CLEARING = false
  envMock.FIRST_TRANSFER_HOLD = false
  transfersResult = { data: [], error: null }
  transitionByTransfer = {}
  transitionEqCalls = []
  inCalls = []
  liveStateOverride = {}
  liveHoldOverride = {}
  from.mockImplementation((table: string) => {
    if (table === 'transfers') {
      let isSingle = false
      let rowId = ''
      const c = chain(
        () => (isSingle ? liveStateResult(rowId) : transfersResult),
        (col, val) => {
          if (col === 'id') rowId = val
        },
      )
      ;(c as Record<string, unknown>)['single'] = vi.fn(() => {
        isSingle = true
        return c
      })
      return c
    }
    if (table === 'transfer_transitions') {
      let transferId = ''
      return chain(
        () =>
          transitionByTransfer[transferId] ?? {
            data: [],
            error: null,
          },
        (col, val) => {
          transitionEqCalls.push([col, val])
          if (col === 'transfer_id') transferId = val
        },
      )
    }
    throw new Error(`unexpected supabase.from('${table}')`)
  })
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(NOW)
})

afterEach(() => {
  vi.useRealTimers()
})

const transition = (created_at: string, actor = 'worker:payout', reason = 'submitted') => ({
  data: [{ created_at, actor, reason }],
  error: null,
})

describe('coarseAnchor', () => {
  it('folds in only stamps that precede entry into the row state (never under-selects)', () => {
    const base = {
      created_at: minutesAgo(100),
      payment_at: minutesAgo(50),
      submit_attempted_at: minutesAgo(20),
      cancellation_requested_at: minutesAgo(10),
    }
    // FUNDED: the claim stamp and a cancel tap land AFTER FUNDED entry — the
    // anchor must ignore both or a claimed/cancel-tapped row's clock restarts.
    expect(coarseAnchor(row({ ...base, state: 'FUNDED' }))).toBe(minutesAgo(50))
    // SUBMITTED/IN_FLIGHT: the claim precedes entry; the cancel tap does not.
    expect(coarseAnchor(row({ ...base, state: 'SUBMITTED' }))).toBe(minutesAgo(20))
    expect(coarseAnchor(row({ ...base, state: 'IN_FLIGHT' }))).toBe(minutesAgo(20))
    // UNDER_REVIEW: entered after the cancellation request — all stamps fold in.
    expect(coarseAnchor(row({ ...base, state: 'UNDER_REVIEW' }))).toBe(minutesAgo(10))
    // Floor: never earlier than created_at.
    expect(coarseAnchor(row({ payment_at: null, submit_attempted_at: null, created_at: minutesAgo(9) }))).toBe(
      minutesAgo(9),
    )
  })
})

describe('watchStuckTransfers — thresholds', () => {
  it('pages a FUNDED row past 15m and stays silent just under', async () => {
    transfersResult = {
      data: [
        row({ id: 't-old', payment_at: minutesAgo(16) }),
        row({ id: 't-new', payment_at: minutesAgo(14) }),
      ],
      error: null,
    }
    transitionByTransfer['t-old'] = transition(minutesAgo(16), 'webhook:funding', 'funding captured/initiated')

    await expect(watchStuckTransfers()).resolves.toBe(1)

    expect(setFingerprint).toHaveBeenCalledTimes(1)
    expect(setFingerprint).toHaveBeenCalledWith(['stuck-transfer', 't-old', 'FUNDED', minutesAgo(16)])
    // The watched-state filter IS the no-double-paging contract with the
    // 30-min auto-fail cron: PENDING_PAYMENT must never join this list.
    expect(inCalls).toContainEqual(['state', ['FUNDED', 'SUBMITTED', 'IN_FLIGHT', 'UNDER_REVIEW']])
  })

  it('uses the per-state thresholds for SUBMITTED / IN_FLIGHT / UNDER_REVIEW', async () => {
    transfersResult = {
      data: [
        // Stamps are write-once and chronological: payment_at always precedes
        // submit/cancellation stamps in these fixtures.
        row({ id: 't-sub', state: 'SUBMITTED', payment_at: minutesAgo(40), submit_attempted_at: minutesAgo(31) }),
        row({ id: 't-sub-ok', state: 'SUBMITTED', payment_at: minutesAgo(40), submit_attempted_at: minutesAgo(29) }),
        row({ id: 't-fly', state: 'IN_FLIGHT', payment_at: minutesAgo(70), submit_attempted_at: minutesAgo(61) }),
        row({ id: 't-fly-ok', state: 'IN_FLIGHT', payment_at: minutesAgo(70), submit_attempted_at: minutesAgo(59) }),
        row({ id: 't-rev', state: 'UNDER_REVIEW', created_at: hoursAgo(27), payment_at: hoursAgo(26), cancellation_requested_at: hoursAgo(25) }),
        row({ id: 't-rev-ok', state: 'UNDER_REVIEW', created_at: hoursAgo(27), payment_at: hoursAgo(26), cancellation_requested_at: hoursAgo(23) }),
      ],
      error: null,
    }
    transitionByTransfer['t-sub'] = transition(minutesAgo(31))
    transitionByTransfer['t-fly'] = transition(minutesAgo(61))
    transitionByTransfer['t-rev'] = transition(hoursAgo(25), 'worker:payment-event', 'timely cancellation')

    await expect(watchStuckTransfers()).resolves.toBe(3)
    const fingerprints = setFingerprint.mock.calls.map((c) => c[0])
    expect(fingerprints).toContainEqual(['stuck-transfer', 't-sub', 'SUBMITTED', minutesAgo(31)])
    expect(fingerprints).toContainEqual(['stuck-transfer', 't-fly', 'IN_FLIGHT', minutesAgo(61)])
    expect(fingerprints).toContainEqual(['stuck-transfer', 't-rev', 'UNDER_REVIEW', hoursAgo(25)])
  })

  it('respects env overrides', async () => {
    envMock.STUCK_FUNDED_AFTER_MINUTES = 120
    transfersResult = { data: [row({ payment_at: minutesAgo(60) })], error: null }

    await expect(watchStuckTransfers()).resolves.toBe(0)
    expect(captureMessage).not.toHaveBeenCalled()
  })
})

describe('watchStuckTransfers — the deliberate FUNDED waits', () => {
  const staleFunded = (over: Partial<Row> = {}) =>
    row({ id: 't-wait', payment_at: minutesAgo(60), ...over })

  it('an ops hold never pages (it paged at hold time)', async () => {
    transfersResult = { data: [staleFunded({ payout_hold_reason: 'velocity_review' })], error: null }
    await expect(watchStuckTransfers()).resolves.toBe(0)
    expect(assessUnclearedCap).not.toHaveBeenCalled()
  })

  it('WAIT_FOR_CLEARING suppresses uncleared FUNDED dwell', async () => {
    envMock.WAIT_FOR_CLEARING = true
    transfersResult = { data: [staleFunded()], error: null }
    await expect(watchStuckTransfers()).resolves.toBe(0)
  })

  it('FIRST_TRANSFER_HOLD suppresses an unproven sender, flag-first (OFF costs zero reads)', async () => {
    envMock.FIRST_TRANSFER_HOLD = true
    hasClearedHistory.mockResolvedValue(false)
    transfersResult = { data: [staleFunded()], error: null }
    await expect(watchStuckTransfers()).resolves.toBe(0)
    expect(hasClearedHistory).toHaveBeenCalledWith('u-1')

    // proven sender → the hold does not apply → pages
    hasClearedHistory.mockResolvedValue(true)
    transitionByTransfer['t-wait'] = transition(minutesAgo(60))
    await expect(watchStuckTransfers()).resolves.toBe(1)
  })

  it('the uncleared-cap wait suppresses, with the exact payout-submit call shape', async () => {
    assessUnclearedCap.mockResolvedValue({ ok: false, blockerTransferId: 't-older' })
    const r = staleFunded()
    transfersResult = { data: [r], error: null }

    await expect(watchStuckTransfers()).resolves.toBe(0)
    expect(assessUnclearedCap).toHaveBeenCalledWith({
      userId: 'u-1',
      excludeTransferId: 't-wait',
      olderThan: { acceptedAt: r.disclosure_accepted_at, transferId: 't-wait' },
    })
  })

  it('a plain stuck FUNDED row (no wait applies) pages', async () => {
    transfersResult = { data: [staleFunded()], error: null }
    transitionByTransfer['t-wait'] = transition(minutesAgo(60))
    await expect(watchStuckTransfers()).resolves.toBe(1)
  })

  it('a CLAIMED row is crash recovery, never a deliberate wait — the codex P1 case', async () => {
    // payout-submit skips every wait gate on recovery (isRecovery), so the
    // watcher must page a claimed-then-crashed transfer even under
    // WAIT_FOR_CLEARING / cap conditions that would suppress an unclaimed one.
    envMock.WAIT_FOR_CLEARING = true
    assessUnclearedCap.mockResolvedValue({ ok: false, blockerTransferId: 't-older' })
    transfersResult = {
      data: [
        staleFunded({ id: 't-claimed', payment_at: minutesAgo(60), submit_attempted_at: minutesAgo(45) }),
      ],
      error: null,
    }
    transitionByTransfer['t-claimed'] = transition(minutesAgo(60))

    await expect(watchStuckTransfers()).resolves.toBe(1)
    expect(setFingerprint).toHaveBeenCalledWith(['stuck-transfer', 't-claimed', 'FUNDED', minutesAgo(60)])
    // …and none of the wait checks were even consulted for the claimed row.
    expect(assessUnclearedCap).not.toHaveBeenCalled()
    expect(hasClearedHistory).not.toHaveBeenCalled()

    // An ops hold still silences it — held is ops-owned even mid-recovery
    // (payout-submit checks the hold before the recovery branch).
    setFingerprint.mockReset()
    transfersResult = {
      data: [
        staleFunded({
          id: 't-claimed-held',
          payment_at: minutesAgo(60),
          submit_attempted_at: minutesAgo(45),
          payout_hold_reason: 'submit_error',
        }),
      ],
      error: null,
    }
    await expect(watchStuckTransfers()).resolves.toBe(0)
  })

  it('a broken risk read throws after the sweep finishes — never a silent classification', async () => {
    assessUnclearedCap.mockRejectedValueOnce(new Error('risk read down'))
    transfersResult = {
      data: [staleFunded(), row({ id: 't-2', state: 'SUBMITTED', submit_attempted_at: minutesAgo(45) })],
      error: null,
    }
    transitionByTransfer['t-2'] = transition(minutesAgo(45))

    await expect(watchStuckTransfers()).rejects.toThrow(/1 candidate check\(s\) failed across 2 watched row\(s\): risk read down/)
    // …but the healthy candidate still got its page before the throw.
    expect(setFingerprint).toHaveBeenCalledWith(['stuck-transfer', 't-2', 'SUBMITTED', minutesAgo(45)])
  })
})

describe('watchStuckTransfers — transitions anchor', () => {
  it('re-checks against the REAL state entry: stale stamp + fresh entry stays silent', async () => {
    // UNDER_REVIEW round trip: cancellation_requested_at is 30h old, but the
    // CURRENT UNDER_REVIEW stay began 1h ago — must not page.
    transfersResult = {
      data: [
        row({
          id: 't-rt',
          state: 'UNDER_REVIEW',
          created_at: hoursAgo(32),
          payment_at: hoursAgo(31),
          cancellation_requested_at: hoursAgo(30),
        }),
      ],
      error: null,
    }
    transitionByTransfer['t-rt'] = transition(hoursAgo(1))

    await expect(watchStuckTransfers()).resolves.toBe(0)
    expect(transitionEqCalls).toContainEqual(['transfer_id', 't-rt'])
    expect(transitionEqCalls).toContainEqual(['to_state', 'UNDER_REVIEW'])
  })

  it('pages with the transition context and both runbook pointers', async () => {
    transfersResult = {
      data: [
        row({ id: 't-f', payment_at: minutesAgo(20) }),
        row({ id: 't-r', state: 'UNDER_REVIEW', created_at: hoursAgo(27), payment_at: hoursAgo(26), cancellation_requested_at: hoursAgo(25) }),
      ],
      error: null,
    }
    transitionByTransfer['t-f'] = transition(minutesAgo(20), 'webhook:funding', 'funding captured/initiated')
    transitionByTransfer['t-r'] = transition(hoursAgo(25), 'worker:payment-event', 'timely cancellation')

    await expect(watchStuckTransfers()).resolves.toBe(2)

    expect(setContext).toHaveBeenCalledWith('stuck_transfer', {
      transferId: 't-f',
      state: 'FUNDED',
      enteredAt: minutesAgo(20),
      ageMinutes: 20,
      thresholdMinutes: 15,
      lastTransitionActor: 'webhook:funding',
      lastTransitionReason: 'funding captured/initiated',
      runbook: 'docs/runbooks/stuck-transfer.md',
    })
    expect(setContext).toHaveBeenCalledWith('stuck_transfer', {
      transferId: 't-r',
      state: 'UNDER_REVIEW',
      enteredAt: hoursAgo(25),
      ageMinutes: 25 * 60,
      thresholdMinutes: 24 * 60,
      lastTransitionActor: 'worker:payment-event',
      lastTransitionReason: 'timely cancellation',
      runbook: 'docs/runbooks/pending-cancellation.md',
    })
    expect(captureMessage).toHaveBeenCalledWith('stuck transfer: FUNDED past dwell threshold', 'warning')
    expect(captureMessage).toHaveBeenCalledWith(
      'stuck transfer: UNDER_REVIEW past dwell threshold',
      'warning',
    )
  })

  it('skips a transfer that advanced between the bulk read and the page — the codex TOCTOU case', async () => {
    transfersResult = {
      data: [row({ id: 't-race', state: 'SUBMITTED', payment_at: minutesAgo(40), submit_attempted_at: minutesAgo(31) })],
      error: null,
    }
    transitionByTransfer['t-race'] = transition(minutesAgo(31))
    liveStateOverride['t-race'] = 'COMPLETED'

    await expect(watchStuckTransfers()).resolves.toBe(0)
    expect(captureMessage).not.toHaveBeenCalled()
  })

  it('skips a FUNDED row that got HELD between the bulk read and the page — the hold race', async () => {
    transfersResult = {
      data: [row({ id: 't-heldrace', payment_at: minutesAgo(60) })],
      error: null,
    }
    transitionByTransfer['t-heldrace'] = transition(minutesAgo(60))
    liveHoldOverride['t-heldrace'] = 'fx_drift'

    await expect(watchStuckTransfers()).resolves.toBe(0)
    expect(captureMessage).not.toHaveBeenCalled()
  })

  it('a broken live-state re-read is a candidate error, not a silent verdict', async () => {
    transfersResult = {
      data: [row({ id: 't-gone', state: 'SUBMITTED', payment_at: minutesAgo(40), submit_attempted_at: minutesAgo(31) })],
      error: null,
    }
    transitionByTransfer['t-gone'] = transition(minutesAgo(31))
    liveStateOverride['t-gone'] = undefined as unknown as string
    // Force the not-found arm by removing the row from the bulk-backed default.
    const resolveErr = { data: null, error: { message: 'read timeout' } }
    from.mockImplementation((table: string) => {
      if (table === 'transfers') {
        let isSingle = false
        const c = chain(() => (isSingle ? resolveErr : transfersResult))
        ;(c as Record<string, unknown>)['single'] = vi.fn(() => {
          isSingle = true
          return c
        })
        return c
      }
      if (table === 'transfer_transitions') {
        let transferId = ''
        return chain(
          () => transitionByTransfer[transferId] ?? { data: [], error: null },
          (col, val) => {
            if (col === 'transfer_id') transferId = val
          },
        )
      }
      throw new Error(`unexpected supabase.from('${table}')`)
    })

    await expect(watchStuckTransfers()).rejects.toThrow(/state re-read failed: read timeout/)
  })

  it('a missing transition row falls back to the coarse stamp and still pages', async () => {
    transfersResult = { data: [row({ id: 't-nolog', payment_at: minutesAgo(20) })], error: null }
    transitionByTransfer['t-nolog'] = { data: [], error: null }

    await expect(watchStuckTransfers()).resolves.toBe(1)
    expect(setContext).toHaveBeenCalledWith(
      'stuck_transfer',
      expect.objectContaining({ enteredAt: minutesAgo(20), lastTransitionActor: null }),
    )
  })
})

describe('watchStuckTransfers — read posture', () => {
  it('fails CLOSED on a broken transfers read', async () => {
    transfersResult = { data: null, error: { message: 'db down' } }
    await expect(watchStuckTransfers()).rejects.toThrow(/stuck-watch select failed: db down/)
    transfersResult = { data: null, error: null }
    await expect(watchStuckTransfers()).rejects.toThrow(/no rows returned/)
  })

  it('throws at the PostgREST cap rather than sweeping a silently truncated set', async () => {
    transfersResult = {
      data: Array.from({ length: 1000 }, (_, i) => row({ id: `t-${i}`, payment_at: minutesAgo(1) })),
      error: null,
    }
    await expect(watchStuckTransfers()).rejects.toThrow(/PostgREST cap/)
    expect(captureMessage).not.toHaveBeenCalled()
  })

  it('a quiet book pages nothing and leaves no local evidence', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    transfersResult = { data: [row({ payment_at: minutesAgo(5) })], error: null }
    await expect(watchStuckTransfers()).resolves.toBe(0)
    expect(warnSpy).not.toHaveBeenCalled()
    warnSpy.mockRestore()
  })

  it('leaves console.warn evidence beside every page', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    transfersResult = { data: [row({ id: 't-ev', payment_at: minutesAgo(20) })], error: null }
    transitionByTransfer['t-ev'] = transition(minutesAgo(20))
    await watchStuckTransfers()
    expect(warnSpy).toHaveBeenCalledWith('worker: stuck-transfer t-ev in FUNDED for 20m')
    warnSpy.mockRestore()
  })
})
