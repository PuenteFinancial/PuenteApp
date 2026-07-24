import { describe, it, expect } from 'vitest'
import {
  TIMELINE_STEPS,
  canRequestCancel,
  classifyCancelResponse,
  isOnHappyPath,
  isSettled,
  isTransferShape,
  outcomeFor,
  timelineFor,
  type TrackedTransfer,
  type TransferState,
} from './transferState'

const money = (amountMinor: number, currency: string) => ({ amountMinor, currency })

const transfer = (over: Partial<TrackedTransfer> = {}): TrackedTransfer => ({
  id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2',
  state: 'FUNDED',
  totalAmount: money(10_250, 'USD'),
  sendAmount: money(10_000, 'USD'),
  feeAmount: money(250, 'USD'),
  receiveAmount: money(173_400, 'MXN'),
  fxRate: '17.3400',
  paymentAt: '2026-07-23T12:00:00.000Z',
  cancelableUntil: '2026-07-23T12:30:00.000Z',
  completedAt: null,
  createdAt: '2026-07-23T11:59:00.000Z',
  ...over,
})

const NOW = new Date('2026-07-23T12:10:00.000Z').getTime()

describe('timelineFor', () => {
  it('marks the current step and leaves later steps upcoming', () => {
    expect(timelineFor('SUBMITTED')).toEqual([
      { step: 'PENDING_PAYMENT', status: 'done' },
      { step: 'FUNDED', status: 'done' },
      { step: 'SUBMITTED', status: 'current' },
      { step: 'IN_FLIGHT', status: 'upcoming' },
      { step: 'COMPLETED', status: 'upcoming' },
    ])
  })

  it('starts with only the first step current', () => {
    expect(timelineFor('PENDING_PAYMENT').map((s) => s.status)).toEqual([
      'current',
      'upcoming',
      'upcoming',
      'upcoming',
      'upcoming',
    ])
  })

  it('marks every step done at COMPLETED — an arrival, not a step underway', () => {
    expect(timelineFor('COMPLETED').every((s) => s.status === 'done')).toBe(true)
  })

  it('returns no timeline for states that left the happy path', () => {
    // Guessing progress for these is not possible honestly: REFUNDED is
    // reachable from both CANCELED and PAYOUT_FAILED.
    for (const state of ['CANCELED', 'REFUNDED', 'PAYOUT_FAILED', 'PAYMENT_FAILED'] as const) {
      expect(timelineFor(state)).toEqual([])
    }
  })

  it('covers every happy-path step exactly once, in order', () => {
    expect(timelineFor('IN_FLIGHT').map((s) => s.step)).toEqual([...TIMELINE_STEPS])
  })
})

describe('isOnHappyPath / outcomeFor', () => {
  it('treats the five forward states as in-progress', () => {
    for (const state of TIMELINE_STEPS) expect(isOnHappyPath(state)).toBe(true)
  })

  it('gives no outcome while the transfer is still moving', () => {
    for (const state of ['PENDING_PAYMENT', 'FUNDED', 'SUBMITTED', 'IN_FLIGHT'] as const) {
      expect(outcomeFor(state)).toBeNull()
    }
  })

  it('gives COMPLETED both a timeline and a success outcome', () => {
    expect(isOnHappyPath('COMPLETED')).toBe(true)
    expect(outcomeFor('COMPLETED')).toBe('completed')
  })

  it('maps every off-path state to a distinct outcome', () => {
    expect(outcomeFor('CANCELED')).toBe('canceled')
    expect(outcomeFor('REFUNDED')).toBe('refunded')
    expect(outcomeFor('PAYMENT_FAILED')).toBe('paymentFailed')
    expect(outcomeFor('PAYOUT_FAILED')).toBe('payoutFailed')
    expect(outcomeFor('FUNDING_REVERSED')).toBe('fundingReversed')
    expect(outcomeFor('UNDER_REVIEW')).toBe('underReview')
  })

  it('leaves no state without either a timeline or an outcome', () => {
    // The invariant the tracker relies on: every state renders as something.
    const all: TransferState[] = [
      'PENDING_PAYMENT',
      'FUNDED',
      'SUBMITTED',
      'IN_FLIGHT',
      'COMPLETED',
      'PAYMENT_FAILED',
      'CANCELED',
      'PAYOUT_FAILED',
      'REFUNDED',
      'FUNDING_REVERSED',
      'UNDER_REVIEW',
    ]
    for (const state of all) {
      expect(isOnHappyPath(state) || outcomeFor(state) !== null).toBe(true)
    }
  })
})

describe('isSettled', () => {
  it('stops polling once the state can no longer change on its own', () => {
    expect(isSettled('COMPLETED')).toBe(true)
    expect(isSettled('REFUNDED')).toBe(true)
    expect(isSettled('PAYMENT_FAILED')).toBe(true)
    expect(isSettled('FUNDING_REVERSED')).toBe(true)
  })

  it('keeps polling CANCELED — the refund lands moments later', () => {
    expect(isSettled('CANCELED')).toBe(false)
  })

  it('keeps polling states an operator still resolves', () => {
    expect(isSettled('PAYOUT_FAILED')).toBe(false)
    expect(isSettled('UNDER_REVIEW')).toBe(false)
  })

  it('keeps polling while in flight', () => {
    for (const state of ['PENDING_PAYMENT', 'FUNDED', 'SUBMITTED', 'IN_FLIGHT'] as const) {
      expect(isSettled(state)).toBe(false)
    }
  })
})

describe('canRequestCancel', () => {
  it('offers cancel while FUNDED and inside the window', () => {
    expect(canRequestCancel(transfer(), NOW)).toBe(true)
  })

  it('withdraws the offer once the window has passed', () => {
    const past = new Date('2026-07-23T12:31:00.000Z').getTime()
    expect(canRequestCancel(transfer(), past)).toBe(false)
  })

  it('is exclusive of the boundary instant', () => {
    const exactly = new Date('2026-07-23T12:30:00.000Z').getTime()
    expect(canRequestCancel(transfer(), exactly)).toBe(false)
  })

  it('does not offer cancel before funding', () => {
    expect(canRequestCancel(transfer({ state: 'PENDING_PAYMENT' }), NOW)).toBe(false)
  })

  it('does not offer cancel once the payout is submitted', () => {
    expect(canRequestCancel(transfer({ state: 'SUBMITTED' }), NOW)).toBe(false)
    expect(canRequestCancel(transfer({ state: 'IN_FLIGHT' }), NOW)).toBe(false)
  })

  it('does not offer cancel with no window recorded', () => {
    expect(canRequestCancel(transfer({ cancelableUntil: null }), NOW)).toBe(false)
  })
})

describe('classifyCancelResponse', () => {
  it('reads a 200 as the refunded transfer', () => {
    const body = transfer({ state: 'REFUNDED' })
    const result = classifyCancelResponse(200, body)
    expect(result).toEqual({ kind: 'refunded', accepted: true, transfer: body })
  })

  it('rejects a 200 that is not actually a transfer', () => {
    // A gateway 200 + HTML must not be rendered as a successful refund.
    expect(classifyCancelResponse(200, '<html>').kind).toBe('error')
  })

  it('reads a 202 as support routing and surfaces the server copy', () => {
    const result = classifyCancelResponse(202, {
      id: 'x',
      state: 'SUBMITTED',
      code: 'cancellation_requires_support',
      messages: { en: 'Contact support.', es: 'Comunícate con soporte.' },
    })
    expect(result).toEqual({
      kind: 'support',
      accepted: true,
      messages: { en: 'Contact support.', es: 'Comunícate con soporte.' },
    })
  })

  it('still signals support routing when a 202 body is unreadable', () => {
    // The cancellation right WAS accepted — never render this as a plain error.
    // Null messages tell the caller to use its own mapped string, in the same
    // neutral surface.
    const result = classifyCancelResponse(202, {})
    expect(result).toEqual({ kind: 'support', accepted: true, messages: null })
  })

  it('maps a 409 to its error code', () => {
    const result = classifyCancelResponse(409, {
      error: { code: 'transfer_not_cancelable', message: 'The cancellation window has passed' },
    })
    expect(result).toEqual({ kind: 'error', accepted: false, code: 'transfer_not_cancelable' })
  })

  it('falls back to a null code when the envelope is missing', () => {
    expect(classifyCancelResponse(500, 'gateway error')).toEqual({
      kind: 'error',
      accepted: false,
      code: null,
    })
  })

  // `accepted` is what drives clearing the idempotency key. The API stores any
  // 2xx under the key and replays it for 24 h, releasing only on a non-2xx — so
  // a client that held its key after an unparseable 2xx would replay that same
  // answer forever, locking the sender out of their cancellation right.
  it('marks every 2xx accepted, even when the body cannot be rendered', () => {
    expect(classifyCancelResponse(200, '<html>').accepted).toBe(true)
    expect(classifyCancelResponse(202, {}).accepted).toBe(true)
  })

  it('marks non-2xx not accepted, so the key is held for a genuine retry', () => {
    expect(classifyCancelResponse(409, {}).accepted).toBe(false)
    expect(classifyCancelResponse(500, {}).accepted).toBe(false)
  })
})

describe('isTransferShape', () => {
  it('accepts a real transfer body', () => {
    expect(isTransferShape(transfer())).toBe(true)
  })

  it('rejects non-objects and empty bodies', () => {
    expect(isTransferShape(null)).toBe(false)
    expect(isTransferShape('<html>')).toBe(false)
    expect(isTransferShape({})).toBe(false)
  })

  it('rejects a body whose money fields are missing', () => {
    const partial: Record<string, unknown> = { ...transfer() }
    delete partial.receiveAmount
    expect(isTransferShape(partial)).toBe(false)
  })

  it('rejects an unrecognized state rather than treating it as in-progress', () => {
    expect(isTransferShape({ ...transfer(), state: 'SOMETHING_NEW' })).toBe(false)
  })
})
