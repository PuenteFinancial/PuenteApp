import { supabaseAdmin } from './supabase.js'
import {
  transitionTransfer,
  bridgeReturnLedgerEntries,
  refundedLedgerEntries,
  type LedgerEntryJson,
} from './transfers.js'
import { postLedgerTransaction, type LedgerEntryInput } from './ledger.js'
import { getFundingProcessor } from './funding/index.js'
import { getBridgeTransfer } from './bridge.js'

// The PAYOUT_FAILED → REFUNDED refund-from-float tail (ledger-rules.md), lifted
// out of the payment-event job in slice-7 PR6a so the automated path (job, gated
// by AUTO_REFUND) and the operator path (scripts/trigger-refund.ts, run by a
// human when the flag is off) execute the SAME ledger + disbursement tail and
// cannot diverge. The two paths are not equally guarded, though: the operator
// path additionally runs the principal-returned interlock below, while the job
// trusts mapBridgeState's `principalReturned` on the event that triggered it.
//
// The policy gate lives at the CALL SITE, never here: this service has no
// `force` parameter and no flag read, so which callers may move money stays
// visible per caller. The job checks AUTO_REFUND; the operator IS the gate.
//
// Replay-safe: the two ledger batches are keyed (bridge_return / REFUNDED) and
// refund() is refund_payment_ref-null-gated, so a webhook+poll duplicate, a
// crash-replay, or a second operator run posts and disburses once. Exactly-once
// on the disbursement rests on the PROCESSOR's idempotency key
// (`{idempotency_key}:refund`) — the null-gate is a read separated from its
// write, so it is the second line, not a lock, and concurrent runs against one
// transfer are not a supported situation (docs/runbooks/manual-refund.md).
//
// Any NON-BENIGN throw propagates — the job leaves its event 'received' for
// retry, the CLI exits non-zero. A TransferRpcError of transition_conflict /
// transfer_not_found is treated as benign by the job (it marks the event
// processed), because another actor already advanced the row.

interface RefundableTransfer {
  id: string
  state: string
  send_amount_minor: number
  fee_amount_minor: number
  refund_payment_ref: string | null
  funding_payment_ref: string | null
  idempotency_key: string
}

const REFUNDABLE_COLUMNS =
  'id, state, send_amount_minor, fee_amount_minor, refund_payment_ref, ' +
  'funding_payment_ref, idempotency_key'

// Terminal Bridge states that mean the principal is back with us — the same two
// that carry `principalReturned` in mapBridgeState (payment-events.ts).
// `refund_in_flight` is still in progress and `refund_failed` means the
// principal is stuck AT Bridge; neither confirms anything.
const PRINCIPAL_RETURNED_STATES = ['returned', 'refunded'] as const

// Transfer ids arrive from an operator's command line and are interpolated into
// a PostgREST `or` FILTER STRING (findReturnEvent), which takes no bound
// parameters — so the shape is checked before it can reach one.
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

// `done` means the transfer is at REFUNDED. The three done-outcomes are kept
// distinct because a caller that reports "refunded by you" must not say so for
// a run that wrote nothing:
//   refunded          — this run disbursed and settled
//   already_disbursed — the disbursement pre-existed (crash between the persist
//                       and the transition); this run posted the REFUNDED batch
//                       and settled the state (bridge_return necessarily
//                       pre-existed too, so that post is a keyed no-op)
//   already_settled   — already REFUNDED; this run wrote NOTHING at all
//
// A refusal carries the state it observed, because whether a refusal is alarming
// depends entirely on it: at COMPLETED the transfer delivered and the sender is
// owed nothing, at SUBMITTED something is genuinely wrong.
export type RefundOutcome =
  | { done: true; outcome: 'refunded' | 'already_disbursed' | 'already_settled' }
  | { done: false; reason: 'not_payout_failed'; state: string }
  | { done: false; reason: 'transfer_not_found' }

export type PrincipalVerdict =
  | { returned: true; bridgeState: string; eventType: string }
  | {
      returned: false
      reason: 'transfer_not_found' | 'not_submitted' | 'no_return_event' | 'bridge_disagrees'
      bridgeState?: string
      eventType?: string
    }

const toLedgerInput = (entries: LedgerEntryJson[]): LedgerEntryInput[] =>
  entries.map((e) => ({
    accountCode: e.account_code,
    direction: e.direction,
    money: { amountMinor: e.amount_minor, currency: e.currency },
  }))

/**
 * Drive a transfer parked at `PAYOUT_FAILED` all the way to `REFUNDED`: book the
 * returned principal back to cash, return the collected funds to the sender, and
 * settle the state with the refund ledger batch.
 *
 * Reads live state itself rather than trusting a caller-supplied row — this is a
 * money-moving entry point reachable from an operator CLI, so the amounts and the
 * never-refund-a-delivered-transfer guard must come from the database, not the
 * caller. Returns a structured verdict; the script prints it, the job ignores it.
 *
 * `actor` is written to `transfer_transitions` and is the ONLY durable record of
 * who triggered a manual refund (jobs and scripts write no audit-plugin rows).
 */
export async function refundPayoutFailure(input: {
  transferId: string
  actor: string
  reason: string
}): Promise<RefundOutcome> {
  const transfer = await loadRefundable(input.transferId)
  if (!transfer) return { done: false, reason: 'transfer_not_found' }

  // Already settled — a duplicate event, a retried job, or an operator running
  // the command twice. Report success WITHOUT writing: the batches and the
  // disbursement are keyed, so re-posting would be a no-op anyway, but a replay
  // from a terminal state should not touch the ledger at all. Distinct from the
  // refusal below so the CLI can exit 0 here and non-zero there.
  if (transfer.state === 'REFUNDED') return { done: true, outcome: 'already_settled' }

  // The guard that matters: only refund a transfer that actually reached
  // PAYOUT_FAILED — never one that delivered.
  if (transfer.state !== 'PAYOUT_FAILED') {
    return { done: false, reason: 'not_payout_failed', state: transfer.state }
  }

  // 1) Book the returned principal back to cash — a stand-alone post (state
  //    stays PAYOUT_FAILED), keyed {id}:bridge_return, idempotent on replay.
  await postLedgerTransaction({
    transferId: transfer.id,
    transition: 'bridge_return',
    description: 'bridge returned principal on payout failure',
    entries: toLedgerInput(bridgeReturnLedgerEntries(transfer)),
  })

  // 2) Return the collected funds to the sender. null-gated so a duplicate
  //    never double-refunds; keyed off the transfer's stable bridge idempotency
  //    key so a retry dedupes against the real processor (slice 7).
  const alreadyDisbursed = transfer.refund_payment_ref !== null
  if (!alreadyDisbursed) {
    const undo = await getFundingProcessor().refund({
      transferId: transfer.id,
      paymentRef: transfer.funding_payment_ref ?? '',
      amountMinor: transfer.send_amount_minor + transfer.fee_amount_minor,
      currency: 'USD',
      idempotencyKey: `${transfer.idempotency_key}:refund`,
    })
    const { error } = await supabaseAdmin
      .from('transfers')
      .update({ refund_payment_ref: undo.ref, refunded_at: new Date().toISOString() })
      .eq('id', transfer.id)
      .is('refund_payment_ref', null)
    if (error) throw new Error(`refund ref persist failed: ${error.message}`)
  }

  // 3) Recognize + pay the refund and settle REFUNDED — a DISTINCT posting key
  //    from bridge_return (the UNIQUE(transfer_id, transition) index needs both).
  await transitionTransfer({
    transferId: transfer.id,
    fromState: 'PAYOUT_FAILED',
    toState: 'REFUNDED',
    actor: input.actor,
    reason: input.reason,
    ledgerDescription: 'transfer REFUNDED — payout failed, sender refunded from float',
    ledgerEntries: refundedLedgerEntries(transfer),
  })

  return { done: true, outcome: alreadyDisbursed ? 'already_disbursed' : 'refunded' }
}

/**
 * The principal-returned interlock for the operator path. `bridge_return` books
 * `DR cash_clearing / CR due_from_bridge` — it ASSERTS Bridge sent our cash back,
 * so if that is wrong the books claim cash we do not hold.
 *
 * Two independent sources must agree: a recorded terminal `returned`/`refunded`
 * event, AND a live Bridge GET saying the same. Either one alone can be stale or
 * wrong — a webhook can arrive for a state Bridge later reverses, and a live read
 * with no recorded event means our own pipeline never saw it. An unreachable
 * Bridge throws rather than resolving to a verdict: silence is not confirmation.
 *
 * This checks WHETHER the principal came back, not HOW MUCH. A partial return
 * would still book the full `send_amount_minor` in bridge_return and make the
 * sender whole from float, leaving the shortfall as an unreconciled receivable.
 * Same open assumption the automated path already carries (transfers.ts:
 * "assumes Bridge returns S, not the actual USDC draw A") — a pilot-verification
 * item, not something to resolve from a CLI.
 */
export async function verifyPrincipalReturned(transferId: string): Promise<PrincipalVerdict> {
  const { data, error } = await supabaseAdmin
    .from('transfers')
    .select('id, state, provider_transfer_ref')
    .eq('id', transferId)
    .maybeSingle()
  if (error) throw new Error(`refund interlock transfer load failed: ${error.message}`)
  const transfer = data as { id: string; provider_transfer_ref: string | null } | null
  if (!transfer) return { returned: false, reason: 'transfer_not_found' }
  // Never submitted to Bridge → Bridge holds nothing of ours to return.
  if (!transfer.provider_transfer_ref) return { returned: false, reason: 'not_submitted' }

  const eventType = await findReturnEvent(transfer.id, transfer.provider_transfer_ref)
  const bridge = await getBridgeTransfer(transfer.provider_transfer_ref)
  const bridgeAgrees = (PRINCIPAL_RETURNED_STATES as readonly string[]).includes(bridge.state)

  if (!eventType) return { returned: false, reason: 'no_return_event', bridgeState: bridge.state }
  if (!bridgeAgrees) {
    return { returned: false, reason: 'bridge_disagrees', bridgeState: bridge.state, eventType }
  }
  return { returned: true, bridgeState: bridge.state, eventType }
}

// Read-only ops surface for the CLI. Deliberately here rather than in the
// script: nothing under scripts/ queries the database directly — DB access
// stays under src/ — and the column list is a PII decision (ids, amounts,
// timestamps — never recipient names or destination details, which must not
// reach an operator's terminal or scrollback).
export interface ParkedRefund {
  id: string
  state: string
  send_amount_minor: number
  fee_amount_minor: number
  provider_transfer_ref: string | null
  created_at: string
}

const PARKED_COLUMNS =
  'id, state, send_amount_minor, fee_amount_minor, provider_transfer_ref, created_at'

/**
 * The parked-refund backlog: transfers stuck at `PAYOUT_FAILED` with the payout
 * submitted and no refund disbursed. Same predicate as the payout poller's
 * self-heal scan (payout-poll.ts) — with `AUTO_REFUND` off the poller skips
 * these entirely, and a row whose terminal event was already processed while the
 * flag was off is never re-driven by flipping it on. This IS the human backlog.
 */
export async function listRefundBacklog(): Promise<ParkedRefund[]> {
  const { data, error } = await supabaseAdmin
    .from('transfers')
    .select(PARKED_COLUMNS)
    .eq('state', 'PAYOUT_FAILED')
    .is('refund_payment_ref', null)
    .not('provider_transfer_ref', 'is', null)
  // Fail closed: an empty backlog and a broken read must never look the same.
  if (error || data == null) {
    throw new Error(`refund backlog query failed: ${error?.message ?? 'no rows returned'}`)
  }
  return data as ParkedRefund[]
}

/** The posting batches on a transfer — the operator's proof both keys landed. */
export async function refundLedgerBatches(
  transferId: string,
): Promise<Array<{ transition: string | null; idempotency_key: string }>> {
  const { data, error } = await supabaseAdmin
    .from('ledger_transactions')
    .select('transition, idempotency_key')
    .eq('transfer_id', transferId)
  if (error || data == null) {
    throw new Error(`refund ledger batch query failed: ${error?.message ?? 'no rows returned'}`)
  }
  return data as Array<{ transition: string | null; idempotency_key: string }>
}

async function loadRefundable(transferId: string): Promise<RefundableTransfer | null> {
  const { data, error } = await supabaseAdmin
    .from('transfers')
    .select(REFUNDABLE_COLUMNS)
    .eq('id', transferId)
    .maybeSingle()
  if (error) throw new Error(`refund transfer load failed: ${error.message}`)
  return (data as RefundableTransfer | null) ?? null
}

// Ingest does not always resolve transfer_id (out-of-order / unknown reference —
// see payment-events.ts), so match on either key. PostgREST `or` takes a filter
// STRING, not bound parameters, so BOTH interpolated values are charset-checked
// first: an id like `x),or(1.eq.1` would otherwise rewrite the predicate. The
// transfer id reaches here straight from a CLI argument. The two failure modes
// differ on purpose — a bad transfer id THROWS, a bad provider ref is DROPPED
// from the predicate, because narrowing the match can only produce a stricter
// verdict, never a false confirmation.
async function findReturnEvent(
  transferId: string,
  providerTransferRef: string,
): Promise<string | null> {
  if (!UUID_RE.test(transferId)) {
    throw new Error(`refund principal-return event query failed: malformed transfer id`)
  }
  const clauses = [`transfer_id.eq.${transferId}`]
  if (/^[A-Za-z0-9_-]+$/.test(providerTransferRef)) {
    clauses.push(`provider_ref.eq.${providerTransferRef}`)
  }

  const { data, error } = await supabaseAdmin
    .from('payment_events')
    .select('event_type')
    .in('event_type', [...PRINCIPAL_RETURNED_STATES])
    .or(clauses.join(','))
    .limit(1)
  // Fail closed: a null-without-error must never read as "no return event", which
  // is the same answer as a confirmed refusal but for the wrong reason.
  if (error || data == null) {
    throw new Error(
      `refund principal-return event query failed: ${error?.message ?? 'no rows returned'}`,
    )
  }
  const rows = data as Array<{ event_type: string }>
  return rows[0]?.event_type ?? null
}
