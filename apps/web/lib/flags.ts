import { getPostHogClient } from './posthog-server'

// Server-only. Feature flag gating the web send-money flow. Read on the server
// (in the page guards + the dashboard CTA) so the gate can't be flipped from the
// client and there's no hydration flash. kebab-case, area-prefixed per the
// feature-flag skill.
export const SEND_MONEY_FLAG = 'web-send-money'

// Decide the flag's effective value from PostHog's answer. When PostHog can't
// answer — unconfigured locally, unknown flag, or an error — fail SAFE for a
// money-moving flow: visible outside production so the flow stays buildable and
// testable on dev/preview/staging, hidden in production until the flag is
// deliberately turned on. (Prod has a second guard anyway: the mock-funding lock
// 503s create/confirm, so nothing can move even if this ever read true.)
export function resolveSendMoneyFlag(phValue: boolean | undefined, isProduction: boolean): boolean {
  if (typeof phValue === 'boolean') return phValue
  return !isProduction
}

// "Real production" = the Vercel Production deployment (the `production` branch).
// NODE_ENV is 'production' for EVERY Vercel build — preview + staging + prod — so
// it can't distinguish them; VERCEL_ENV can. Fall back to NODE_ENV for local /
// non-Vercel runs. Getting this wrong would hide the flow's fallback on
// staging/preview (fails safe, but breaks the preview-URL workflow).
function isProductionEnv(): boolean {
  if (process.env.VERCEL_ENV) return process.env.VERCEL_ENV === 'production'
  return process.env.NODE_ENV === 'production'
}

// Is the send-money flow enabled for this user? distinctId should be the stable
// user id (from /v1/users/me) so a percentage rollout assigns consistently.
export async function isSendMoneyEnabled(distinctId: string): Promise<boolean> {
  const isProduction = isProductionEnv()
  // No PostHog token (typical local dev): skip the call, use the safe fallback.
  if (!process.env.NEXT_PUBLIC_POSTHOG_PROJECT_TOKEN) {
    return resolveSendMoneyFlag(undefined, isProduction)
  }
  try {
    const value = await getPostHogClient().isFeatureEnabled(SEND_MONEY_FLAG, distinctId)
    return resolveSendMoneyFlag(value, isProduction)
  } catch (err) {
    // Keep failing safe, but never dark: a persistent PostHog failure must be
    // distinguishable from an intentionally-off flag, or "we flipped it on, why
    // is nothing live?" has no breadcrumb.
    console.error('send-money flag lookup failed:', err instanceof Error ? err.message : 'unknown')
    return resolveSendMoneyFlag(undefined, isProduction)
  }
}
