import { env } from '../config/env.js'
import { supabaseAdmin } from '../services/supabase.js'
import {
  getFundingProcessor,
  isOnrampSessionRail,
  pendingFundingWindowMs,
  processorNameFor,
  type RailRow,
} from '../services/funding/index.js'
import { transitionTransfer, TransferRpcError } from '../services/transfers.js'

// A PENDING_PAYMENT older than its rail's window never got its funding — the
// processor failed silently or the sender abandoned checkout. The per-rail
// windows and WHY each one differs live in services/funding/index.ts
// (`pendingFundingWindowMs`), shared with reconciliation's
// `pending-payment-autofail-dead` alert so the two clocks cannot drift —
// which is exactly what #242 was.
const staleAfterMs = pendingFundingWindowMs

function abandonmentReason(row: RailRow): string {
  const rail = processorNameFor(row)
  if (rail === 'manual') return `funding_not_received_within_${env.MANUAL_PENDING_MAX_AGE_DAYS}_days`
  if (isOnrampSessionRail(rail)) return `funding_not_received_within_${env.ONRAMP_PENDING_MAX_AGE_HOURS}_hours`
  return 'funding_not_received_within_30_minutes'
}

// Codes that mean another actor moved the row between our select and the
// RPC — the row is already handled, not an error.
const BENIGN_CODES = new Set(['transition_conflict', 'transfer_not_found'])

// ── Onramp rejected-session poll (#213, added after the 2026-08-26 KYC
// drill) ────────────────────────────────────────────────────────────────────
// Stripe emits NO webhook when an onramp session is rejected at verify
// (contradicting their docs; confirmed against the account event stream), so
// rejected transfers would otherwise sit PENDING_PAYMENT for the full
// abandonment window with the sender staring at "waiting for payment". Each
// sweep tick (*/5) polls every pending cos_ session and fails rejected ones
// NOW, with the session's own reason. Fail-safe by construction: the only
// transition this can drive is PENDING_PAYMENT → PAYMENT_FAILED (no money
// legs), and a poll error just leaves the row to the age window — the poll is
// an accelerator, never a gate.
//
// Ref-prefix gate: only `cos_` rows. Under a global env flip, pre-flip rows
// with manualpay_/pi_/mockpay_ refs can still be pending, and asking Stripe's
// onramp API about them is a guaranteed 404. The prefix is the durable rail
// encoding (undoModeForRef precedent).
async function failRejectedOnrampSessions(
  rows: { id: string; funding_payment_ref: string | null }[],
): Promise<Set<string>> {
  const failed = new Set<string>()
  const processor = getFundingProcessor()
  if (!isOnrampSessionRail(processor.provider) || !processor.getPaymentStatus) return failed

  for (const row of rows) {
    if (!row.funding_payment_ref?.startsWith('cos_')) continue
    let status
    try {
      status = await processor.getPaymentStatus({ paymentRef: row.funding_payment_ref })
    } catch {
      continue // transient poll failure — the age window still backstops
    }
    if (status.status !== 'rejected') continue
    try {
      await transitionTransfer({
        transferId: row.id,
        fromState: 'PENDING_PAYMENT',
        toState: 'PAYMENT_FAILED',
        actor: 'worker:reconcile-pending',
        reason: status.lastError ?? 'onramp_session_rejected',
      })
      failed.add(row.id)
    } catch (err) {
      if (err instanceof TransferRpcError && BENIGN_CODES.has(err.code)) continue
      throw err
    }
  }
  return failed
}

// Cron sweep (`transfer.reconcile-pending`): stale PENDING_PAYMENT →
// PAYMENT_FAILED. No ledger entries on purpose — a stuck PENDING_PAYMENT has
// zero postings (the FUNDED batch never ran), so this is a dead row, not
// lost money. Returns the count actually transitioned.
//
// Under the onramp processor the sweep ALSO polls every pending session (all
// ages, not just stale — see failRejectedOnrampSessions above) so a KYC
// rejection fails in ≤ one tick instead of the full window.
export async function reconcilePendingTransfers(): Promise<number> {
  const { data: pendingData, error: pendingError } = await supabaseAdmin
    .from('transfers')
    .select('id, funding_payment_ref, funding_processor, created_at')
    .eq('state', 'PENDING_PAYMENT')
  if (pendingError) {
    throw new Error(`reconcile-pending select failed: ${pendingError.message}`)
  }
  const pending = (pendingData ?? []) as {
    id: string
    funding_payment_ref: string | null
    funding_processor?: string | null
    created_at: string
  }[]

  const rejectedNow = await failRejectedOnrampSessions(pending)

  const now = Date.now()
  const rows = pending.filter(
    (row) =>
      !rejectedNow.has(row.id) && new Date(row.created_at).getTime() < now - staleAfterMs(row),
  )
  let transitioned = 0
  const failures: string[] = []
  for (const row of rows) {
    try {
      await transitionTransfer({
        transferId: row.id,
        fromState: 'PENDING_PAYMENT',
        toState: 'PAYMENT_FAILED',
        actor: 'worker:reconcile-pending',
        reason: abandonmentReason(row),
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
  return transitioned + rejectedNow.size
}
