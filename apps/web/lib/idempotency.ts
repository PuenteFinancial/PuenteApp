'use client'

import { useRef } from 'react'

// Client-side idempotency keys for the money-moving POSTs (create / confirm /
// cancel). The API dedupes on (user, endpoint, key) + a body hash, but that
// only guards the proxy→API hop. A browser→proxy retry — network failure,
// impatient double-click, or a React strict-mode double-invoke — must reuse the
// SAME key, or each attempt reaches the API as a fresh request and becomes a
// DUPLICATE transfer. So the key is minted ONCE when the user commits an
// action, held across every retry of that action, and cleared only on success;
// the next logical action then mints its own fresh key. Never regenerate on
// retry; never reuse one key across two different transfers.

export interface IdempotencyKeyHolder {
  // Current key, minting one on first call and returning it verbatim on every
  // subsequent call until clear(). Call this inside the submit handler.
  take(): string
  // Drop the held key so the next take() mints a fresh one. Call after the
  // action succeeds (or is abandoned) — never after a retryable failure.
  clear(): void
  // The held key without minting, or null if none is held.
  peek(): string | null
}

// Pure holder — no React, so it is unit-testable in isolation and the mint
// function is injectable for deterministic tests.
export function createIdempotencyKeyHolder(
  mint: () => string = () => crypto.randomUUID(),
): IdempotencyKeyHolder {
  let key: string | null = null
  return {
    take() {
      if (key === null) key = mint()
      return key
    },
    clear() {
      key = null
    },
    peek() {
      return key
    },
  }
}

// React wrapper: one stable holder per mounted action surface. It lives in a
// ref so it survives re-renders and strict-mode double-invoke; because take()
// runs in the submit handler (not during render), the mint happens once per
// commit regardless of how many times the component renders.
export function useIdempotencyKey(): IdempotencyKeyHolder {
  const ref = useRef<IdempotencyKeyHolder | null>(null)
  if (ref.current === null) ref.current = createIdempotencyKeyHolder()
  return ref.current
}
