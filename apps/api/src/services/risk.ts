import { env } from '../config/env.js'
import { supabaseAdmin } from './supabase.js'

// Per-user transaction limits (slice-7 PR5) — the AML "Transaction Limits at
// Launch" policy: a per-transaction send cap plus rolling-window send-amount caps
// (day / month / 6 months), with a belt-and-suspenders per-day send count. The
// per-user counterpart to the aggregate float ceiling (payouts.ts).
//
// The risk: ACH has no balance check at initiation, so a user can commit more
// than their bank can cover; the first clears and the rest bounce R01 after the
// MXN is delivered. All amounts are the SEND principal in USD minor units — fees
// are excluded, because the policy caps the amount *transmitted*, not the total
// charged (so a max $1,500 send sits exactly at the $1,500/day cap).

export type RiskReason = 'per_transaction' | 'daily' | 'monthly' | 'semiannual' | 'velocity_count'

// Discriminated union (mirrors PayabilityResult in payouts.ts): a blocked verdict
// always carries a reason, an ok one never does — the illegal states are
// unrepresentable, so callers narrow `reason` from `!ok` with no fallback.
export type RiskVerdict = { ok: true } | { ok: false; reason: RiskReason }

// A *committed* send counts toward the budget once the sender accepts the terms
// (disclosure_accepted_at set) — not once the dollars land, because ACH clears
// days later and counting only funded sends would let a rapid burst slip the
// check (each new send would see "nothing funded yet"). These states mean the
// send was unwound — money returned or never charged — so it drops back out of
// the budget: counting a canceled mistake would lock an honest re-send out.
// NB: PAYOUT_FAILED and UNDER_REVIEW are deliberately NOT here — there the sender
// WAS charged and the money has not yet been returned (a refund posts only at
// REFUNDED), so the exposure is still live and the send keeps counting.
const UNWOUND_STATES = '(PAYMENT_FAILED,CANCELED,REFUNDED,FUNDING_REVERSED)'

// Rolling windows for the tiered caps. Fixed by the policy's structure (only the
// dollar/count ceilings are env-tunable); "month"/"6 months" are rolling 30/180
// days, not calendar periods — stricter and boundary-game-proof.
const HOUR_MS = 60 * 60 * 1000
const DAY_MS = 24 * HOUR_MS
const MONTH_MS = 30 * DAY_MS
const SEMIANNUAL_MS = 180 * DAY_MS

interface CommittedSendRow {
  disclosure_accepted_at: string
  send_amount_minor: number
}

/**
 * Per-user transaction-limit check. Blocks a new send that would breach the
 * per-transaction cap, any rolling-window send-amount cap (day / month / 6
 * months), or the per-day send count. `sendAmountMinor` is the prospective send
 * principal; `excludeTransferId` omits the row under consideration so a send never
 * counts itself — at confirm the send being accepted, at the FUNDED→SUBMITTED
 * backstop the transfer being submitted.
 *
 * Fail-closed: a query error (or null-without-error) throws (confirm → 500, worker
 * → pg-boss retry), so a broken read never silently lets money move. All
 * arithmetic is integer minor units, USD send-leg (USD→MXN corridor).
 */
export async function assessTransferRisk(input: {
  userId: string
  sendAmountMinor: number
  excludeTransferId?: string
}): Promise<RiskVerdict> {
  // Per-transaction cap — a property of this send alone, so it needs no history
  // and short-circuits before the query.
  if (input.sendAmountMinor > env.RISK_PER_TXN_MAX_MINOR) {
    return { ok: false, reason: 'per_transaction' }
  }

  const now = Date.now()
  const cutoff = new Date(now - SEMIANNUAL_MS).toISOString() // widest window bounds the read

  let query = supabaseAdmin
    .from('transfers')
    .select('disclosure_accepted_at, send_amount_minor')
    .eq('user_id', input.userId)
    .not('disclosure_accepted_at', 'is', null)
    .gte('disclosure_accepted_at', cutoff)
    .not('state', 'in', UNWOUND_STATES)
  if (input.excludeTransferId) {
    query = query.neq('id', input.excludeTransferId)
  }

  const { data, error } = await query
  // Strictly fail-closed: a null data with no error (a shape anomaly) must NOT be
  // read as "no prior sends" — that would drop the sender's history and pass the
  // amount caps on the new send alone.
  if (error || data == null) {
    throw new Error(`risk limit query failed: ${error?.message ?? 'no rows returned'}`)
  }
  const rows = data as CommittedSendRow[]

  // One pass over the committed sends in the widest window; tally the count + send
  // total inside each narrower window by commit timestamp.
  const dayFloor = now - DAY_MS
  const monthFloor = now - MONTH_MS
  let dayCount = 0
  let daySum = 0
  let monthSum = 0
  let semiannualSum = 0
  for (const row of rows) {
    const at = new Date(row.disclosure_accepted_at).getTime()
    semiannualSum += row.send_amount_minor
    if (at >= monthFloor) monthSum += row.send_amount_minor
    if (at >= dayFloor) {
      daySum += row.send_amount_minor
      dayCount += 1
    }
  }

  // Tiered dollar caps, tightest window first, then the per-day count guard.
  // Strict `>`: hitting a cap exactly is allowed.
  if (daySum + input.sendAmountMinor > env.RISK_DAILY_MAX_MINOR) {
    return { ok: false, reason: 'daily' }
  }
  if (monthSum + input.sendAmountMinor > env.RISK_MONTHLY_MAX_MINOR) {
    return { ok: false, reason: 'monthly' }
  }
  if (semiannualSum + input.sendAmountMinor > env.RISK_SEMIANNUAL_MAX_MINOR) {
    return { ok: false, reason: 'semiannual' }
  }
  if (dayCount >= env.RISK_VELOCITY_MAX_COUNT) {
    return { ok: false, reason: 'velocity_count' }
  }

  return { ok: true }
}
