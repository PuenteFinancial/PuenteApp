import type { MeResponse } from './types'

// Mobile's counterpart to apps/web/app/continue/page.tsx — the single
// post-sign-in router. Every entry point converges here: OTP verify, a cold
// launch with a stored session, and any screen that finds a valid session in
// the wrong place.
//
// Kept as a pure function of the /v1/users/me response so the whole decision
// table is unit-testable without a navigator. The web version is a server
// component precisely so a stale client bundle can never run yesterday's
// rules; mobile cannot have that, since the rules ship inside the binary — so
// the mitigation here is that the rules are trivially inspectable and tested.
export type Destination =
  | '/(auth)'
  // `/(app)/home`, not `/(app)`: an index route inside (app) would resolve to
  // the same `/` as (auth)'s index, leaving the cold-launch destination up to
  // whichever group expo-router happens to match first. Every route in the
  // authenticated group is named, so `/` unambiguously means the sign-in
  // screen.
  | '/(app)/home'
  | '/(app)/profile'
  | '/(app)/kyc'
  | '/(app)/pending'
  | '/(app)/rejected'

export interface MeResult {
  status: number
  body: MeResponse | null
}

export function routeAfterSignIn(res: MeResult): Destination {
  // Row missing — deleted out of band, or predating the auth trigger. The
  // verify handler self-heals it on the next sign-in; meanwhile the profile
  // form is the right destination (matches continue/page.tsx:23).
  if (res.status === 404) return '/(app)/profile'

  // Anything else non-OK (including a 401 the client could not refresh past)
  // means we do not have a usable session — start over.
  if (res.status < 200 || res.status >= 300 || !res.body) return '/(auth)'

  const { firstName, lastName, email, kycStatus } = res.body
  if (!firstName || !lastName || !email) return '/(app)/profile'

  switch (kycStatus) {
    case 'not_started':
      return '/(app)/kyc'
    case 'rejected':
      return '/(app)/rejected'
    case 'approved':
      return '/(app)/home'
    default:
      // pending, manual_review, and anything unrecognized. Defaulting to
      // pending rather than throwing means a kyc_status added server-side
      // shows a holding screen instead of crashing the app.
      return '/(app)/pending'
  }
}
