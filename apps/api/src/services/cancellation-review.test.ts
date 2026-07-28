import { describe, it, expect, beforeEach, vi } from 'vitest'

// The two lawful exits from UNDER_REVIEW (slice-7 PR6b). This is the service
// that pays a DELIVERED transfer a second time, so the guards below are the ones
// standing between a recorded obligation and an unreviewed double payment.
// Harness mirrors refunds.test.ts: hoisted `from` spy, thenable chain builder,
// dynamic import after the mocks.

const from = vi.hoisted(() => vi.fn())
vi.mock('./supabase.js', () => ({ supabaseAdmin: { from: (...a: unknown[]) => from(...a) } }))

// real ledger-entry builders — the correction batch is asserted line-for-line
const transition = vi.hoisted(() => vi.fn())
vi.mock('./transfers.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./transfers.js')>()
  return { ...actual, transitionTransfer: (...a: unknown[]) => transition(...a) }
})

const refund = vi.hoisted(() => vi.fn())
vi.mock('./funding/index.js', () => ({
  getFundingProcessor: () => ({ refund: (...a: unknown[]) => refund(...a) }),
}))

const claimRefund = vi.hoisted(() => vi.fn())
vi.mock('./refunds.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./refunds.js')>()
  return { ...actual, claimRefund: (...a: unknown[]) => claimRefund(...a) }
})

const pendingCancellationFor = vi.hoisted(() => vi.fn())
const resolveCancellationRequest = vi.hoisted(() => vi.fn())
vi.mock('./cancellations.js', () => ({
  pendingCancellationFor: (...a: unknown[]) => pendingCancellationFor(...a),
  resolveCancellationRequest: (...a: unknown[]) => resolveCancellationRequest(...a),
}))

const { refundCancellation, denyCancellation } = await import('./cancellation-review.js')

const queues: Record<string, unknown[]> = {}
function q(table: string, ...results: unknown[]): void {
  queues[table] = (queues[table] ?? []).concat(results)
}
function chain(result: unknown): Record<string, unknown> {
  const c: Record<string, unknown> = {}
  for (const m of ['select', 'eq', 'is', 'not', 'in', 'or', 'lt', 'limit', 'update']) {
    c[m] = () => c
  }
  c.maybeSingle = () => Promise.resolve(result)
  c.then = (resolve: (v: unknown) => void) => resolve(result)
  return c
}

const T = '00000000-0000-4000-8000-0000000000c1'
const S = 19801
const FEE = 199

// A delivered transfer the job parked for review: the sender made a timely
// cancellation request and the payout completed anyway.
const reviewing = (over: Record<string, unknown> = {}) => ({
  data: {
    id: T,
    state: 'UNDER_REVIEW',
    send_amount_minor: S,
    fee_amount_minor: FEE,
    refund_payment_ref: null,
    funding_payment_ref: 'mockpay_1',
    idempotency_key: 'bridge-key-1',
    refund_claimed_at: null,
    refund_claimed_by: null,
    ...over,
  },
  error: null,
})

const request = (over: Record<string, unknown> = {}) => ({
  id: 'cr-1',
  transfer_id: T,
  requested_at: '2026-07-28T09:00:00.000Z',
  within_window: true,
  status: 'pending',
  ...over,
})

const minutesAgo = (n: number) => new Date(Date.now() - n * 60_000).toISOString()

beforeEach(() => {
  vi.clearAllMocks()
  for (const k of Object.keys(queues)) delete queues[k]
  refund.mockResolvedValue({ provider: 'mock', ref: 'mockrefund_c1', status: 'succeeded' })
  transition.mockResolvedValue({ id: T, state: 'REFUNDED' })
  claimRefund.mockResolvedValue(true)
  pendingCancellationFor.mockResolvedValue(request())
  resolveCancellationRequest.mockResolvedValue(true)
  from.mockImplementation((table: string) => chain(queues[table]?.shift() ?? { data: null, error: null }))
})

describe('refundCancellation', () => {
  it('pays the correction payment, settles REFUNDED, and closes the request', async () => {
    q('transfers', reviewing(), { data: null, error: null }) // load, ref persist

    await expect(refundCancellation({ transferId: T, operator: 'jphelps' })).resolves.toEqual({
      done: true,
      outcome: 'refunded',
    })

    // Takes the SAME claim as the PAYOUT_FAILED tail — both disburse against
    // refund_payment_ref on one transfer, so they must contend on one lock.
    expect(claimRefund).toHaveBeenCalledWith(T, 'ops:jphelps')
    expect(refund).toHaveBeenCalledWith(
      expect.objectContaining({ amountMinor: S + FEE, idempotencyKey: 'bridge-key-1:refund' }),
    )

    const settle = transition.mock.calls[0]![0] as Record<string, unknown>
    expect(settle).toMatchObject({
      fromState: 'UNDER_REVIEW',
      toState: 'REFUNDED',
      actor: 'ops:jphelps',
    })
    // A NEW expense against Puente — NOT a reversal. transfer_payable was
    // already discharged by the COMPLETED batch, and the original entries are
    // never touched: we do not rewrite delivered history.
    expect(settle.ledgerEntries).toEqual([
      {
        account_code: 'loss_cancellation_correction',
        direction: 'debit',
        amount_minor: S + FEE,
        currency: 'USD',
      },
      { account_code: 'cash_clearing', direction: 'credit', amount_minor: S + FEE, currency: 'USD' },
    ])
    expect(resolveCancellationRequest).toHaveBeenCalledWith(
      expect.objectContaining({ transferId: T, status: 'resolved_refunded', resolvedBy: 'ops:jphelps' }),
    )
  })

  // THE guard. Paying a plain COMPLETED transfer would be an unreviewed double
  // payment on a delivery nobody contested.
  it('refuses a transfer that is not UNDER_REVIEW, and writes nothing', async () => {
    q('transfers', reviewing({ state: 'COMPLETED' }))

    await expect(refundCancellation({ transferId: T, operator: 'jphelps' })).resolves.toEqual({
      done: false,
      reason: 'not_under_review',
      state: 'COMPLETED',
    })
    expect(refund).not.toHaveBeenCalled()
    expect(claimRefund).not.toHaveBeenCalled()
    expect(transition).not.toHaveBeenCalled()
  })

  // The request is the AUTHORITY for the payment. Without one, paying is a gift
  // of company money with no record of why.
  it('refuses when no request is open', async () => {
    pendingCancellationFor.mockResolvedValue(null)
    q('transfers', reviewing())

    await expect(refundCancellation({ transferId: T, operator: 'jphelps' })).resolves.toEqual({
      done: false,
      reason: 'no_pending_request',
    })
    expect(refund).not.toHaveBeenCalled()
  })

  it('is idempotent at REFUNDED — writes nothing, still closes a stale request', async () => {
    q('transfers', reviewing({ state: 'REFUNDED', refund_payment_ref: 'mockrefund_prev' }))

    await expect(refundCancellation({ transferId: T, operator: 'jphelps' })).resolves.toEqual({
      done: true,
      outcome: 'already_refunded',
    })
    expect(refund).not.toHaveBeenCalled()
    expect(transition).not.toHaveBeenCalled()
    expect(resolveCancellationRequest).toHaveBeenCalledTimes(1)
  })

  it('a losing claim writes NOTHING — not the payment, not the transition', async () => {
    claimRefund.mockResolvedValue(false)
    q('transfers', reviewing(), reviewing({ refund_claimed_at: minutesAgo(2), refund_claimed_by: 'ops:x' }))

    await expect(refundCancellation({ transferId: T, operator: 'jphelps' })).resolves.toMatchObject({
      done: false,
      reason: 'claim_taken',
      claimedBy: 'ops:x',
    })
    expect(refund).not.toHaveBeenCalled()
    expect(transition).not.toHaveBeenCalled()
  })

  it('reports an abandoned claim distinctly — the sender may already be paid', async () => {
    claimRefund.mockResolvedValue(false)
    q('transfers', reviewing(), reviewing({ refund_claimed_at: minutesAgo(45), refund_claimed_by: 'ops:y' }))

    await expect(refundCancellation({ transferId: T, operator: 'jphelps' })).resolves.toMatchObject({
      done: false,
      reason: 'claim_abandoned',
    })
  })

  it('skips the claim when a disbursement is already recorded, and just settles', async () => {
    q('transfers', reviewing({ refund_payment_ref: 'mockrefund_prev' }))

    await expect(refundCancellation({ transferId: T, operator: 'jphelps' })).resolves.toEqual({
      done: true,
      outcome: 'refunded',
    })
    expect(claimRefund).not.toHaveBeenCalled()
    expect(refund).not.toHaveBeenCalled()
    expect(transition).toHaveBeenCalledTimes(1)
  })

  it('refuses to pay against a missing funding ref rather than coercing it', async () => {
    q('transfers', reviewing({ funding_payment_ref: null }))

    await expect(refundCancellation({ transferId: T, operator: 'jphelps' })).rejects.toThrow(
      /no funding_payment_ref/,
    )
    expect(claimRefund).not.toHaveBeenCalled()
    expect(refund).not.toHaveBeenCalled()
  })
})

describe('denyCancellation', () => {
  // The legal guard: a timely cancellation on a delivered transfer is owed a
  // full refund, and no denial path may close it.
  it('REFUSES to deny a timely request', async () => {
    pendingCancellationFor.mockResolvedValue(request({ within_window: true }))
    q('transfers', reviewing())

    await expect(
      denyCancellation({ transferId: T, operator: 'jphelps', depositedAt: '2026-07-28T10:00:00.000Z' }),
    ).resolves.toEqual({ done: false, reason: 'request_is_timely' })
    expect(transition).not.toHaveBeenCalled()
    expect(resolveCancellationRequest).not.toHaveBeenCalled()
  })

  it('returns an out-of-window review to COMPLETED with NO ledger, recording the evidence', async () => {
    pendingCancellationFor.mockResolvedValue(request({ within_window: false }))
    q('transfers', reviewing())

    await expect(
      denyCancellation({ transferId: T, operator: 'jphelps', depositedAt: '2026-07-28T10:00:00.000Z' }),
    ).resolves.toEqual({ done: true, outcome: 'denied' })

    const back = transition.mock.calls[0]![0] as Record<string, unknown>
    expect(back).toMatchObject({ fromState: 'UNDER_REVIEW', toState: 'COMPLETED' })
    // Nothing moved: the transfer delivered and stays delivered.
    expect('ledgerEntries' in back).toBe(false)
    expect(back.metadata).toMatchObject({ bridgeDepositedAt: '2026-07-28T10:00:00.000Z' })
    expect(resolveCancellationRequest).toHaveBeenCalledWith(
      expect.objectContaining({
        status: 'resolved_denied',
        resolution: expect.stringContaining('2026-07-28T10:00:00.000Z'),
      }),
    )
  })

  // An out-of-window request on a COMPLETED transfer was never routed, so there
  // is no transition to make — only the request closes.
  it('closes an out-of-window request on a never-routed COMPLETED transfer without transitioning', async () => {
    pendingCancellationFor.mockResolvedValue(request({ within_window: false }))
    q('transfers', reviewing({ state: 'COMPLETED' }))

    await expect(
      denyCancellation({ transferId: T, operator: 'jphelps', depositedAt: '2026-07-28T10:00:00.000Z' }),
    ).resolves.toEqual({ done: true, outcome: 'denied' })
    expect(transition).not.toHaveBeenCalled()
    expect(resolveCancellationRequest).toHaveBeenCalledTimes(1)
  })

  it('refuses when no request is open', async () => {
    pendingCancellationFor.mockResolvedValue(null)
    q('transfers', reviewing())

    await expect(
      denyCancellation({ transferId: T, operator: 'jphelps', depositedAt: '2026-07-28T10:00:00.000Z' }),
    ).resolves.toEqual({ done: false, reason: 'no_pending_request' })
  })
})
