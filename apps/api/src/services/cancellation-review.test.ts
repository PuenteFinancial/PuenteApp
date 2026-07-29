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
  // `order` joined the list when denyCancellation grew the deposit-evidence
  // bounds (the shared earliestDepositEvidenceAt query orders by received_at).
  for (const m of ['select', 'eq', 'is', 'not', 'in', 'or', 'lt', 'order', 'limit', 'update']) {
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
    // The lower plausibility bound for denial evidence: a deposit cannot
    // precede the sender's payment.
    payment_at: '2026-07-28T08:00:00.000Z',
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
      // paymentRef pinned too (review fix): disbursing against the wrong ref
      // (refund_payment_ref, provider_transfer_ref) passes the mock processor
      // but not a real one.
      expect.objectContaining({
        amountMinor: S + FEE,
        paymentRef: 'mockpay_1',
        idempotencyKey: 'bridge-key-1:refund',
      }),
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

  it('is idempotent at REFUNDED — writes nothing, still closes a stale request NEUTRALLY', async () => {
    q('transfers', reviewing({ state: 'REFUNDED', refund_payment_ref: 'mockrefund_prev' }))

    await expect(refundCancellation({ transferId: T, operator: 'jphelps' })).resolves.toEqual({
      done: true,
      outcome: 'already_refunded',
    })
    expect(refund).not.toHaveBeenCalled()
    expect(transition).not.toHaveBeenCalled()
    // REFUNDED may be the PAYOUT_FAILED tail's doing (its resolve failed and
    // paged; the runbook sends the operator here). On that transfer nothing
    // delivered and no correction exists — the close must not assert one.
    expect(resolveCancellationRequest).toHaveBeenCalledTimes(1)
    const close = resolveCancellationRequest.mock.calls[0]![0] as Record<string, unknown>
    expect(close.resolution).toContain('already refunded')
    expect(close.resolution).not.toContain('correction payment issued')
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

  it('reports already_disbursed — not refunded — when it only settles a pre-existing disbursement', async () => {
    // The crash-recovery heal: a prior run paid the sender and died before the
    // transition. This run settles the state but moves NO money, and must say
    // so — `refunded` here would make the CLI print "sender paid the
    // correction payment" for a run that paid nothing (the same lie the
    // PAYOUT_FAILED tail's already_disbursed outcome exists to prevent).
    q('transfers', reviewing({ refund_payment_ref: 'mockrefund_prev' }))

    await expect(refundCancellation({ transferId: T, operator: 'jphelps' })).resolves.toEqual({
      done: true,
      outcome: 'already_disbursed',
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
  // The legal guard, now both statutory conditions: in-window AND before the
  // deposit means the refund is owed, and no denial path may close it. The
  // request here is 09:00; the operator cites a 10:00 deposit — the ask beat it.
  it('REFUSES to deny a request that beat the deposit', async () => {
    pendingCancellationFor.mockResolvedValue(request({ within_window: true }))
    q('transfers', reviewing())

    await expect(
      denyCancellation({ transferId: T, operator: 'jphelps', depositedAt: '2026-07-28T10:00:00.000Z' }),
    ).resolves.toEqual({ done: false, reason: 'request_precedes_deposit' })
    expect(transition).not.toHaveBeenCalled()
    expect(resolveCancellationRequest).not.toHaveBeenCalled()
  })

  // The newly-lawful (and, on an instant rail, COMMON) denial: in-window by the
  // clock, but Bridge deposited at 08:59 — a minute before the 09:00 ask.
  // Condition (2) failed at request time, so nothing is owed. The evidence the
  // operator cited is what makes it provable, so it must reach the resolution.
  it('denies an in-window request when the deposit preceded it, naming that ground', async () => {
    pendingCancellationFor.mockResolvedValue(request({ within_window: true }))
    q('transfers', reviewing())

    await expect(
      denyCancellation({ transferId: T, operator: 'jphelps', depositedAt: '2026-07-28T08:59:00.000Z' }),
    ).resolves.toEqual({ done: true, outcome: 'denied' })

    expect(resolveCancellationRequest).toHaveBeenCalledWith(
      expect.objectContaining({
        status: 'resolved_denied',
        resolution: expect.stringContaining('before the request'),
      }),
    )
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

  // The fail-open the type-design review caught: Date.parse(garbage) is NaN and
  // every NaN comparison is false, so without this throw the owed-guard would
  // silently SKIP and an in-window request could be denied with the garbage
  // string recorded as "evidence". The CLI validates upstream; this service's
  // contract is that it does not trust callers.
  it('THROWS on an unparseable depositedAt before any comparison — never fails open', async () => {
    await expect(
      denyCancellation({ transferId: T, operator: 'jphelps', depositedAt: 'not-a-timestamp' }),
    ).rejects.toThrow(/not a parseable timestamp/)
    expect(from).not.toHaveBeenCalled() // refused before even loading the row
    expect(transition).not.toHaveBeenCalled()
    expect(resolveCancellationRequest).not.toHaveBeenCalled()
  })

  // Plausibility bounds: the true deposit lies in [payment_at, our earliest
  // payment_processed received_at]. Values outside are provably wrong and a
  // denial must never be recorded against impossible evidence. (An in-range
  // fat-finger is still possible — the bounds are a net, not proof.)
  it('refuses a cited deposit EARLIER than the sender’s payment, writing nothing', async () => {
    pendingCancellationFor.mockResolvedValue(request({ within_window: false }))
    q('transfers', reviewing()) // payment_at 08:00

    await expect(
      denyCancellation({ transferId: T, operator: 'jphelps', depositedAt: '2026-07-28T07:59:00.000Z' }),
    ).resolves.toEqual({
      done: false,
      reason: 'deposit_evidence_conflict',
      paymentAt: '2026-07-28T08:00:00.000Z',
      depositEvidenceAt: null,
    })
    expect(transition).not.toHaveBeenCalled()
    expect(resolveCancellationRequest).not.toHaveBeenCalled()
  })

  it('refuses a cited deposit LATER than our evidence of it, writing nothing', async () => {
    pendingCancellationFor.mockResolvedValue(request({ within_window: false }))
    q('transfers', reviewing())
    // Bridge told us at 09:30 — the deposit cannot have happened after that.
    q('payment_events', { data: [{ received_at: '2026-07-28T09:30:00.000Z' }], error: null })

    await expect(
      denyCancellation({ transferId: T, operator: 'jphelps', depositedAt: '2026-07-28T09:45:00.000Z' }),
    ).resolves.toEqual({
      done: false,
      reason: 'deposit_evidence_conflict',
      paymentAt: '2026-07-28T08:00:00.000Z',
      depositEvidenceAt: '2026-07-28T09:30:00.000Z',
    })
    expect(transition).not.toHaveBeenCalled()
    expect(resolveCancellationRequest).not.toHaveBeenCalled()
  })
})
