import type { PayoutDestination, Recipient } from '@puente/shared'
import { api } from '../api'

// Data access for the recipients screen. Fetchers and key factory live here
// rather than inline in the screen for the same reason routeAfterSignIn does:
// mobile has no RNTL and vitest.config.ts excludes app/**, so anything left in
// a component is untestable by construction.

/**
 * Hierarchical query keys, so a mutation can invalidate a whole subtree with
 * one call instead of enumerating every key it might have touched.
 *
 *   ['recipients']                          → everything below
 *   ['recipients', 'list']                  → the list itself
 *   ['recipients', id, 'destinations']      → one recipient's payout accounts
 *
 * Archiving a recipient cascades to its destinations server-side
 * (apps/api/src/routes/v1/recipients.ts), so the mutation that does it
 * invalidates `all` rather than the two keys it can name.
 */
export const recipientKeys = {
  all: ['recipients'] as const,
  list: () => [...recipientKeys.all, 'list'] as const,
  destinations: (recipientId: string) =>
    [...recipientKeys.all, recipientId, 'destinations'] as const,
}

/**
 * Thrown for any non-2xx. Carries the status because that is what the UI maps
 * onto copy (errorKeyFor) and what the retry policy branches on — a message
 * string would force both to parse English prose.
 */
export class ApiRequestError extends Error {
  constructor(readonly status: number) {
    super(`request failed with ${status}`)
    this.name = 'ApiRequestError'
  }
}

/**
 * Retry only what retrying can fix.
 *
 * TanStack's default is three attempts with backoff, applied to everything. A
 * 403 kyc_required or a 404 is a settled answer: retrying spends three round
 * trips on a phone's connection and delays the error state by seconds for a
 * result that cannot change. Transport failures and 5xx are the cases where a
 * second attempt is genuinely different.
 */
export function shouldRetry(failureCount: number, error: unknown): boolean {
  if (failureCount >= 2) return false
  // Not an ApiRequestError means fetch() itself rejected — no response at all,
  // which is exactly the transient case worth another go.
  if (!(error instanceof ApiRequestError)) return true
  return error.status >= 500
}

// The list is capped rather than paged. Web does the same (`?limit=50`), and a
// user with more than fifty saved recipients is not a case this MVP has;
// cursor pagination is already in the API when it is.
const LIST_LIMIT = 50

export async function fetchRecipients(): Promise<Recipient[]> {
  const res = await api.fetch(`/v1/recipients?limit=${LIST_LIMIT}`)
  if (!res.ok) throw new ApiRequestError(res.status)
  const body = (await res.json()) as { data: Recipient[] }
  return body.data
}

export async function fetchDestinations(recipientId: string): Promise<PayoutDestination[]> {
  const res = await api.fetch(`/v1/recipients/${recipientId}/destinations`)
  if (!res.ok) throw new ApiRequestError(res.status)
  const body = (await res.json()) as { data: PayoutDestination[] }
  return body.data
}

/**
 * Is this failure the API telling us the user does not belong on this screen?
 *
 * `requireApprovedUser` (apps/api/src/routes/v1/recipients.ts) answers 403
 * kyc_required on every handler of this surface, reads included. Web deals with
 * it by redirecting inside the server component before it ever calls; mobile
 * has to notice it in the client and hand off to the router, or a user who is
 * not approved yet sits on an error state with nothing to act on.
 *
 * Reachable but rare: the entry point on home already implies approved, so this
 * is the stale-session and deep-link path.
 */
export function isKycGateError(error: unknown): boolean {
  return error instanceof ApiRequestError && error.status === 403
}
