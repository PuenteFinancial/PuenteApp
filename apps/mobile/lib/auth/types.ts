// The session as the app stores it. `expiresAt` is an absolute epoch-ms
// instant, deliberately not the `expiresIn` seconds the API returns: a
// duration is only meaningful next to the moment it was issued, and the app
// reads this back after cold launches hours later.
export interface Tokens {
  accessToken: string
  refreshToken: string
  expiresAt: number
}

// Storage is an interface so the whole client is testable in Node with an
// in-memory implementation. The real one (expo-secure-store) is the single
// untested file, and it is deliberately kept to thin get/set/delete calls.
export interface TokenStore {
  read(): Promise<Tokens | null>
  write(tokens: Tokens): Promise<void>
  clear(): Promise<void>
}

// What POST /v1/auth/otp/verify and POST /v1/auth/refresh both return
// (apps/api/src/routes/v1/auth.ts).
export interface SessionResponse {
  accessToken: string
  refreshToken: string
  expiresIn: number
  userId: string
}

// GET /v1/users/me — only the fields the post-sign-in routing decision reads.
export interface MeResponse {
  id: string
  firstName: string | null
  lastName: string | null
  email: string | null
  kycStatus: string
  bridgeCustomerId: string | null
}

export function isSessionResponse(body: unknown): body is SessionResponse {
  if (typeof body !== 'object' || body === null) return false
  const b = body as Record<string, unknown>
  return (
    typeof b.accessToken === 'string' &&
    typeof b.refreshToken === 'string' &&
    typeof b.expiresIn === 'number' &&
    typeof b.userId === 'string'
  )
}

// Absolute expiry from the API's relative `expiresIn`, minus a skew allowance
// so a token that is about to lapse mid-flight is refreshed before it is used
// rather than after a 401 round-trip.
export const EXPIRY_SKEW_MS = 30_000

export function tokensFromSession(session: SessionResponse, now: number): Tokens {
  return {
    accessToken: session.accessToken,
    refreshToken: session.refreshToken,
    expiresAt: now + session.expiresIn * 1000,
  }
}
