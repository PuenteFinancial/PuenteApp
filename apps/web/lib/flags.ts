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

export type AppEnv = 'production' | 'preview' | 'development'

// Which deployment this is. NODE_ENV is 'production' for EVERY Vercel build —
// preview + staging + prod — so it can't distinguish them; VERCEL_ENV can.
// Staging is the `main` branch, which Vercel builds as a PREVIEW deployment
// (only the `production` branch is a Vercel Production deployment), so staging
// and PR previews both report 'preview'. Falls back to NODE_ENV for local /
// non-Vercel runs.
//
// Server-only (VERCEL_ENV is not exposed to the browser). Single source of the
// environment for the whole web app — the production test below, the dev
// simulate-funding proxy, the "Simulate payment" affordance, and the `app_env`
// person property all read it, so they can never disagree.
export function appEnv(): AppEnv {
  const vercel = process.env.VERCEL_ENV
  if (vercel === 'production') return 'production'
  if (vercel === 'preview') return 'preview'
  if (vercel) return 'development'
  return process.env.NODE_ENV === 'production' ? 'production' : 'development'
}

// "Real production" = the Vercel Production deployment (the `production` branch).
// Getting this wrong would hide the flow's fallback on staging/preview (fails
// safe, but breaks the preview-URL workflow).
export function isProductionEnv(): boolean {
  return appEnv() === 'production'
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
    // `app_env` lets a PostHog release condition target staging/preview
    // explicitly. Without it the flag CANNOT be created safely: staging and
    // production share one PostHog project, so a single flag value applies to
    // both, and the moment a real flag exists it overrides the code fallback
    // that is currently the only thing keeping staging visible — creating the
    // flag disabled would go dark on staging. With the property sent, the flag
    // can be created and controlled explicitly while staging stays on.
    const value = await getPostHogClient().isFeatureEnabled(SEND_MONEY_FLAG, distinctId, {
      personProperties: { app_env: appEnv() },
    })
    return resolveSendMoneyFlag(value, isProduction)
  } catch (err) {
    // Keep failing safe, but never dark: a persistent PostHog failure must be
    // distinguishable from an intentionally-off flag, or "we flipped it on, why
    // is nothing live?" has no breadcrumb.
    console.error('send-money flag lookup failed:', err instanceof Error ? err.message : 'unknown')
    return resolveSendMoneyFlag(undefined, isProduction)
  }
}
