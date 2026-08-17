import { supabaseAdmin } from '../services/supabase.js'

// The widest rate-limit window is a rolling day, so nothing older than that can
// change a verdict. Kept for two days rather than one: the margin means a
// missed run (or a worker outage like 08-02) cannot silently shorten anyone's
// effective daily budget by pruning rows the next check still needed.
const RETENTION_DAYS = 2

// Cron sweep (`otp.attempts.purge`): drop OTP send attempts past the retention
// window. Uses otp_send_attempts_phone_hash_created_at_idx. Returns the deleted
// count.
export async function purgeExpiredOtpAttempts(): Promise<number> {
  const cutoff = new Date(Date.now() - RETENTION_DAYS * 24 * 60 * 60 * 1000).toISOString()
  const { count, error } = await supabaseAdmin
    .from('otp_send_attempts')
    .delete({ count: 'exact' })
    .lt('created_at', cutoff)
  if (error) throw new Error(`otp attempt purge failed: ${error.message}`)
  return count ?? 0
}
