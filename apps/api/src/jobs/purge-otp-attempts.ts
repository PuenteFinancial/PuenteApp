import { supabaseAdmin } from '../services/supabase.js'

// The widest rate-limit window on either OTP leg is a rolling day, so nothing
// older than that can change a verdict. Kept for two days rather than one: the
// margin means a missed run (or a worker outage like 08-02) cannot silently
// shorten anyone's effective daily budget by pruning rows the next check still
// needed.
const RETENTION_DAYS = 2

// Both append-only admission logs share the prune: the send budget (#188) and
// the verify brute-force bound (K7a). Each uses its (phone_hash, created_at)
// index for the range delete.
const OTP_ATTEMPT_TABLES = ['otp_send_attempts', 'otp_verify_attempts'] as const

// Cron sweep (`otp.attempts.purge`): drop OTP attempts past the retention
// window from both logs. Returns the combined deleted count.
export async function purgeExpiredOtpAttempts(): Promise<number> {
  const cutoff = new Date(Date.now() - RETENTION_DAYS * 24 * 60 * 60 * 1000).toISOString()
  let total = 0
  for (const table of OTP_ATTEMPT_TABLES) {
    const { count, error } = await supabaseAdmin
      .from(table)
      .delete({ count: 'exact' })
      .lt('created_at', cutoff)
    if (error) throw new Error(`otp attempt purge failed (${table}): ${error.message}`)
    total += count ?? 0
  }
  return total
}
