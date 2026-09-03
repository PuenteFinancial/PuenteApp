export const SIGNUP_PHONE_KEY = 'puente_signup_phone'

// Digits only, US country code prepended when a bare 10-digit number is
// entered — matches the format Supabase phone auth is configured with.
//
// KNOWN GAP, tracked separately: a Mexican mobile is also ten digits, so a user
// entering theirs gets `1` prepended and silently becomes a US number — often a
// real one (5512345678 -> 15512345678, a valid New Jersey line). The API's NANP
// allowlist cannot catch this, because the result is well-formed. The fix is to
// make the `+1` visible in the input so the contract is explicit; until then,
// do not mistake the allowlist for protection against it.
export function normalizePhone(input: string): string {
  const digits = input.replace(/\D/g, '')
  return digits.length === 10 ? `1${digits}` : digits
}

/**
 * How long the client makes a user wait before offering Resend.
 *
 * Shared because the server enforces the same window: `OTP_COOLDOWN_SECONDS`
 * (apps/api/src/config/env.ts) defaults to this value. If the client waits less
 * than the server enforces, the Resend button is a button that returns 429 —
 * a self-inflicted failure on the happy path. One constant, two consumers, so
 * they cannot drift.
 */
export const OTP_RESEND_COOLDOWN_SECONDS = 60

/**
 * A stored login phone as E.164, NANP only. `null` means "not a number this
 * product signs in" — callers must not pass that on to a provider.
 *
 * Why this exists: `users.phone` is NOT reliably E.164. GoTrue stores the
 * login phone without its `+` and the signup trigger copies it verbatim, so
 * most rows read `1XXXXXXXXXX` (staging 2026-09-03: 4 of 5), while a few
 * fixtures were inserted with the `+`. Stripe's consumer sign-up 400s on the
 * bare form ("There was an issue parsing the phone number"). The API applies
 * this at its boundary so `GET /v1/users/me` keeps the E.164 contract it
 * claims; the web pay step applies it again before the Link SDK call as
 * belt-and-braces. The column itself stays in GoTrue's shape on purpose —
 * `auth.users.phone` will always be bare digits, and two tables holding the
 * same identity in two formats is a corner nobody needs.
 */
export function toE164Nanp(raw: string): string | null {
  const digits = raw.replace(/\D/g, '')
  if (digits.length === 10) return `+1${digits}`
  if (digits.length === 11 && digits.startsWith('1')) return `+${digits}`
  return null
}
