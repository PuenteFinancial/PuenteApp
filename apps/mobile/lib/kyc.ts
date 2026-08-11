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

/**
 * Constant-time-ish comparison of the returned nonce against the stored one.
 *
 * Length is checked first and the loop always runs to completion over the
 * stored value, so the timing does not advertise how many leading characters
 * matched. This is belt-and-braces — the nonce is single-use and short-lived,
 * and an attacker has no oracle to time against — but it costs nothing.
 */
export function stateMatches(returned: string, stored: string | null): boolean {
  if (!stored || returned.length !== stored.length) return false
  let diff = 0
  for (let i = 0; i < stored.length; i++) {
    diff |= returned.charCodeAt(i) ^ stored.charCodeAt(i)
  }
  return diff === 0
}
