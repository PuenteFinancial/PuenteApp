import type { Breadcrumb, ErrorEvent } from '@sentry/node'

// PII scrubber for outbound Sentry events. Lives apart from instrument.ts so
// it can be tested without triggering Sentry.init() as an import side effect,
// and must not import config/env.js (instrument.ts is the preload).
//
// Why this exists: K6 relays the sender's DOB and tax ID through
// POST /v1/users/me/bridge-customer, memory only. The handler never logs
// them, but Sentry's Fastify integration and any captureException with
// `extra`/`contexts` could carry a request body or a value we did not put
// there ourselves. This is the last line: any key that even LOOKS like it
// names an identity number is redacted before the event leaves the process.
// Over-redacting (phone_number, account_number, routing_number) is a feature
// — none of those belong in an error report either.

export const SENSITIVE_KEY = /dob|tax_?id|ssn|itin|number|birth|identifying_information|id_number/i
export const REDACTED = '[redacted]'
const MAX_DEPTH = 8

// Redact by KEY NAME, recursively. Cycle-safe (ancestor set) and depth-bounded
// so a pathological object can neither hang nor blow the stack. Pure: builds
// a new tree, never mutates the input.
export function scrubObject(value: unknown, depth = 0, ancestors = new Set<object>()): unknown {
  if (value === null || typeof value !== 'object') return value
  if (depth > MAX_DEPTH || ancestors.has(value)) return REDACTED
  ancestors.add(value)
  try {
    if (Array.isArray(value)) {
      return value.map((item) => scrubObject(item, depth + 1, ancestors))
    }
    const out: Record<string, unknown> = {}
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      out[key] = SENSITIVE_KEY.test(key) ? REDACTED : scrubObject(item, depth + 1, ancestors)
    }
    return out
  } finally {
    ancestors.delete(value)
  }
}

// request.data is a JSON string when the SDK captured a raw body, or an
// already-parsed object. A string that is not JSON cannot be inspected key by
// key, so it is replaced whole — the only bodies this API accepts are JSON.
function scrubRequestData(data: unknown): unknown {
  if (typeof data !== 'string') return scrubObject(data)
  try {
    return scrubObject(JSON.parse(data))
  } catch {
    return REDACTED
  }
}

function scrubBreadcrumb(crumb: Breadcrumb): Breadcrumb {
  if (!crumb.data) return crumb
  return { ...crumb, data: scrubObject(crumb.data) as NonNullable<Breadcrumb['data']> }
}

export function scrubEvent(event: ErrorEvent): ErrorEvent {
  const out: ErrorEvent = { ...event }
  if (event.extra) out.extra = scrubObject(event.extra) as NonNullable<ErrorEvent['extra']>
  if (event.contexts) out.contexts = scrubObject(event.contexts) as NonNullable<ErrorEvent['contexts']>
  if (event.request && event.request.data !== undefined) {
    out.request = { ...event.request, data: scrubRequestData(event.request.data) }
  }
  if (event.breadcrumbs) out.breadcrumbs = event.breadcrumbs.map(scrubBreadcrumb)
  return out
}
