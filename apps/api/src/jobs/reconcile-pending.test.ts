import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

const from = vi.fn()

vi.mock('../services/supabase.js', () => ({
  supabaseAdmin: {
    from: (...args: unknown[]) => from(...args),
  },
}))

// Mutable so tests can flip the processor: the sweep window is 30 minutes for
// webhook-driven processors, days-scale under manual (out-of-band senders wire
// on their own schedule), and hours-scale under the onramp (widget KYC).
const envMock = vi.hoisted(() => ({
  FUNDING_PROCESSOR: 'mock' as string,
  MANUAL_PENDING_MAX_AGE_DAYS: 7,
  ONRAMP_PENDING_MAX_AGE_HOURS: 4,
}))
vi.mock('../config/env.js', () => ({ env: envMock }))

const transition = vi.hoisted(() => vi.fn())

vi.mock('../services/transfers.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../services/transfers.js')>()
  return {
    ...actual,
    transitionTransfer: (...args: unknown[]) => transition(...args),
  }
})

// The rejected-session poll (#213) goes through the processor seam; the real
// registry would construct adapters that demand secrets, so the sweep's view
// of the processor is a controllable fake.
const getPaymentStatus = vi.hoisted(() => vi.fn())

// TWO REGISTRIES, NOT ONE — and this file is the reason the distinction needs
// teeth. This job calls BOTH accessors on purpose: the onramp poll asks the
// PROCESS rail (`getFundingProcessor()`, outside the row loop), and the expiry
// asks the ROW's rail (`processorFor(row)`, audit corner 1), with a comment at
// each site saying which and why.
//
// Both used to be bound to the same object. Swapping either call site for the
// other then failed NOTHING — and #343 was a CONFIRMED PRODUCTION DOUBLE-PAY of
// exactly that shape, a row rail silently served by the process rail. So the
// fake now answers the two questions differently: `byRail` serves a row's
// stamp, `current` serves the process, and `rowArgs` records what
// `processorFor` was actually handed.
//
// The fallback when a row carries no stamp mirrors the real `processorFor`,
// which returns the process instance for an unstamped row — so every existing
// fixture here (rail `null`) keeps its old meaning.
const processorMock = vi.hoisted(() => ({
  current: { provider: 'mock' } as { provider: string; getPaymentStatus?: unknown; expireFunding?: unknown },
  byRail: {} as Record<string, { provider: string; getPaymentStatus?: unknown; expireFunding?: unknown }>,
  rowArgs: [] as unknown[],
}))
vi.mock('../services/funding/index.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../services/funding/index.js')>()
  return {
    // Spread, NOT an enumerated list: everything pure stays real (the rail
    // classifiers, the per-rail pending window — processorNameFor reads the
    // mocked env) and only the processor registry is faked. Enumerating meant
    // every new export used by the job under test broke this file with a
    // "No X export is defined on the mock" suite error.
    ...actual,
    getFundingProcessor: () => processorMock.current,
    // Mocked separately because processorFor calls getFundingProcessor through
    // the module's own binding, which the line above does not reach.
    processorFor: (row: unknown) => {
      processorMock.rowArgs.push(row)
      const rail = (row as { funding_processor?: string | null } | null)?.funding_processor
      return (rail != null ? processorMock.byRail[rail] : undefined) ?? processorMock.current
    },
  }
})

const { reconcilePendingTransfers } = await import('./reconcile-pending.js')
const { TransferRpcError } = await import('../services/transfers.js')

// The sweep now loads ALL pending rows once (the poll pass needs every age)
// and applies the staleness window in JS.
function mockPendingSelect(rows: unknown, error: unknown = null) {
  const eq = vi.fn().mockResolvedValue({ data: rows, error })
  const select = vi.fn().mockReturnValue({ eq })
  from.mockReturnValue({ select })
  return { select, eq }
}

// Frozen clock: 2026-07-20T12:00Z. Ages expressed relative to it.
const NOW = new Date('2026-07-20T12:00:00.000Z').getTime()
const ago = (ms: number) => new Date(NOW - ms).toISOString()
const MINUTES = 60 * 1000
const HOURS = 60 * MINUTES
const DAYS = 24 * HOURS

function row(id: string, ageMs: number, ref: string | null = null, rail: string | null = null) {
  return { id, funding_payment_ref: ref, funding_processor: rail, created_at: ago(ageMs) }
}

beforeEach(() => {
  from.mockReset()
  transition.mockReset().mockResolvedValue({})
  getPaymentStatus.mockReset()
  envMock.FUNDING_PROCESSOR = 'mock'
  envMock.MANUAL_PENDING_MAX_AGE_DAYS = 7
  envMock.ONRAMP_PENDING_MAX_AGE_HOURS = 4
  processorMock.current = { provider: 'mock' }
  processorMock.byRail = {}
  processorMock.rowArgs.length = 0
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(new Date(NOW))
})

afterEach(() => vi.useRealTimers())

describe('reconcilePendingTransfers — staleness windows', () => {
  it('webhook default: fails rows older than 30 minutes, leaves younger ones', async () => {
    mockPendingSelect([row('tr-old', 31 * MINUTES), row('tr-young', 29 * MINUTES)])

    const count = await reconcilePendingTransfers()

    expect(count).toBe(1)
    expect(transition).toHaveBeenCalledTimes(1)
    const [input] = transition.mock.calls[0] as [Record<string, unknown>]
    expect(input).toEqual({
      transferId: 'tr-old',
      fromState: 'PENDING_PAYMENT',
      toState: 'PAYMENT_FAILED',
      actor: 'worker:reconcile-pending',
      reason: 'funding_not_received_within_30_minutes',
    })
    expect('ledgerEntries' in input).toBe(false)
  })

  it('manual processor: the window is days-scale, not 30 minutes', async () => {
    envMock.FUNDING_PROCESSOR = 'manual'
    envMock.MANUAL_PENDING_MAX_AGE_DAYS = 5
    // A sender mid-wire is NOT abandoned at 30 minutes — or even 4 days.
    mockPendingSelect([row('tr-old', 6 * DAYS), row('tr-midwire', 4 * DAYS)])

    const count = await reconcilePendingTransfers()

    expect(count).toBe(1)
    const [input] = transition.mock.calls[0] as [Record<string, unknown>]
    expect(input.transferId).toBe('tr-old')
    expect(input.reason).toBe('funding_not_received_within_5_days')
  })

  // Both onramp rails share the window: KYC-at-first-send makes a slow first
  // pass NORMAL under stripe_crypto too (K5 fix — the literal 'stripe_onramp'
  // branch left the embedded rail on the 30-minute default).
  it.each(['stripe_onramp', 'stripe_crypto'])(
    '%s: hours-scale — first-send KYC outlives 30 minutes (#213)',
    async (rail) => {
      envMock.FUNDING_PROCESSOR = rail
      processorMock.current = { provider: rail, getPaymentStatus }
      // Refs deliberately null: these rows exercise the AGE arm, not the poll.
      mockPendingSelect([row('tr-old', 5 * HOURS), row('tr-midkyc', 3 * HOURS)])

      const count = await reconcilePendingTransfers()

      expect(count).toBe(1)
      const [input] = transition.mock.calls[0] as [Record<string, unknown>]
      expect(input.transferId).toBe('tr-old')
      expect(input.reason).toBe('funding_not_received_within_4_hours')
    },
  )

  it('transitions every stale row and returns the count', async () => {
    mockPendingSelect([row('tr-1', 1 * HOURS), row('tr-2', 2 * HOURS), row('tr-3', 3 * HOURS)])

    const count = await reconcilePendingTransfers()

    expect(count).toBe(3)
    expect(transition).toHaveBeenCalledTimes(3)
  })

  it.each(['transition_conflict', 'transfer_not_found'] as const)(
    'skips a row lost to a concurrent actor (%s) without failing the batch',
    async (code) => {
      mockPendingSelect([row('tr-1', 1 * HOURS), row('tr-2', 2 * HOURS), row('tr-3', 3 * HOURS)])
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
    mockPendingSelect([row('tr-1', 1 * HOURS), row('tr-2', 2 * HOURS), row('tr-3', 3 * HOURS)])
    transition
      .mockRejectedValueOnce(new Error('connection reset'))
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({})

    await expect(reconcilePendingTransfers()).rejects.toThrow(/1\/3 transitions failed/)
    expect(transition).toHaveBeenCalledTimes(3)
  })

  it('throws when the pending select fails', async () => {
    mockPendingSelect(null, { message: 'boom' })

    await expect(reconcilePendingTransfers()).rejects.toThrow(/select failed: boom/)
    expect(transition).not.toHaveBeenCalled()
  })
})

// Runs identically for the widget rail and the embedded rail: both stamp cos_
// refs, and a KYC rejection under stripe_crypto must fail in ≤ one tick just
// like the drill pinned for stripe_onramp.
describe.each(['stripe_onramp', 'stripe_crypto'])(
  'reconcilePendingTransfers — rejected-session poll (#213, %s)',
  (rail) => {
  beforeEach(() => {
    envMock.FUNDING_PROCESSOR = rail
    processorMock.current = { provider: rail, getPaymentStatus }
  })

  it('fails a rejected session IMMEDIATELY — no webhook exists for rejection', async () => {
    // 2 minutes old: far inside the 4-hour window. The poll is what fails it.
    mockPendingSelect([row('tr-rejected', 2 * MINUTES, 'cos_rej1')])
    getPaymentStatus.mockResolvedValue({
      paymentRef: 'cos_rej1',
      status: 'rejected',
      lastError: 'kyc_verification_failed',
    })

    const count = await reconcilePendingTransfers()

    expect(count).toBe(1)
    expect(getPaymentStatus).toHaveBeenCalledWith({ paymentRef: 'cos_rej1' })
    const [input] = transition.mock.calls[0] as [Record<string, unknown>]
    expect(input).toMatchObject({
      transferId: 'tr-rejected',
      fromState: 'PENDING_PAYMENT',
      toState: 'PAYMENT_FAILED',
      actor: 'worker:reconcile-pending',
      // The session's own machine-readable cause, not the window boilerplate.
      reason: 'kyc_verification_failed',
    })
  })

  it('falls back to a generic reason when the session carries no last_error', async () => {
    mockPendingSelect([row('tr-rejected', 2 * MINUTES, 'cos_rej2')])
    getPaymentStatus.mockResolvedValue({ paymentRef: 'cos_rej2', status: 'rejected' })

    await reconcilePendingTransfers()

    const [input] = transition.mock.calls[0] as [Record<string, unknown>]
    expect(input.reason).toBe('onramp_session_rejected')
  })

  it('leaves non-rejected sessions to the age window', async () => {
    mockPendingSelect([row('tr-kyc-in-progress', 2 * HOURS, 'cos_live1')])
    getPaymentStatus.mockResolvedValue({ paymentRef: 'cos_live1', status: 'requires_payment' })

    const count = await reconcilePendingTransfers()

    expect(count).toBe(0)
    expect(transition).not.toHaveBeenCalled()
  })

  it('a rejected row past the window fails ONCE, by the poll, with the real reason', async () => {
    mockPendingSelect([row('tr-both', 5 * HOURS, 'cos_rej3')])
    getPaymentStatus.mockResolvedValue({
      paymentRef: 'cos_rej3',
      status: 'rejected',
      lastError: 'kyc_verification_failed',
    })

    const count = await reconcilePendingTransfers()

    expect(count).toBe(1)
    expect(transition).toHaveBeenCalledTimes(1)
    const [input] = transition.mock.calls[0] as [Record<string, unknown>]
    expect(input.reason).toBe('kyc_verification_failed')
  })

  it('a poll failure never blocks the sweep — the age window still backstops', async () => {
    mockPendingSelect([
      row('tr-poll-broke-young', 2 * MINUTES, 'cos_err1'),
      row('tr-poll-broke-old', 5 * HOURS, 'cos_err2'),
    ])
    getPaymentStatus.mockRejectedValue(new Error('stripe unreachable'))

    const count = await reconcilePendingTransfers()

    // Young row untouched; old row failed by the AGE arm despite the dead poll.
    expect(count).toBe(1)
    const [input] = transition.mock.calls[0] as [Record<string, unknown>]
    expect(input.transferId).toBe('tr-poll-broke-old')
    expect(input.reason).toBe('funding_not_received_within_4_hours')
  })

  it('never polls non-cos_ refs — pre-flip rows are not Stripe sessions', async () => {
    mockPendingSelect([row('tr-manual-era', 2 * HOURS, 'manualpay_abc')])

    await reconcilePendingTransfers()

    expect(getPaymentStatus).not.toHaveBeenCalled()
  })

  it('never polls under a non-onramp processor, whatever the refs look like', async () => {
    envMock.FUNDING_PROCESSOR = 'mock'
    processorMock.current = { provider: 'mock' }
    mockPendingSelect([row('tr-x', 2 * MINUTES, 'cos_weird')])

    await reconcilePendingTransfers()

    expect(getPaymentStatus).not.toHaveBeenCalled()
  })
  },
)

// Audit 2026-09-02 corner 1: after a FUNDING_PROCESSOR flip the table holds
// rows from both rails. The clock follows the ROW's stamp; a null stamp keeps
// the process clock (every test above runs on that fallback).
describe('reconcilePendingTransfers — per-row rail', () => {
  it('a manual-stamped row keeps its days-scale window after the process flips to stripe_crypto', async () => {
    envMock.FUNDING_PROCESSOR = 'stripe_crypto'
    envMock.MANUAL_PENDING_MAX_AGE_DAYS = 7
    envMock.ONRAMP_PENDING_MAX_AGE_HOURS = 4
    processorMock.current = { provider: 'stripe_crypto', getPaymentStatus }
    mockPendingSelect([
      row('tr-manual-midwire', 2 * DAYS, 'manualpay_1', 'manual'),
      row('tr-manual-dead', 8 * DAYS, 'manualpay_2', 'manual'),
      row('tr-crypto-dead', 5 * HOURS, null, 'stripe_crypto'),
      row('tr-legacy-null', 5 * HOURS, null, null),
    ])

    const count = await reconcilePendingTransfers()

    expect(count).toBe(3)
    const byId = Object.fromEntries(
      transition.mock.calls.map(([input]) => [
        (input as { transferId: string }).transferId,
        (input as { reason: string }).reason,
      ]),
    )
    expect(byId).toEqual({
      'tr-manual-dead': 'funding_not_received_within_7_days',
      'tr-crypto-dead': 'funding_not_received_within_4_hours',
      'tr-legacy-null': 'funding_not_received_within_4_hours',
    })
  })

  // REGRESSION (2026-09-14). The reason string branched on isOnrampSessionRail
  // while the CLOCK branched on hasInteractivePayStep. stripe_checkout is in the
  // second and not the first, so the live rail waited 4 hours and then recorded
  // "within_30_minutes" in the permanent transition log — 6 staging rows carry
  // it against a measured mean dwell of 242.2 minutes. The label must name the
  // clock that actually ran.
  it('a stripe_checkout row reports the 4-hour window it actually waited, not 30 minutes', async () => {
    envMock.FUNDING_PROCESSOR = 'stripe_checkout'
    envMock.ONRAMP_PENDING_MAX_AGE_HOURS = 4
    mockPendingSelect([
      row('tr-checkout-dead', 5 * HOURS, 'cs_test_dead', 'stripe_checkout'),
      // Still inside the window it is actually given: a 40-minute-old Checkout
      // row must not be reaped at all. Under the old 30-minute label the clock
      // was already right, so this pins the pair together.
      row('tr-checkout-midpay', 40 * 60_000, 'cs_test_live', 'stripe_checkout'),
    ])

    const count = await reconcilePendingTransfers()

    expect(count).toBe(1)
    const [input] = transition.mock.calls[0] as [Record<string, unknown>]
    expect(input.transferId).toBe('tr-checkout-dead')
    expect(input.reason).toBe('funding_not_received_within_4_hours')
  })

  it('a stripe_crypto-stamped row keeps its hours window after the process flips back to manual', async () => {
    envMock.FUNDING_PROCESSOR = 'manual'
    envMock.MANUAL_PENDING_MAX_AGE_DAYS = 7
    envMock.ONRAMP_PENDING_MAX_AGE_HOURS = 4
    mockPendingSelect([
      row('tr-crypto-dead', 5 * HOURS, null, 'stripe_crypto'),
      row('tr-manual-midwire', 5 * HOURS, 'manualpay_1', 'manual'),
    ])

    const count = await reconcilePendingTransfers()

    expect(count).toBe(1)
    const [input] = transition.mock.calls[0] as [Record<string, unknown>]
    expect(input.transferId).toBe('tr-crypto-dead')
    expect(input.reason).toBe('funding_not_received_within_4_hours')
  })
})

describe('reconcilePendingTransfers — closing the processor object before failing the row', () => {
  // C5: the reaper failed our row but left the Checkout Session open for its
  // full 24h. A Payment Element still mounted in a stale tab could then take
  // the money for a PAYMENT_FAILED transfer — the webhook hits
  // transition_conflict and is acked. Charge, no transfer. So on rails that
  // can, the processor's object is closed FIRST, and its answer decides
  // whether the row is ours to fail at all.
  const expireFunding = vi.fn()
  beforeEach(() => {
    expireFunding.mockReset()
    processorMock.current = { provider: 'stripe_checkout', expireFunding }
  })
  afterEach(() => {
    processorMock.current = { provider: 'mock' }
  })

  it('expires the session, THEN fails the row', async () => {
    expireFunding.mockResolvedValue('expired')
    mockPendingSelect([row('tr-stale', 5 * 60 * MINUTES, 'cs_test_stale')])

    const count = await reconcilePendingTransfers()

    expect(count).toBe(1)
    expect(expireFunding).toHaveBeenCalledWith({ paymentRef: 'cs_test_stale' })
    expect(transition).toHaveBeenCalledTimes(1)
    // Order is the point: nothing may be payable by the time the row is failed.
    expect(expireFunding.mock.invocationCallOrder[0]!).toBeLessThan(
      transition.mock.invocationCallOrder[0]!,
    )
  })

  it("a session that is not open is not ours to fail — the sender paid, the webhook is coming", async () => {
    expireFunding.mockResolvedValue('not_open')
    mockPendingSelect([row('tr-paid-late', 5 * 60 * MINUTES, 'cs_test_paid')])

    const count = await reconcilePendingTransfers()

    expect(count).toBe(0)
    expect(transition).not.toHaveBeenCalled()
  })

  it('a transport failure skips that row this tick and still handles the others', async () => {
    expireFunding
      .mockRejectedValueOnce(new Error('stripe unreachable'))
      .mockResolvedValueOnce('expired')
    mockPendingSelect([
      row('tr-flaky', 5 * 60 * MINUTES, 'cs_test_a'),
      row('tr-fine', 5 * 60 * MINUTES, 'cs_test_b'),
    ])

    const count = await reconcilePendingTransfers()

    expect(count).toBe(1)
    expect(transition).toHaveBeenCalledTimes(1)
    expect((transition.mock.calls[0] as [Record<string, unknown>])[0]).toMatchObject({
      transferId: 'tr-fine',
    })
  })

  it('a rail with no expireFunding behaves exactly as before', async () => {
    processorMock.current = { provider: 'mock' }
    mockPendingSelect([row('tr-old', 31 * MINUTES)])

    const count = await reconcilePendingTransfers()

    expect(count).toBe(1)
    expect(expireFunding).not.toHaveBeenCalled()
  })

  // THE #343 SHAPE, on the one job that asks both questions.
  //
  // Both rails can expire, so calling the wrong one still "works" — the row is
  // closed, the count is right, and every other assertion in this file passes.
  // The only thing that differs is WHICH provider was told to close the object,
  // and on a real flip that is a session left payable at one provider while we
  // fail the row: a charge with no transfer, which is the whole reason the
  // expiry happens first.
  it('expires at the ROW\'s rail, not the process\'s, after a flip', async () => {
    const rowRailExpire = vi.fn().mockResolvedValue('expired')
    envMock.FUNDING_PROCESSOR = 'stripe_crypto'
    processorMock.current = { provider: 'stripe_crypto', expireFunding }
    processorMock.byRail['stripe_checkout'] = {
      provider: 'stripe_checkout',
      expireFunding: rowRailExpire,
    }
    mockPendingSelect([row('tr-preflip', 5 * HOURS, 'cs_test_preflip', 'stripe_checkout')])

    const count = await reconcilePendingTransfers()

    expect(count).toBe(1)
    expect(rowRailExpire).toHaveBeenCalledWith({ paymentRef: 'cs_test_preflip' })
    expect(expireFunding).not.toHaveBeenCalled() // the PROCESS rail was not asked
    // And it was asked about this row, not about nothing: `processorFor` takes
    // an argument and `getFundingProcessor` does not, so the recorded argument
    // is what tells the two accessors apart at all.
    expect(processorMock.rowArgs).toEqual([
      expect.objectContaining({ id: 'tr-preflip', funding_processor: 'stripe_checkout' }),
    ])
  })
})

// The mirror of the test above, on the other accessor. The onramp poll runs
// ONCE for the whole tick, outside the row loop, off the PROCESS rail — a
// pre-flip row is filtered by its ref prefix, not by asking its own adapter.
// Swapping this site to the row's rail would poll each row at whatever provider
// last touched it, which for `cos_` refs under a flipped env is a guaranteed
// 404 storm rather than a fail-fast.
describe('reconcilePendingTransfers — the poll reads the PROCESS rail', () => {
  it('polls a cos_ row through the process adapter even when the row is stamped otherwise', async () => {
    const rowRailStatus = vi.fn()
    envMock.FUNDING_PROCESSOR = 'stripe_crypto'
    processorMock.current = { provider: 'stripe_crypto', getPaymentStatus }
    processorMock.byRail['stripe_checkout'] = {
      provider: 'stripe_checkout',
      getPaymentStatus: rowRailStatus,
    }
    getPaymentStatus.mockResolvedValue({ status: 'rejected', lastError: 'card_declined' })
    mockPendingSelect([row('tr-mixed', 2 * MINUTES, 'cos_mixed', 'stripe_checkout')])

    const count = await reconcilePendingTransfers()

    expect(count).toBe(1)
    expect(getPaymentStatus).toHaveBeenCalledWith({ paymentRef: 'cos_mixed' })
    expect(rowRailStatus).not.toHaveBeenCalled()
    expect(transition).toHaveBeenCalledTimes(1)
    expect((transition.mock.calls[0] as [Record<string, unknown>])[0]).toMatchObject({
      toState: 'PAYMENT_FAILED',
      reason: 'card_declined',
    })
  })
})
