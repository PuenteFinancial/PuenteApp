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
const processorMock = vi.hoisted(() => ({
  current: { provider: 'mock' } as { provider: string; getPaymentStatus?: unknown },
}))
vi.mock('../services/funding/index.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../services/funding/index.js')>()
  return {
    // Real rail classifier (pure); only the processor registry is faked.
    isOnrampSessionRail: actual.isOnrampSessionRail,
    getFundingProcessor: () => processorMock.current,
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

function row(id: string, ageMs: number, ref: string | null = null) {
  return { id, funding_payment_ref: ref, created_at: ago(ageMs) }
}

beforeEach(() => {
  from.mockReset()
  transition.mockReset().mockResolvedValue({})
  getPaymentStatus.mockReset()
  envMock.FUNDING_PROCESSOR = 'mock'
  envMock.MANUAL_PENDING_MAX_AGE_DAYS = 7
  envMock.ONRAMP_PENDING_MAX_AGE_HOURS = 4
  processorMock.current = { provider: 'mock' }
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
