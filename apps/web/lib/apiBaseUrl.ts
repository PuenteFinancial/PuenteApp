// Resolve INTERNAL_API_URL, validating SHAPE and not just presence.
//
// A truthiness check is not enough. A value that lost its scheme — e.g. a bare
// `puenteapi-production.up.railway.app` copied out of a hosting dashboard, which
// displays domains without a protocol — passes `if (!apiUrl)` and then throws
// deep inside fetch as an opaque `TypeError: Failed to parse URL`. Because the
// throw happens at call time rather than at boot, nothing surfaces until a user
// submits, and the caller's catch-all turns it into a generic 500.
//
// That exact misconfiguration silently broke production waitlist signups for
// three weeks (last good signup 2026-07-09, found 2026-07-31). Validating here
// makes a malformed value fail loudly and name itself instead of failing as an
// unattributable request-time error.
export function internalApiUrl(): string {
  const apiUrl = process.env.INTERNAL_API_URL
  if (!apiUrl) throw new Error('INTERNAL_API_URL is not configured')

  let parsed: URL
  try {
    parsed = new URL(apiUrl)
  } catch {
    throw new Error(
      `INTERNAL_API_URL is not an absolute URL (got "${apiUrl}") — it must include a scheme, e.g. https://api.example.com`,
    )
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error(
      `INTERNAL_API_URL must use http or https (got "${parsed.protocol}" from "${apiUrl}")`,
    )
  }

  // Callers concatenate a leading-slash path onto this, so a trailing slash
  // would produce a double slash in the request path.
  return apiUrl.replace(/\/+$/, '')
}
