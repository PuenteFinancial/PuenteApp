import { describe, it, expect } from 'vitest'
import type { ErrorEvent } from '@sentry/node'
import { createDedupeFilter, suppressionKey, MAX_TRACKED_KEYS } from './sentry-dedupe.js'

const WINDOW_MS = 60 * 60 * 1000

// The two real shapes from the 2026-09-01 quota burn.
const pagerEvent = (transferId: string): ErrorEvent =>
  ({ fingerprint: ['stuck-transfer', transferId, 'SUBMITTED', '2026-08-25T23:15:55Z'] }) as ErrorEvent

const bridge400 = (): ErrorEvent =>
  ({
    exception: {
      values: [{ type: 'BridgeApiError', value: 'Bridge API request failed with status 400' }],
    },
  }) as ErrorEvent

describe('suppressionKey', () => {
  it('keys an explicit fingerprint on its joined parts', () => {
    expect(suppressionKey(pagerEvent('t1'))).toBe(
      'stuck-transfer|t1|SUBMITTED|2026-08-25T23:15:55Z',
    )
  })

  // The gap that let the second-largest emitter through at full price: the
  // Bridge 400 loop was a bare captureException with no fingerprint.
  it('falls back to exception type + value when there is no fingerprint', () => {
    expect(suppressionKey(bridge400())).toBe(
      'BridgeApiError|Bridge API request failed with status 400',
    )
  })

  it('returns null for an event it cannot key, so it is never suppressed', () => {
    expect(suppressionKey({} as ErrorEvent)).toBeNull()
    expect(suppressionKey({ exception: { values: [] } } as unknown as ErrorEvent)).toBeNull()
  })
})

describe('createDedupeFilter', () => {
  it('always sends the first occurrence — a new problem is never delayed', () => {
    const send = createDedupeFilter(WINDOW_MS)
    expect(send(pagerEvent('t1'), 0)).toBe(true)
  })

  it('drops repeats inside the window and sends again once it lapses', () => {
    const send = createDedupeFilter(WINDOW_MS)
    expect(send(pagerEvent('t1'), 0)).toBe(true)
    expect(send(pagerEvent('t1'), 5 * 60_000)).toBe(false)
    expect(send(pagerEvent('t1'), WINDOW_MS - 1)).toBe(false)
    expect(send(pagerEvent('t1'), WINDOW_MS)).toBe(true)
  })

  it('collapses the 5-min stuck-watch re-fire to one event per window', () => {
    const send = createDedupeFilter(WINDOW_MS)
    let sent = 0
    // 24h of a transfer stuck past its dwell threshold, paged every 5 minutes.
    for (let t = 0; t < 24 * 60 * 60_000; t += 5 * 60_000) {
      if (send(pagerEvent('t1'), t)) sent++
    }
    expect(sent).toBe(24) // was 288
  })

  it('collapses the 1-min Bridge 400 loop, which carries no fingerprint', () => {
    const send = createDedupeFilter(WINDOW_MS)
    let sent = 0
    // The real incident: 23.5h at one attempt per minute.
    for (let t = 0; t < 1411 * 60_000; t += 60_000) {
      if (send(bridge400(), t)) sent++
    }
    expect(sent).toBe(24) // was 1,378
  })

  it('keeps distinct transfers distinct — one stuck row cannot mask another', () => {
    const send = createDedupeFilter(WINDOW_MS)
    expect(send(pagerEvent('t1'), 0)).toBe(true)
    expect(send(pagerEvent('t2'), 0)).toBe(true)
    expect(send(pagerEvent('t1'), 0)).toBe(false)
  })

  it('never suppresses an event it cannot key', () => {
    const send = createDedupeFilter(WINDOW_MS)
    expect(send({} as ErrorEvent, 0)).toBe(true)
    expect(send({} as ErrorEvent, 0)).toBe(true)
  })

  it('is disabled at window 0 — the production posture', () => {
    const send = createDedupeFilter(0)
    expect(send(pagerEvent('t1'), 0)).toBe(true)
    expect(send(pagerEvent('t1'), 0)).toBe(true)
    expect(send(pagerEvent('t1'), 0)).toBe(true)
  })

  it('bounds the key map so per-transfer fingerprints cannot grow it forever', () => {
    const send = createDedupeFilter(WINDOW_MS)
    for (let i = 0; i < MAX_TRACKED_KEYS + 100; i++) send(pagerEvent(`t${i}`), 0)
    // The oldest keys were evicted, so they send again rather than staying
    // suppressed off a stale entry.
    expect(send(pagerEvent('t0'), 1)).toBe(true)
    // The most recent key is still tracked.
    expect(send(pagerEvent(`t${MAX_TRACKED_KEYS + 99}`), 1)).toBe(false)
  })
})
