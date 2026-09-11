import * as Sentry from '@sentry/node'
import { supabaseAdmin } from './supabase.js'
import { recordOpsAction } from './ops-actions.js'
import { releaseSenderSuspendedHolds } from './payout-holds.js'

// The other half of the loss path's sender freeze.
//
// funding-apply.ts freezes automatically when a chargeback or ACH return lands.
// Nothing set users.status back, and the runbook's only answer was an UPDATE in
// the Supabase editor whose sole trace was query history — the same gap
// ops_actions was built to close for hold releases, left open on the one action
// with the highest bar to clear. Letting a suspected-fraud account transact
// again is a decision, and a decision with no record is indistinguishable from
// an accident.
//
// NOT ON THE OPS BOARD, deliberately (2026-09-10). Three reasons, in order of
// weight:
//   1. The board is transfer-scoped end to end — /ops/transfers/:id, an
//      ops_actions history keyed on transfer_id, response schemas built around
//      one transfer. An unfreeze is a USER action, so a button means a new
//      user-scoped route AND a new web surface. That is a slice, not a
//      follow-up, and it would be built for an action that should fire
//      approximately never.
//   2. It is judgement-heavy and slow by nature. The runbook's default answer
//      is that the account STAYS frozen; unfreezing follows a return-code
//      reading, a sign_in_events sweep, and usually a repayment. Nothing about
//      that wants a button on a dashboard.
//   3. decisions.md 2026-08-01 already put this class of action in the CLI:
//      "the CLI stays break-glass". Doppler access to run it is a stronger gate
//      than the board's OPS_WRITE_ENABLED pair, not a weaker one.
// The escape hatch is cheap and named: this is a SERVICE, so if unfreezing ever
// becomes routine, the route is a thin wrapper exactly the way
// /ops/transfers/hold-release wraps releaseHold. Nothing here would change.

interface Logger {
  info(obj: Record<string, unknown>, msg: string): void
  warn(obj: Record<string, unknown>, msg: string): void
  error(obj: Record<string, unknown>, msg: string): void
}

export type UnfreezeSenderOutcome =
  | {
      done: true
      /** Prior status, for the caller to print. Always 'suspended' by the guard. */
      previousStatus: 'suspended'
      /** The `sender_suspended` holds this unfreeze cleared, if any. */
      releasedTransferIds: string[]
    }
  | { done: false; reason: 'user_not_found' }
  /** Includes the already-'active' replay: a second unfreeze is a refusal, not a lie. */
  | { done: false; reason: 'not_suspended'; status: string }
  /**
   * Still suspended, but NOT the suspension the operator investigated: the row
   * moved between the read and the write. See the `updated_at` guard below.
   */
  | { done: false; reason: 'changed_underneath' }

interface SenderRow {
  id: string
  status: string
  updated_at: string
}

async function readSender(userId: string): Promise<SenderRow | null> {
  const { data, error } = await supabaseAdmin
    .from('users')
    .select('id, status, updated_at')
    .eq('id', userId)
    .maybeSingle()
  // Fail closed: a broken read must never be reported as "not suspended".
  if (error) throw new Error(`sender load failed: ${error.message}`)
  return (data as SenderRow | null) ?? null
}

function classify(row: SenderRow | null): UnfreezeSenderOutcome | null {
  if (row == null) return { done: false, reason: 'user_not_found' }
  if (row.status !== 'suspended') return { done: false, reason: 'not_suspended', status: row.status }
  return null
}

/**
 * Unfreeze one sender and clear the payout holds the freeze left behind.
 *
 * ORDER IS LOAD-BEARING: status first, holds second. payout-submit re-reads the
 * sender's status on every run, so releasing first would just re-hold each row
 * on the next sweep. (Safe either way — that self-correction is why
 * `sender_suspended` is operator-releasable at all — but this order is the one
 * that finishes the job in a single pass.)
 *
 * Restores 'active', not the status the freeze replaced. Nothing in the system
 * gates on 'active' versus 'waitlist' — the only distinction users.status
 * carries is suspended-or-not (see requireOnboardedUser, payout-submit) — and
 * an unfreeze that returned someone to 'waitlist' would look like a demotion
 * nobody chose. The prior value is recorded on the FREEZE's ops_actions row, so
 * nothing is lost.
 *
 * Refusals are outcomes, not throws (releaseHold precedent). A broken read
 * throws. The hold release cannot fail this call: it pages on its own and the
 * unfreeze has already committed.
 */
export async function unfreezeSender(
  input: {
    userId: string
    /** `ops:<operator uuid>` — never defaulted; the CLI refuses without it. */
    actor: string
    /** Why this account is safe again. The whole point of the audit row. */
    note: string
    /** Fastify request id on a route, null in a CLI. */
    requestId: string | null
  },
  log: Logger,
): Promise<UnfreezeSenderOutcome> {
  // Pre-read: an honest refusal for the common cases, and the version the
  // UPDATE below pins. The UPDATE is still the guard.
  const before = await readSender(input.userId)
  const early = classify(before)
  if (early != null) return early

  // `updated_at` IS THE FREEZE VERSION, and it is here because
  // `status = 'suspended'` alone is not a strong enough guard for this action.
  // The bad sequence, which a status-only CAS accepts:
  //
  //   suspended (dispute A) → operator investigates A, decides to lift it
  //   → someone unfreezes → a SECOND dispute arrives → suspended (dispute B)
  //   → this UPDATE runs and clears dispute B's freeze
  //
  // The operator authorised lifting A and would have lifted B, which they never
  // saw. The window is not milliseconds either: an unfreeze follows an
  // investigation, so minutes or hours can pass between the state the operator
  // read and the command they run.
  //
  // `users` carries a `moddatetime` trigger on `updated_at` (migration
  // 20260702000000), so ANY write to the row moves it — including a re-freeze
  // and including the intervening unfreeze. Pinning it means this UPDATE
  // applies only to the exact row state that was classified above, and anything
  // else is refused rather than forced. An unrelated write (a KYC status
  // arriving, a profile edit) also refuses; that costs a re-run, which is the
  // correct direction to fail on a privilege-restoring action.
  const { data, error } = await supabaseAdmin
    .from('users')
    .update({ status: 'active' })
    .eq('id', input.userId)
    .eq('status', 'suspended')
    .eq('updated_at', before!.updated_at)
    .select('id')
  if (error) throw new Error(`sender unfreeze update failed: ${error.message}`)

  if (((data ?? []) as Array<{ id: string }>).length === 0) {
    // Lost the race. ONE re-read tells us which refusal is true now: already
    // unfrozen (or never suspended) reads as that, and a row that still reads
    // 'suspended' is a DIFFERENT suspension than the one classified above —
    // the version guard is what makes those two distinguishable at all.
    const fresh = await readSender(input.userId)
    return classify(fresh) ?? { done: false, reason: 'changed_underneath' }
  }

  // THE DECISION RECORD. Best-effort by contract (recordOpsAction never
  // rejects), because a missing audit row must not undo an unfreeze that has
  // already landed — it reports its own failure instead. `transferId` is null:
  // an unfreeze is about the account, and tying it to one arbitrary transfer of
  // the several a frozen sender may have would be a fiction.
  await recordOpsAction(
    {
      actor: input.actor,
      action: 'sender_unfreeze',
      transferId: null,
      reason: 'operator_review',
      note: input.note,
      before: { status: 'suspended' },
      after: { status: 'active' },
      requestId: input.requestId,
    },
    log,
  )
  log.info({ audit: true, userId: input.userId, actor: input.actor }, 'sender unfrozen by ops')
  Sentry.addBreadcrumb({
    category: 'sender-freeze',
    message: 'sender unfrozen',
    data: { userId: input.userId, actor: input.actor },
    level: 'info',
  })

  const releasedTransferIds = await releaseSenderSuspendedHolds(
    { userId: input.userId, actor: input.actor, requestId: input.requestId },
    log,
  )
  return { done: true, previousStatus: 'suspended', releasedTransferIds }
}

/**
 * The disputes still open against this sender, for the CLI to show BEFORE an
 * operator confirms.
 *
 * This exists because of the one race the version guard above cannot see. The
 * freeze is idempotent by design (`neq('status', 'suspended')`), so a SECOND
 * dispute arriving on an already-frozen sender writes nothing: no users row
 * changes, no second `sender_freeze` record appears, `updated_at` does not
 * move. An operator who investigated dispute A over an hour and then unfreezes
 * would lift the account with dispute B outstanding, and no compare-and-swap
 * anywhere could notice, because nothing about the account changed.
 *
 * The only control is showing them. `funding_disputed` holds (pre-delivery) and
 * `FUNDING_REVERSED` transfers (post-delivery, the loss booked) are the two
 * shapes an open clawback takes; both survive the unfreeze on purpose, and both
 * are reasons to think twice about it.
 */
export async function listSenderOpenDisputes(userId: string): Promise<string[]> {
  const { data, error } = await supabaseAdmin
    .from('transfers')
    .select('id')
    .eq('user_id', userId)
    .or('payout_hold_reason.eq.funding_disputed,state.eq.FUNDING_REVERSED')
    .order('created_at', { ascending: true })
  // Throws: an unfreeze decision taken against a falsely-empty dispute list is
  // exactly the outcome this read exists to prevent.
  if (error) throw new Error(`sender dispute list failed: ${error.message}`)
  return ((data ?? []) as Array<{ id: string }>).map((row) => row.id)
}

/**
 * The `sender_suspended` holds waiting on this sender, for the CLI's dry run.
 * Read-only, and deliberately not part of unfreezeSender: what the operator is
 * shown before confirming must come from its own read, not from a value the
 * write path happened to have in hand.
 */
export async function listSenderSuspendedHolds(userId: string): Promise<string[]> {
  const { data, error } = await supabaseAdmin
    .from('transfers')
    .select('id')
    .eq('user_id', userId)
    .eq('state', 'FUNDED')
    .eq('payout_hold_reason', 'sender_suspended')
  if (error) throw new Error(`sender hold list failed: ${error.message}`)
  return ((data ?? []) as Array<{ id: string }>).map((row) => row.id)
}
