import { PostHog } from 'posthog-node'

let posthogClient: PostHog | null = null

export function getPostHogClient() {
  if (!posthogClient) {
    posthogClient = new PostHog(process.env.NEXT_PUBLIC_POSTHOG_PROJECT_TOKEN!, {
      host: process.env.NEXT_PUBLIC_POSTHOG_HOST,
      flushAt: 1,
      flushInterval: 0,
    })
  }
  return posthogClient
}

// Await before returning from a serverless handler. `flushAt: 1` starts the
// send immediately but does not await it, and the function's execution context
// can be frozen or torn down the moment the response is returned — so events
// captured on the request path are routinely lost.
//
// This is not theoretical: during the three-week waitlist outage, 122 client
// exceptions were recorded while ZERO server-side `waitlist_signup_failed`
// events arrived, which is why the failure was invisible in analytics.
//
// Uses flush() rather than shutdown() deliberately: the client is a module-level
// singleton reused across invocations in a warm container, and shutdown() would
// leave it permanently closed for every later request.
export async function flushPostHog(): Promise<void> {
  if (!posthogClient) return
  try {
    await posthogClient.flush()
  } catch {
    // Analytics delivery must never turn into a user-facing failure.
  }
}
