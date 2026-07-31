import { supabaseAdmin } from './supabase.js'

// The sender's post-submission cancellation ask (slice-7 PR6b).
//
// A cancel tapped at SUBMITTED / IN_FLIGHT — or at FUNDED after the submit job
// claimed the row — cannot be honoured on the spot: the payout is already with
// Bridge. Before this the API answered a bare 202 and wrote NOTHING, so nothing
// recorded that the sender asked, when they asked, or that a statutory clock had
// started. This service is that record.
//
// NOT disputes. §1005.34 cancellation is not §1005.33 error resolution — the two
// have different clocks, remedies, and lawful denials (docs/decisions.md
// 2026-07-28). The obligation here is state-keyed: a TIMELY cancel at
// SUBMITTED/IN_FLIGHT owes a full refund once the payout resolves, whichever way
// it resolves.
//
// Timeliness is RECORDED, not enforced at the door. The 202 fires on state alone
// and never consults cancelable_until, so a cancel on a transfer stalled for days
// gets one too; `within_window` carries the fact, and only a timely request
// creates an automatic obligation.

/** Requests only ever open from a 202 branch, so only these three states. */
export type CancellationRequestState = 'FUNDED' | 'SUBMITTED' | 'IN_FLIGHT'

export type CancellationStatus = 'pending' | 'resolved_refunded' | 'resolved_denied'

export interface CancellationRequest {
  id: string
  transfer_id: string
  user_id: string
  requested_at: string
  requested_state: CancellationRequestState
  within_window: boolean
  status: CancellationStatus
  resolution: string | null
  resolved_at: string | null
  resolved_by: string | null
  created_at: string
  updated_at: string
}

const REQUEST_COLUMNS =
  'id, transfer_id, user_id, requested_at, requested_state, within_window, status, resolution, resolved_at, resolved_by, created_at, updated_at'

/**
 * Record the ask. Inserts the request AND stamps
 * `transfers.cancellation_requested_at` in ONE transaction (the RPC) — the two
 * must not drift, and PostgREST cannot span two tables.
 *
 * Idempotent by construction: a second call while a request is pending returns
 * the existing row. The clock started when the sender FIRST asked, so a double
 * tap, a second tab, or a replay with a fresh idempotency key must never restart
 * it or open a competing deadline.
 *
 * `within_window` is computed inside the RPC from the row being recorded, so
 * timeliness is evaluated atomically with the record rather than read separately
 * by a caller whose view may already be stale.
 */
export async function recordCancellationRequest(input: {
  transferId: string
  userId: string
  state: CancellationRequestState
}): Promise<CancellationRequest> {
  const { data, error } = await supabaseAdmin.rpc('record_cancellation_request', {
    p_transfer_id: input.transferId,
    p_user_id: input.userId,
    p_state: input.state,
  })
  if (error) throw new Error(`record_cancellation_request failed: ${error.message}`)
  const row = (Array.isArray(data) ? data[0] : data) as CancellationRequest | undefined
  // Fail closed: the caller decides whether to swallow (the route does, loudly,
  // so a bookkeeping fault never turns the sender's statutory ask into a 500).
  // It must not be handed a silent undefined and treat it as recorded.
  if (!row) throw new Error('record_cancellation_request failed: no row returned')
  return row
}

/** The open ask on a transfer, if any. Null means nothing is pending. */
export async function pendingCancellationFor(
  transferId: string,
): Promise<CancellationRequest | null> {
  const { data, error } = await supabaseAdmin
    .from('cancellation_requests')
    .select(REQUEST_COLUMNS)
    .eq('transfer_id', transferId)
    .eq('status', 'pending')
    .maybeSingle()
  if (error) throw new Error(`pending cancellation query failed: ${error.message}`)
  return (data as CancellationRequest | null) ?? null
}

/**
 * Close the ask. Guarded on `status = 'pending'` so a resolution can never
 * overwrite an earlier one — whichever path gets there first owns the outcome,
 * and a replay writes nothing.
 *
 * Returns whether THIS call resolved it. False means it was already closed (or
 * never open); callers must not report a resolution they did not make.
 */
export async function resolveCancellationRequest(input: {
  transferId: string
  status: Exclude<CancellationStatus, 'pending'>
  resolution: string
  resolvedBy: string
}): Promise<boolean> {
  const { data, error } = await supabaseAdmin
    .from('cancellation_requests')
    .update({
      status: input.status,
      resolution: input.resolution,
      resolved_by: input.resolvedBy,
      resolved_at: new Date().toISOString(),
    })
    .eq('transfer_id', input.transferId)
    .eq('status', 'pending')
    .select('id')
  if (error) throw new Error(`resolve cancellation failed: ${error.message}`)
  return (data ?? []).length === 1
}
