// Moved to @puente/shared (src/api/apiError.ts) — the error-code → localized
// message mapping is identical on web and mobile. Shim keeps the existing
// `@/lib/apiError` imports, including the relative ones in transferState.ts
// and opsOverview.ts, working unchanged.
export { parseApiError, errorMessage, parseCancellationRequiresSupport } from '@puente/shared'
export type { ApiErrorEnvelope } from '@puente/shared'
