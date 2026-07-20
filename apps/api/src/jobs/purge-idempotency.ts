import { supabaseAdmin } from '../services/supabase.js'

// Cron sweep (`idempotency.purge`): drop expired client-request idempotency
// keys. Strictly-less-than now — a key expiring this instant is still
// honorable. Uses idempotency_keys_expires_at_idx. Returns the deleted count.
export async function purgeExpiredIdempotencyKeys(): Promise<number> {
  const nowIso = new Date().toISOString()
  const { count, error } = await supabaseAdmin
    .from('idempotency_keys')
    .delete({ count: 'exact' })
    .lt('expires_at', nowIso)
  if (error) throw new Error(`idempotency purge failed: ${error.message}`)
  return count ?? 0
}
