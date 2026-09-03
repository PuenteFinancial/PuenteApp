import { createHmac, hkdfSync } from 'node:crypto'

import { env } from '../config/env.js'
import { supabaseAdmin } from './supabase.js'

// Per-phone admission control for OTP sends. POST /v1/auth/otp/send is public,
// unauthenticated, and spends real money on every call; the global 100 req/min
// per-IP limiter in server.ts does nothing against one user tapping Resend, and
// little against a distributed caller.
//
// The threat that actually pays is SMS pumping: drive sends to high
// termination-fee ranges and take a cut of the carrier fee. The NANP allowlist
// on the route removes the profit motive; this bounds how fast anyone can burn
// the balance regardless.

/**
 * The pepper for the bucket key.
 *
 * HKDF-derived from DETAILS_ENCRYPTION_KEY with its own `info` label rather than
 * using that key directly, and rather than adding a fourth secret to provision
 * across Doppler → Railway/Vercel/Actions/EAS. Domain separation via distinct
 * info strings is exactly what HKDF is for: this output is independent of the
 * AES key even though both descend from the same input.
 *
 * Rotating DETAILS_ENCRYPTION_KEY resets every bucket. Harmless — the widest
 * window is a day, so the worst case is one day of forgiven attempts.
 */
const PHONE_HASH_PEPPER = Buffer.from(
  hkdfSync('sha256', env.DETAILS_ENCRYPTION_KEY, Buffer.alloc(0), 'otp-phone-hash-v1', 32),
)

/**
 * Bucket key for a phone number. Peppered HMAC, hex.
 *
 * NOT a bare digest. NANP numbers are a ~10^10 space, so an unkeyed SHA-256 of
 * one is brute-forced back to the number in seconds — which would make the
 * stored column PII in everything but name. The pepper is what makes this
 * one-way in practice and not just in principle.
 *
 * Deliberately not the `phoneKey` helper in routes/v1/waitlist.ts: that is a
 * truncated bare digest for correlating log lines, a different job under a
 * different threat model. Two constructions, on purpose.
 */
export function phoneBucketKey(phone: string): string {
  return createHmac('sha256', PHONE_HASH_PEPPER).update(phone, 'utf8').digest('hex')
}

export interface OtpAdmission {
  allowed: boolean
  /** Seconds until a retry could succeed. Only meaningful when denied. */
  retryAfterSeconds: number
}

interface AdmitRow {
  allowed: boolean
  retry_after_seconds: number
}

// Retry-After hint when the VERIFY limiter itself fails. Not the window: a
// database blip should not tell a legitimate user to wait fifteen minutes.
const VERIFY_FAIL_CLOSED_RETRY_SECONDS = 60

/**
 * One atomic check-and-record call. The check and the insert happen in one
 * statement inside the database because check-then-insert is a
 * time-of-check/time-of-use race: two concurrent requests for the same number
 * would both read "under the limit" and both be admitted.
 *
 * FAILS CLOSED. An error refuses the attempt. This is the opposite of the usual
 * advice for a login path — where failing open avoids locking everyone out
 * during an outage — and deliberately so: on the send leg the downside is a
 * bill, on the verify leg it is an unbounded guess rate, and a limiter that
 * opens under load is no limiter at all.
 */
async function admit(
  fn: 'otp_attempt_admit' | 'otp_verify_admit',
  params: Record<string, string | number>,
  failClosedRetrySeconds: number,
): Promise<OtpAdmission> {
  const { data, error } = await supabaseAdmin.rpc(fn, params)

  // `returns table` comes back as an array of rows; anything else means the
  // function did not run as expected and there is no verdict to trust.
  const row = (Array.isArray(data) ? data[0] : data) as AdmitRow | undefined

  if (error || !row || typeof row.allowed !== 'boolean') {
    return { allowed: false, retryAfterSeconds: failClosedRetrySeconds }
  }

  return {
    allowed: row.allowed,
    retryAfterSeconds: row.retry_after_seconds,
  }
}

/**
 * May this number be sent an OTP right now, and record it if so. The burst a
 * cooldown exists to prevent is exactly what the atomic admit rules out.
 */
export async function admitOtpSend(phone: string): Promise<OtpAdmission> {
  return admit(
    'otp_attempt_admit',
    {
      p_phone_hash: phoneBucketKey(phone),
      p_cooldown_seconds: env.OTP_COOLDOWN_SECONDS,
      p_max_hour: env.OTP_MAX_PER_HOUR,
      p_max_day: env.OTP_MAX_PER_DAY,
    },
    env.OTP_COOLDOWN_SECONDS,
  )
}

/**
 * May this number have a code checked right now, and record it if so.
 *
 * The brute-force bound on a six-digit code (K7a). Counted on ADMISSION,
 * before GoTrue is asked — counting only failures would leave the
 * check-then-verify gap open to a burst of parallel guesses, which is the whole
 * attack. No cooldown: a user types the code straight after it arrives. What
 * bounds a brute force is guesses per code (the window) and guesses across
 * re-sends (the day).
 */
export async function admitOtpVerify(phone: string): Promise<OtpAdmission> {
  return admit(
    'otp_verify_admit',
    {
      p_phone_hash: phoneBucketKey(phone),
      p_window_seconds: env.OTP_VERIFY_WINDOW_SECONDS,
      p_max_window: env.OTP_VERIFY_MAX_PER_WINDOW,
      p_max_day: env.OTP_VERIFY_MAX_PER_DAY,
    },
    VERIFY_FAIL_CLOSED_RETRY_SECONDS,
  )
}
