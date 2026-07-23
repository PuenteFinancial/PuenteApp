import type { NextRequest } from 'next/server'

// Forward the browser-minted Idempotency-Key verbatim to the API. The proxy must
// NEVER mint its own key: a proxy-generated key would be regenerated on every
// browser retry (network failure, double-click), so each retry would reach the
// API as a distinct request and become a DUPLICATE transfer. The contract is
// browser mints once → proxy passes through → API dedupes on (user, endpoint,
// key). Returns a headers object to spread into apiFetch's init.headers; empty
// when the header is absent, so the API returns its own 400 validation_error for
// the missing key rather than the proxy inventing one.
export function forwardIdempotencyKey(req: NextRequest): Record<string, string> {
  const key = req.headers.get('idempotency-key')
  return key ? { 'idempotency-key': key } : {}
}
