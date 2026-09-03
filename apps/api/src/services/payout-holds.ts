import * as Sentry from '@sentry/node'
import { supabaseAdmin } from './supabase.js'
import { enqueuePayoutSubmit } from './queue.js'

// K6 decision 8: the 'sender_kyc_pending' hold is the system's first
// AUTO-RELEASED hold. payout-submit parks a FUNDED row on it when the
// sender's Bridge customer is not yet approved; the Bridge approval webhook
// calls this to clear every such hold for the sender and re-enqueue the
// submit. The 1-min payout.sweep would resubmit anyway (it selects FUNDED +
// unheld + unclaimed), so the enqueue is latency only — its failure is
// logged, never fatal.

interface Logger {
  info(obj: Record<string, unknown>, msg: string): void
  warn(obj: Record<string, unknown>, msg: string): void
  error(obj: Record<string, unknown>, msg: string): void
}

export async function releaseSenderKycHolds(userId: string, log: Logger): Promise<string[]> {
  const { data, error } = await supabaseAdmin
    .from('transfers')
    .update({ payout_hold_reason: null, payout_held_at: null })
    .eq('user_id', userId)
    .eq('state', 'FUNDED')
    .eq('payout_hold_reason', 'sender_kyc_pending')
    .select('id')

  if (error) {
    // The hold stays until the next approval event or a manual release; that
    // is money waiting on nobody, so page it rather than only log it.
    log.error({ userId, supabaseError: error.code }, 'sender_kyc_pending release failed')
    Sentry.withScope((scope) => {
      scope.setFingerprint(['sender-kyc-release-failed', userId])
      scope.setContext('release', { userId, supabaseError: error.code })
      Sentry.captureMessage('sender_kyc_pending release failed', 'error')
    })
    return []
  }

  const released = ((data ?? []) as Array<{ id: string }>).map((row) => row.id)
  for (const transferId of released) {
    log.info({ audit: true, userId, transferId }, 'sender_kyc_pending hold auto-released')
    try {
      await enqueuePayoutSubmit(transferId, 'api')
    } catch {
      log.warn({ userId, transferId }, 'payout enqueue after release failed — sweep will heal')
    }
  }
  return released
}
