import { createApiClient, type ApiClient } from './auth/apiClient'
import { secureTokenStore } from './auth/secureTokenStore'

// EXPO_PUBLIC_* is inlined by Metro at build time, so a missing value here is a
// broken build, not a runtime condition — every authenticated screen would fail
// anyway. Throwing at import time turns that into one legible message instead
// of a scatter of "fetch failed to undefined/v1/..." reports.
const baseUrl = process.env.EXPO_PUBLIC_API_URL
if (!baseUrl) {
  throw new Error('EXPO_PUBLIC_API_URL is not set — see apps/mobile/.env.example')
}

// Set by the root layout once the navigator is mounted, so this module does not
// have to import the router (which would make it untestable in Node and create
// an import cycle through the layout).
let signedOutHandler: (() => void) | null = null

export function setSignedOutHandler(handler: (() => void) | null): void {
  signedOutHandler = handler
}

/**
 * The app's single ApiClient — a module singleton on purpose, not a value
 * handed down through React context.
 *
 * The single-flight refresh guard that PR-C built (lib/auth/apiClient.ts) is
 * closure-scoped to one client instance. Two instances means two concurrent
 * refreshes, and because Supabase rotates refresh tokens single-use, the second
 * one presents a spent token and kills the session. A provider that recreated
 * the client on remount would reintroduce exactly the race the guard exists to
 * prevent, so there is one instance for the process lifetime.
 */
export const api: ApiClient = createApiClient({
  baseUrl,
  tokens: secureTokenStore,
  onSignedOut: () => signedOutHandler?.(),
})

/**
 * For the public routes only — `/v1/auth/otp/send` and `/v1/auth/otp/verify`.
 *
 * Shares the base URL and nothing else. Routing these through `api.fetch`
 * looks harmless (it skips the bearer header when there are no tokens) but a
 * *stale* session in the keychain changes that: the client would spend a
 * proactive refresh on a request that never needed one, and a refresh failure
 * mid-verify clears the store and fires the signed-out handler, yanking the
 * user out of the screen they are actively using. Signing in is not a session
 * operation, so it does not touch the session machinery.
 */
export async function publicFetch(path: string, init: RequestInit = {}): Promise<Response> {
  return fetch(`${baseUrl}${path}`, {
    ...init,
    headers: { 'Content-Type': 'application/json', ...init.headers },
  })
}
