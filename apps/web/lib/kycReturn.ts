// Pure decision logic for the Bridge/Persona return leg (K5 send-flow
// fallback) — split out for unit tests, payStep.ts convention.

export const KYC_NEXT_COOKIE = 'kyc_next'

// Strict shape: a transfer page on this origin and nothing else. The cookie
// is client-writable, so this is an open-redirect guard, not a convenience
// check — anything that doesn't match falls back to the onboarding routing.
const KYC_NEXT_PATTERN =
  /^\/dashboard\/send\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

/**
 * Where the return page should land. The transfer page wins for approved AND
 * still-pending statuses (the pay step's bridge polling handles an in-flight
 * webhook; the onboarding pending poller is exactly what flag-ON users must
 * never see). Rejection always keeps the dedicated page — it explains and
 * offers the retry.
 */
export function resolveKycReturnPath(rawNext: string | undefined, kycStatus: string): string {
  const next = rawNext && KYC_NEXT_PATTERN.test(rawNext) ? rawNext : null
  if (next && kycStatus !== 'rejected') return next
  if (kycStatus === 'approved') return '/dashboard'
  if (kycStatus === 'rejected') return '/onboarding/rejected'
  return '/onboarding/pending'
}
