// Pure decision logic for the Bridge/Persona return leg (K5 send-flow
// fallback, K6 ToS-first leg) — split out for unit tests, payStep.ts convention.

export const KYC_NEXT_COOKIE = 'kyc_next'

// Which UI language the sender was in when they left for Bridge's hosted
// page. The tos-return server component reads it so the consent evidence
// records the locale the terms were presented in (language lives in
// localStorage, which a server component cannot see).
export const KYC_LOCALE_COOKIE = 'kyc_locale'

// Strict shape: a transfer page on this origin and nothing else. The cookie
// is client-writable, so this is an open-redirect guard, not a convenience
// check — anything that doesn't match falls back to the onboarding routing.
const KYC_NEXT_PATTERN =
  /^\/dashboard\/send\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

/** The validated `kyc_next` value, or null for anything that isn't a strict
 *  transfer path. */
export function validKycNext(raw: string | undefined): string | null {
  return raw && KYC_NEXT_PATTERN.test(raw) ? raw : null
}

/** Enum-validated locale from the `kyc_locale` cookie; `en` for anything else
 *  (the API's own default). */
export function validKycLocale(raw: string | undefined): 'en' | 'es' {
  return raw === 'es' ? 'es' : 'en'
}

/**
 * Where the return page should land. A valid `next` wins UNCONDITIONALLY: the
 * pay-step machine owns every Bridge outcome for a send-flow user — its
 * bridge polling handles an in-flight webhook, and (K6) its rejection branch
 * fetches the reasons and offers the Persona retry itself. Diverting a
 * rejected sender to /onboarding/rejected (the K5 behaviour) stranded them on
 * the flag-OFF page whose "try again" leads back into onboarding, not the
 * transfer. Without a cookie, the pre-K5 onboarding routing applies.
 */
export function resolveKycReturnPath(rawNext: string | undefined, kycStatus: string): string {
  const next = validKycNext(rawNext)
  if (next) return next
  if (kycStatus === 'approved') return '/dashboard'
  if (kycStatus === 'rejected') return '/onboarding/rejected'
  return '/onboarding/pending'
}
