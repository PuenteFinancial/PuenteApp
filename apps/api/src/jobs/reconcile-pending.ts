import { env } from '../config/env.js'
import { supabaseAdmin } from '../services/supabase.js'
import { transitionTransfer, TransferRpcError } from '../services/transfers.js'

// A PENDING_PAYMENT older than this never got its funding webhook — the
// processor either failed silently or the user abandoned checkout.
const STALE_AFTER_MS = 30 * 60 * 1000

// Under the manual processor the 30-minute rule is wrong by design: an
// out-of-band sender holds deposit instructions and wires money on their own
// schedule, so "no funding yet" is the NORMAL state for hours-to-days. The
// sweep killed exactly such a transfer on the 2026-08-18 staging dry run.
// Days-scale window instead (MANUAL_PENDING_MAX_AGE_DAYS, default 7).
//
// The onramp rail (#213) sits between the two: the widget walks a first-time
// sender through Link OTP + identity + SSN, so 30 minutes would race a slow
// KYC pass — and a sweep-then-pay race puts real money against a
// PAYMENT_FAILED row. Hours-scale window (ONRAMP_PENDING_MAX_AGE_HOURS,
// default 4); not days — an abandoned widget has no deposit instructions
// sitting in anyone's bank app. (#227's transfer_aging follows this branch.)
function staleAfterMs(): number {
  if (env.FUNDING_PROCESSOR === 'manual') {
    return env.MANUAL_PENDING_MAX_AGE_DAYS * 24 * 60 * 60 * 1000
  }
  if (env.FUNDING_PROCESSOR === 'stripe_onramp') {
    return env.ONRAMP_PENDING_MAX_AGE_HOURS * 60 * 60 * 1000
  }
  return STALE_AFTER_MS
}

// Codes that mean another actor moved the row between our select and the
// RPC — the row is already handled, not an error.
const BENIGN_CODES = new Set(['transition_conflict', 'transfer_not_found'])

// Cron sweep (`transfer.reconcile-pending`): stale PENDING_PAYMENT →
// PAYMENT_FAILED. No ledger entries on purpose — a stuck PENDING_PAYMENT has
// zero postings (the FUNDED batch never ran), so this is a dead row, not
// lost money. Returns the count actually transitioned.
export async function reconcilePendingTransfers(): Promise<number> {
  const cutoff = new Date(Date.now() - staleAfterMs()).toISOString()
  const { data, error } = await supabaseAdmin
    .from('transfers')
    .select('id')
    .eq('state', 'PENDING_PAYMENT')
    .lt('created_at', cutoff)
  if (error) throw new Error(`reconcile-pending select failed: ${error.message}`)

  const rows = (data ?? []) as { id: string }[]
  let transitioned = 0
  const failures: string[] = []
  for (const row of rows) {
    try {
      await transitionTransfer({
        transferId: row.id,
        fromState: 'PENDING_PAYMENT',
        toState: 'PAYMENT_FAILED',
        actor: 'worker:reconcile-pending',
        reason:
          env.FUNDING_PROCESSOR === 'manual'
            ? `funding_not_received_within_${env.MANUAL_PENDING_MAX_AGE_DAYS}_days`
            : env.FUNDING_PROCESSOR === 'stripe_onramp'
              ? `funding_not_received_within_${env.ONRAMP_PENDING_MAX_AGE_HOURS}_hours`
              : 'funding_not_received_within_30_minutes',
      })
      transitioned++
    } catch (err) {
      if (err instanceof TransferRpcError && BENIGN_CODES.has(err.code)) continue
      failures.push(err instanceof Error ? err.message : String(err))
    }
  }

  // Throw only after every row got its attempt: pg-boss retries the batch,
  // and already-transitioned rows are no-ops on replay.
  if (failures.length > 0) {
    throw new Error(
      `reconcile-pending: ${failures.length}/${rows.length} transitions failed (first: ${failures[0]})`,
    )
  }
  return transitioned
}
