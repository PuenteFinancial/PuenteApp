// WHICH BOOK this deployment serves: a short, stable fingerprint of the
// database behind it, stamped onto every funding object we create at a
// provider.
//
// The problem it solves. One Stripe TEST account is shared by everything that
// is not production — staging, and any local stack a developer points at it.
// A Checkout Session created against a local database that is later torn down
// leaves a PAID PaymentIntent whose transfer_id matches no row in any
// surviving database, and to `stripe_orphans` that is indistinguishable from
// the thing the check exists to catch: money collected against OUR book with
// no transfer to show for it. That happened on 2026-09-15 (NODE-26) and took
// an acknowledgement to silence.
//
// So each payment carries the book it was created for. A stamp naming a
// DIFFERENT book is another environment's business. An ABSENT stamp still
// pages — a missing answer is not a safe answer, and every payment created
// before this shipped has none.
//
// Derived from the SUPABASE_URL HOSTNAME, never the whole URL: scheme, port,
// path and trailing slash are cosmetic, and a cosmetic edit that silently
// changed a book's identity would turn real orphans into "someone else's"
// (the one false negative this mechanism can produce). Hashed rather than
// stamped verbatim so no infrastructure identifier of ours goes into a third
// party's system; the reconciliation run row carries our own ref beside the
// check, so a stamp seen in the Stripe dashboard is one query from a name.
import { createHash } from 'node:crypto'
import { env } from './env.js'

export function bookRefFor(supabaseUrl: string): string {
  // Loud rather than plausible. A blank input would fingerprint the empty
  // string — a perfectly well-formed ref belonging to no database, which would
  // make our own payments read as another book's and hide the exact orphans
  // this exists to find. env.SUPABASE_URL is required (config/env.ts), so this
  // is reachable only from a test that mocks `env` without it.
  if (typeof supabaseUrl !== 'string' || supabaseUrl.trim() === '') {
    throw new Error('bookRefFor: SUPABASE_URL is unset — the book cannot be fingerprinted')
  }
  let host: string
  try {
    host = new URL(supabaseUrl).hostname.toLowerCase()
  } catch {
    host = supabaseUrl.trim().toLowerCase()
  }
  return createHash('sha256').update(host).digest('hex').slice(0, 8)
}

let cached: string | undefined

/**
 * This process's book. Computed on FIRST USE, not at import: `env` is mocked
 * wholesale in unit tests, and a module-load read would make every test near
 * this import graph fail on a missing SUPABASE_URL with no hint as to why.
 * Constant for the life of the process once computed.
 */
export function bookRef(): string {
  cached ??= bookRefFor(env.SUPABASE_URL)
  return cached
}
