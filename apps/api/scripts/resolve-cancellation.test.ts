import { describe, it, expect, beforeEach, vi } from 'vitest'

// The cancellation-resolution CLI. Two classes of guarantee are pinned here: the
// arg parsing (the only user input on a path that pays a delivered transfer a
// SECOND time), and the guards that stop the wrong exit being taken — above all
// that a TIMELY request can never be denied.
const refundCancellation = vi.hoisted(() => vi.fn())
const denyCancellation = vi.hoisted(() => vi.fn())
const listPendingReviews = vi.hoisted(() => vi.fn())
vi.mock('../src/services/cancellation-review.js', () => ({
  refundCancellation: (...a: unknown[]) => refundCancellation(...a),
  denyCancellation: (...a: unknown[]) => denyCancellation(...a),
  listPendingReviews: (...a: unknown[]) => listPendingReviews(...a),
}))

const { parseArgs, resolve, list, StepError } = await import('./resolve-cancellation.js')

const ID = '00000000-0000-4000-8000-0000000000c1'
const DEPOSITED = '2026-07-28T10:00:00.000Z'

const review = (over: Record<string, unknown> = {}) => ({
  transfer_id: ID,
  state: 'UNDER_REVIEW',
  send_amount_minor: 19801,
  fee_amount_minor: 199,
  requested_at: '2026-07-28T09:00:00.000Z',
  within_window: true,
  refund_payment_ref: null,
  ...over,
})

const args = (over: Record<string, unknown> = {}) =>
  ({
    mode: 'resolve' as const,
    transferId: ID,
    operator: 'jphelps',
    confirm: true,
    action: 'refund' as const,
    ...over,
  }) as Parameters<typeof resolve>[0]

beforeEach(() => {
  vi.clearAllMocks()
  vi.spyOn(console, 'log').mockImplementation(() => {})
  listPendingReviews.mockResolvedValue([review()])
  refundCancellation.mockResolvedValue({ done: true, outcome: 'refunded' })
  denyCancellation.mockResolvedValue({ done: true, outcome: 'denied' })
})

describe('parseArgs', () => {
  it('parses the refund form', () => {
    expect(parseArgs([ID, '--operator', 'jphelps', '--refund', '--confirm'])).toEqual({
      mode: 'resolve',
      transferId: ID,
      operator: 'jphelps',
      confirm: true,
      action: 'refund',
    })
  })

  it('parses the deny form with its evidence', () => {
    expect(
      parseArgs([ID, '--operator', 'jphelps', '--deny', '--deposited-at', DEPOSITED, '--confirm']),
    ).toMatchObject({ action: 'deny', depositedAt: DEPOSITED })
  })

  it('defaults to a dry run', () => {
    expect(parseArgs([ID, '--operator', 'jphelps', '--refund'])).toMatchObject({ confirm: false })
  })

  it('parses --list', () => {
    expect(parseArgs(['--list'])).toEqual({ mode: 'list' })
  })

  // --refund and --deny are OPPOSITE outcomes on the same transfer. A parser
  // that guesses between them can pay a delivered transfer twice by accident.
  it('refuses both actions at once, and neither', () => {
    expect(parseArgs([ID, '--operator', 'jp', '--refund', '--deny'])).toMatchObject({
      mode: 'error',
      message: expect.stringContaining('mutually exclusive'),
    })
    expect(parseArgs([ID, '--operator', 'j'])).toMatchObject({
      mode: 'error',
      message: expect.stringContaining('one of --refund or --deny'),
    })
  })

  it('requires --deposited-at with --deny and rejects a bad one', () => {
    expect(parseArgs([ID, '--operator', 'jp', '--deny'])).toMatchObject({
      mode: 'error',
      message: expect.stringContaining('--deposited-at'),
    })
    expect(
      parseArgs([ID, '--operator', 'jp', '--deny', '--deposited-at', 'yesterday']),
    ).toMatchObject({ mode: 'error', message: expect.stringContaining('not a valid timestamp') })
  })

  // Accepting it silently on a refund would imply it had been recorded.
  it('rejects --deposited-at on a refund', () => {
    expect(
      parseArgs([ID, '--operator', 'jp', '--refund', '--deposited-at', DEPOSITED]),
    ).toMatchObject({ mode: 'error', message: expect.stringContaining('only to --deny') })
  })

  // The trigger-refund lesson: a flag-shaped value must never become the actor,
  // or the only durable record of who authorized a payment is `ops:--confirm`.
  it('never lets a flag become the operator', () => {
    expect(parseArgs([ID, '--operator', '--confirm', '--refund'])).toMatchObject({ mode: 'error' })
    expect(parseArgs([ID, '--operator', 'jp', '--operator', 'k', '--refund'])).toMatchObject({
      mode: 'error',
      message: expect.stringContaining('more than once'),
    })
  })

  it('rejects unknown options and non-uuid ids', () => {
    expect(parseArgs([ID, '--operator', 'jp', '--refund', '--comfirm'])).toMatchObject({
      mode: 'error',
      message: expect.stringContaining('unknown option'),
    })
    expect(parseArgs(['not-a-uuid', '--operator', 'jp', '--refund'])).toMatchObject({
      mode: 'error',
      message: expect.stringContaining('not a transfer id'),
    })
  })

  it('lowercases the id so the ledger key check cannot miss after paying', () => {
    expect(parseArgs([ID.toUpperCase(), '--operator', 'jp', '--refund'])).toMatchObject({
      transferId: ID,
    })
  })

  it('--list takes no other arguments', () => {
    expect(parseArgs(['--list', '--confirm'])).toMatchObject({ mode: 'error' })
  })
})

describe('resolve', () => {
  it('a dry run writes nothing', async () => {
    await resolve(args({ confirm: false }))
    expect(refundCancellation).not.toHaveBeenCalled()
    expect(denyCancellation).not.toHaveBeenCalled()
  })

  // THE legal guard of this tool. A timely cancellation on a delivered transfer
  // is owed a full refund; letting an operator close one by typing a denial is
  // the single most expensive mistake this CLI could permit.
  it('REFUSES to deny a timely request, even before the service is called', async () => {
    listPendingReviews.mockResolvedValue([review({ within_window: true })])

    await expect(
      resolve(args({ action: 'deny', depositedAt: DEPOSITED })),
    ).rejects.toThrow(/TIMELY/)
    expect(denyCancellation).not.toHaveBeenCalled()
  })

  it('denies an out-of-window request, passing the operator’s evidence through', async () => {
    listPendingReviews.mockResolvedValue([review({ within_window: false, state: 'COMPLETED' })])

    await resolve(args({ action: 'deny', depositedAt: DEPOSITED }))

    expect(denyCancellation).toHaveBeenCalledWith({
      transferId: ID,
      operator: 'jphelps',
      depositedAt: DEPOSITED,
    })
  })

  it('refuses when there is no open request — the request is the authority to pay', async () => {
    listPendingReviews.mockResolvedValue([])
    await expect(resolve(args())).rejects.toThrow(/no open cancellation request/)
    expect(refundCancellation).not.toHaveBeenCalled()
  })

  it('surfaces an abandoned claim without paying', async () => {
    refundCancellation.mockResolvedValue({
      done: false,
      reason: 'claim_abandoned',
      claimedAt: '2026-07-28T09:00:00.000Z',
      claimedBy: 'ops:someone',
    })
    const err = await resolve(args()).then(
      () => null,
      (e: unknown) => e as Error,
    )
    expect(err).toBeInstanceOf(StepError)
    expect(err!.message).toMatch(/MAY ALREADY HAVE BEEN PAID/)
  })

  it('does not claim credit for a run that wrote nothing', async () => {
    refundCancellation.mockResolvedValue({ done: true, outcome: 'already_refunded' })
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})

    await resolve(args())

    const printed = log.mock.calls.flat().join('\n')
    expect(printed).toContain('was already refunded')
    expect(printed).not.toContain('resolved by ops:jphelps')
  })

  it('refuses a transfer that is not under review', async () => {
    refundCancellation.mockResolvedValue({ done: false, reason: 'not_under_review', state: 'COMPLETED' })
    await expect(resolve(args())).rejects.toThrow(/unreviewed double payment/)
  })
})

describe('list', () => {
  it('marks a timely request as owing a refund', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    await list()
    expect(log.mock.calls.flat().join('\n')).toMatch(/TIMELY — a full refund is owed/)
  })

  it('says so plainly when nothing is open', async () => {
    listPendingReviews.mockResolvedValue([])
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    await list()
    expect(log.mock.calls.flat().join('\n')).toContain('nothing awaiting a decision')
  })
})
