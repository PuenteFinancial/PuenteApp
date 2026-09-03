import type { ErrorEvent } from '@sentry/node'

// Repeat suppression for Sentry events. Lives apart from instrument.ts so it
// can be tested without triggering Sentry.init() as an import side effect.
//
// Why this exists: every cron pager in the worker re-evaluates a PERSISTING
// condition on a fixed tick — payout.sweep every minute, stuck-watch and
// payout-poll every five — and each evaluation captures a fresh event. Sentry's
// fingerprint collapses those into one ISSUE but bills every EVENT, so a single
// unresolved condition costs thousands of events a day. That is how the org's
// error quota was exhausted (2026-09-01: two emitters accounted for 91% of 30
// days of volume, and staging for 94% of it).
//
// The FIRST occurrence of a key always ships; repeats inside the window are
// dropped. A new problem still arrives immediately — only the re-pages that
// carry no new information are removed.

// Pager fingerprints embed transfer ids, so the key space is unbounded in a
// long-lived worker.
export const MAX_TRACKED_KEYS = 5_000

// Returns null when an event should never be suppressed.
export function suppressionKey(event: ErrorEvent): string | null {
  // An explicit fingerprint means a deliberate pager (reconcile findings,
  // stuck-watch, payout holds) — exactly the re-fire-on-a-tick shape.
  const fingerprint = event.fingerprint
  if (fingerprint && fingerprint.length > 0) return fingerprint.join('|')
  // Un-fingerprinted exceptions loop too, and the biggest single one did: the
  // Bridge 400 retry was captured by a bare captureException in worker.ts and
  // was the second-largest emitter. A fingerprint-only guard would have let it
  // through at full price, so fall back to the exception's grouping identity.
  const exception = event.exception?.values?.[0]
  if (exception?.type) return `${exception.type}|${exception.value ?? ''}`
  return null
}

// A stateful filter. `windowMs` of 0 disables suppression entirely (the
// production posture — see instrument.ts).
export function createDedupeFilter(windowMs: number): (event: ErrorEvent, now: number) => boolean {
  const lastSent = new Map<string, number>()
  return (event, now) => {
    if (windowMs <= 0) return true
    const key = suppressionKey(event)
    if (key === null) return true
    const previous = lastSent.get(key)
    if (previous !== undefined && now - previous < windowMs) return false
    // Re-insert so the key moves to the end of the eviction order: Map
    // preserves insertion order, so the first key is the least recently sent.
    lastSent.delete(key)
    lastSent.set(key, now)
    if (lastSent.size > MAX_TRACKED_KEYS) {
      const oldest = lastSent.keys().next()
      if (!oldest.done) lastSent.delete(oldest.value)
    }
    return true
  }
}
