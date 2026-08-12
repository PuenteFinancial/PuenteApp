// The Bridge ToS round trip, reduced to the parts worth testing without a
// browser: minting the nonce and reading the return URL back.
//
// WHY A NONCE AT ALL. Bridge's ToS page finishes by assigning
// `location.href = <redirect_uri>` — a bare navigation with no validation of
// the target, verified against their sandbox on 2026-08-11. It appends
// `signed_agreement_id` and preserves any query params already on the URI.
//
// That means anything able to open `puente://kyc/tos-return?...` on the device
// looks exactly like a genuine return. Without a nonce the app would happily
// take an attacker's `signed_agreement_id` and spend the user's own token
// exchanging it, binding their Puente account to a Bridge customer created
// under someone else's signed agreement. The nonce is what makes a return
// provably ours.

// Keychain key. Namespaced like the session keys in secureTokenStore.
export const KYC_STATE_KEY = 'puente.kycState'

// Must satisfy the pattern the API pins on `state`
// (apps/api/src/routes/v1/users.ts) — that check is what stops a nonce from
// smuggling extra query parameters into the redirect URI.
const STATE_PATTERN = /^[A-Za-z0-9_-]{16,64}$/

export function isValidState(state: string): boolean {
  return STATE_PATTERN.test(state)
}

export interface TosReturn {
  state: string
  signedAgreementId: string
}

/**
 * Reads the deep link Bridge sends back. Returns null for anything that is not
 * a complete, well-formed return — the caller treats null as "not ours".
 *
 * Deliberately does NOT compare the nonce: the comparison needs the stored
 * value, which is I/O, and keeping it out here means the parsing rules can be
 * tested exhaustively on their own.
 */
export function parseTosReturn(url: string): TosReturn | null {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return null
  }

  const state = parsed.searchParams.get('state')
  const signedAgreementId = parsed.searchParams.get('signed_agreement_id')

  if (!state || !signedAgreementId) return null
  // A malformed nonce cannot match anything we issued, and rejecting it here
  // means the comparison below is always between two well-formed values.
  if (!isValidState(state)) return null

  return { state, signedAgreementId }
}

// How long an issued nonce stays usable.
//
// Without this the nonce is single-use but not short-lived: it sits in the
// keychain until the next attempt overwrites it, so one abandoned mid-flow
// stays valid indefinitely. The return leg is a GET, so the nonce necessarily
// travels in a URL that Railway's edge logs and we do not control the retention
// of — a bounded window is what makes "short-lived" true rather than a habit.
//
// Fifteen minutes is well past a real ToS acceptance (seconds) and well short
// of useful to anyone reading it out of a log tomorrow.
export const KYC_STATE_TTL_MS = 15 * 60 * 1000

export interface StoredState {
  state: string
  issuedAt: number
}

export function serializeState(state: string, now: number): string {
  return JSON.stringify({ state, issuedAt: now } satisfies StoredState)
}

/**
 * Reads back what serializeState wrote. Returns null for anything unreadable —
 * a corrupt record cannot be matched against, and treating it as "no flow in
 * progress" is the safe reading.
 */
export function parseStoredState(raw: string | null): StoredState | null {
  if (!raw) return null
  try {
    const parsed: unknown = JSON.parse(raw)
    if (typeof parsed !== 'object' || parsed === null) return null
    const { state, issuedAt } = parsed as Record<string, unknown>
    if (typeof state !== 'string' || typeof issuedAt !== 'number') return null
    if (!Number.isFinite(issuedAt)) return null
    return { state, issuedAt }
  } catch {
    return null
  }
}

/**
 * Does this return belong to a flow we started, recently?
 *
 * The comparison is constant-time-ish: length first, then a loop that always
 * runs to completion over the stored value, so timing does not advertise how
 * many leading characters matched. Belt-and-braces — an attacker has no oracle
 * to time against — but it costs nothing.
 */
export function stateMatches(returned: string, stored: StoredState | null, now: number): boolean {
  if (!stored) return false

  // Expiry before comparison: an expired nonce is not a match regardless of
  // what it contains, and checking first means a stale record can never be
  // accepted through some later bug in the comparison.
  const age = now - stored.issuedAt
  if (age < 0 || age > KYC_STATE_TTL_MS) return false

  if (returned.length !== stored.state.length) return false
  let diff = 0
  for (let i = 0; i < stored.state.length; i++) {
    diff |= returned.charCodeAt(i) ^ stored.state.charCodeAt(i)
  }
  return diff === 0
}

/**
 * Where to send someone coming back from Persona.
 *
 * NOT routeAfterSignIn. That maps `not_started` to the KYC screen, which is
 * right on a cold launch and wrong here: the webhook that flips kyc_status
 * usually has not landed by the time the user dismisses the browser, so a
 * returning user would be dropped back onto the "verify your identity" screen
 * they just finished, looking like it failed.
 *
 * Mirrors apps/web/app/onboarding/kyc/return/page.tsx: approved and rejected
 * are the only decided states; everything else — including not_started — means
 * "we do not know yet", which is what the pending screen is for.
 */
export type KycReturnDestination = '/(app)/home' | '/(app)/rejected' | '/(app)/pending'

export function routeAfterKycReturn(kycStatus: string | null | undefined): KycReturnDestination {
  if (kycStatus === 'approved') return '/(app)/home'
  if (kycStatus === 'rejected') return '/(app)/rejected'
  return '/(app)/pending'
}
