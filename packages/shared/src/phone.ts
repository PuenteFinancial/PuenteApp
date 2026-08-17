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
