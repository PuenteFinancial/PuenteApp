import { describe, it, expect } from 'vitest'
import {
  isOpsActivityFeedRowShape,
  isOpsActivityRowShape,
  isKnownActionKind,
  actorShort,
  activityTone,
  formatChange,
  OPS_ACTION_KINDS,
} from './opsActivity'

const feed = {
  id: 'act-1',
  createdAt: '2026-09-09T12:00:00.000Z',
  actor: 'ops:1c23cf20-f79e-4be1-be0f-edf6471a2a0b',
  action: 'hold_release',
  transferId: 'cccccccc-1111-4222-8333-444444444444',
  reason: 'velocity_review',
}
const history = {
  ...feed,
  note: 'Verified by phone.',
  changes: [{ key: 'payoutHoldReason', before: 'velocity_review', after: null }],
  requestId: 'req-1',
}

describe('activity shape guards (slice 2)', () => {
  it('accepts a feed row with nullable transfer and reason', () => {
    expect(isOpsActivityFeedRowShape(feed)).toBe(true)
    expect(isOpsActivityFeedRowShape({ ...feed, transferId: null, reason: null })).toBe(true)
  })

  it('rejects a feed row with a missing or mistyped field', () => {
    expect(isOpsActivityFeedRowShape({ ...feed, createdAt: 12 })).toBe(false)
    expect(isOpsActivityFeedRowShape({ ...feed, actor: undefined })).toBe(false)
    expect(isOpsActivityFeedRowShape('<html>')).toBe(false)
  })

  it('accepts a history row and rejects malformed changes', () => {
    expect(isOpsActivityRowShape(history)).toBe(true)
    expect(isOpsActivityRowShape({ ...history, note: null, requestId: null, changes: [] })).toBe(true)
    expect(isOpsActivityRowShape({ ...history, changes: [{ key: 'x', before: 1, after: null }] })).toBe(false)
    expect(isOpsActivityRowShape({ ...history, changes: 'nope' })).toBe(false)
    expect(isOpsActivityRowShape({ ...history, note: 5 })).toBe(false)
  })
})

describe('activity derivations (slice 2)', () => {
  it('knows the seven action kinds and nothing else', () => {
    for (const kind of OPS_ACTION_KINDS) expect(isKnownActionKind(kind)).toBe(true)
    expect(isKnownActionKind('delete_everything')).toBe(false)
  })

  it('shortens an actor to its prefix and the first eight chars of the id', () => {
    expect(actorShort('ops:1c23cf20-f79e-4be1-be0f-edf6471a2a0b')).toBe('ops:1c23cf20')
    expect(actorShort('worker:payout')).toBe('worker:payout')
    expect(actorShort('1c23cf20-f79e-4be1-be0f-edf6471a2a0b')).toBe('1c23cf20')
  })

  it('tones money-moving actions as progress, the rest neutral', () => {
    expect(activityTone('refund')).toBe('progress')
    expect(activityTone('hold_release')).toBe('progress')
    expect(activityTone('float_topup')).toBe('neutral')
    // The loss path's freeze is the one row that means something went wrong for
    // a real person; it must not scan like a deposit landing.
    expect(activityTone('sender_freeze')).toBe('error')
    // The unfreeze is a decision, not a win: neutral, never success.
    expect(activityTone('sender_unfreeze')).toBe('neutral')
    expect(activityTone('unknown_kind')).toBe('neutral')
  })

  it('formats a change as key: before → after with dashes for absent sides', () => {
    expect(formatChange({ key: 'payoutHoldReason', before: 'velocity_review', after: null })).toBe(
      'payoutHoldReason: velocity_review → —',
    )
    expect(formatChange({ key: 'ledgerComplete', before: null, after: 'true' })).toBe('ledgerComplete: — → true')
  })
})
