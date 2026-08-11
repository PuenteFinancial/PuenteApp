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
