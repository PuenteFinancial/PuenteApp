import type { Translations } from './translations'

// The API returns a uniform error envelope — { error: { code, message,
// requestId, details? } } — on every route since the error-envelope PR
// (api-contract). Clients branch on the stable `code`, never on the human
// `message`, and never surface the raw API message to users. This module maps a
// `code` onto a localized string from the `send.errors` namespace, once, for
// reuse across the whole send flow.

export interface ApiErrorEnvelope {
  code: string
  message?: string
  requestId?: string
}

// The keys we can map a code onto (all of `send.errors`).
type SendErrors = Translations['send']['errors']

// Best-effort parse of an arbitrary JSON body into the error envelope, or null
// when the body isn't shaped like one (network error page, empty body, etc.).
export function parseApiError(body: unknown): ApiErrorEnvelope | null {
  if (typeof body !== 'object' || body === null) return null
  const err = (body as { error?: unknown }).error
  if (typeof err !== 'object' || err === null) return null
  const code = (err as { code?: unknown }).code
  if (typeof code !== 'string') return null
  const message = (err as { message?: unknown }).message
  const requestId = (err as { requestId?: unknown }).requestId
  return {
    code,
    ...(typeof message === 'string' ? { message } : {}),
    ...(typeof requestId === 'string' ? { requestId } : {}),
  }
}

// Resolve an API error `code` to a localized, user-facing message. Unknown or
// missing codes fall back to `generic`. hasOwnProperty (not `in`) so a code like
// "toString" or "constructor" can't resolve to an inherited Object property.
export function errorMessage(code: string | null | undefined, errors: SendErrors): string {
  if (code && Object.prototype.hasOwnProperty.call(errors, code)) {
    const msg = errors[code as keyof SendErrors]
    if (typeof msg === 'string') return msg
  }
  return errors.generic
}

// The 202 response from POST /transfers/:id/cancel is NOT an error envelope: it
// carries its own localized copy at the top level — { code:
// 'cancellation_requires_support', messages: { en, es } }. Prefer that copy
// (server-authored, Reg E) over any mapped message; returns null if the body
// isn't that shape.
export function parseCancellationRequiresSupport(
  body: unknown,
): { en: string; es: string } | null {
  if (typeof body !== 'object' || body === null) return null
  const b = body as { code?: unknown; messages?: unknown }
  if (b.code !== 'cancellation_requires_support') return null
  const m = b.messages
  if (typeof m !== 'object' || m === null) return null
  const en = (m as { en?: unknown }).en
  const es = (m as { es?: unknown }).es
  if (typeof en !== 'string' || typeof es !== 'string') return null
  return { en, es }
}
