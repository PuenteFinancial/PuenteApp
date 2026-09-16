import crypto from 'node:crypto'
import { env } from '../config/env.js'

// WHERE THE REQUEST REALLY CAME FROM, and why it needs authenticating.
//
// Browser traffic reaches this API through the Next.js app on Vercel, over the
// public internet — `INTERNAL_API_URL` is an ordinary https host, not a private
// network. So `request.ip` is VERCEL's egress address for every web user, and
// the sender's real address rides in `x-client-ip`, which the proxy sets.
//
// That address is EVIDENCE. It is written to `consents.ip` (E-SIGN), to the
// NACHA WEB-debit authorization record, and to `sign_in_events` for risk. Until
// now any caller could set the header, because the API is reachable directly —
// MEASURED 2026-09-16, `GET /v1/health` on the Railway host answers a stranger
// with 200 — and nothing distinguished the proxy from anyone else. A forged
// value landed in a consent record and looked exactly like a real one.
//
// WHAT WAS MEASURED, because the obvious fix was the wrong one. The audit
// proposed reading the RIGHTMOST `x-forwarded-for` entry instead of the
// leftmost, on the theory that a browser can prepend its own. Against a real
// preview deployment it cannot: Vercel OVERWRITES `x-forwarded-for`,
// `x-real-ip` and `x-vercel-forwarded-for` with the true socket address, and
// the chain it delivers has exactly one entry. Forged values for all three came
// back as the client's own IP. So the browser → Vercel hop was never the hole
// and the header-parsing change would have been a no-op; the hole is the
// Vercel → API hop, and a shared secret is the whole of the fix.
//
// FAILS CLOSED. No secret configured, or a wrong one, and the header is ignored
// entirely — we fall back to `request.ip`, which is at worst Vercel's address:
// a less precise record, never a false one. Recording an attacker's chosen
// address as the sender's is the outcome that must not happen, and an evidence
// column has no way to say "this is probably wrong".

/** The header the Next.js proxy presents to prove it is the Next.js proxy. */
export const PROXY_TRUST_HEADER = 'x-proxy-trust'

type HeaderBag = Record<string, string | string[] | undefined>

const header = (headers: HeaderBag, name: string): string | null => {
  const value = headers[name]
  return typeof value === 'string' && value.length > 0 ? value : null
}

/**
 * Constant-time, and length-checked first because `timingSafeEqual` throws on a
 * length mismatch rather than returning false (the mock webhook verifier's
 * precedent). Comparing lengths leaks only the length, which an attacker who
 * can read this file already knows.
 */
function presentedSecretIsValid(headers: HeaderBag): boolean {
  const expected = env.PROXY_TRUST_SECRET
  if (!expected) return false
  const presented = header(headers, PROXY_TRUST_HEADER)
  if (presented === null) return false
  const a = Buffer.from(presented)
  const b = Buffer.from(expected)
  return a.length === b.length && crypto.timingSafeEqual(a, b)
}

/**
 * True when this request came from our own web app. Exported for the one thing
 * that needs to reason about it directly — the boot check below — and for
 * tests; routes should call `clientIp` / `clientUserAgent` instead.
 */
export const isTrustedProxy = (headers: HeaderBag): boolean => presentedSecretIsValid(headers)

/**
 * The sender's address for evidence: the proxy-forwarded one when the proxy
 * proved itself, otherwise the socket address. Never null for a real request —
 * `request.ip` always has a value — but typed nullable because the callers
 * store a nullable column and normalise `''` to null.
 */
export function clientIp(request: { headers: HeaderBag; ip: string }): string | null {
  if (isTrustedProxy(request.headers)) {
    const forwarded = header(request.headers, 'x-client-ip')
    if (forwarded !== null) return forwarded
  }
  return request.ip || null
}

/**
 * The sender's user agent, same rule. The UNTRUSTED fallback is this request's
 * own `user-agent`, which for a proxied call is the proxy's — accurate about
 * who connected, which is the same honesty `clientIp` keeps.
 */
export function clientUserAgent(request: { headers: HeaderBag }): string | null {
  if (isTrustedProxy(request.headers)) {
    const forwarded = header(request.headers, 'x-client-ua')
    if (forwarded !== null) return forwarded
  }
  return header(request.headers, 'user-agent')
}
