import * as Sentry from '@sentry/node'
import { supabaseAdmin } from './supabase.js'

// The durable "who did what, why, and what did they see" for every ops write
// (ops board slice 1 / O-B; migration 20260908171500). transfer_transitions
// records the actor of a STATE CHANGE and the audit plugin logs the hit, but a
// hold release changes no state, and none of them carries the operator's note
// or the before/after the operator acted on.
//
// BEST-EFFORT, NEVER THROWS. The state change, the ledger batch, and the
// transition actor are the primary record; this row is the secondary one. A
// failed insert must not turn a completed money movement into a 500 that
// invites the operator to retry it — so the failure is logged and paged
// (fingerprinted per action) and the caller's 2xx stands. Callers build
// `before`/`after` from FIXED KEYS, never a row spread: that is the PII guard
// for the two jsonb columns.

export type OpsActionKind =
  | 'hold_release'
  | 'refund'
  | 'cancellation_resolve'
  | 'manual_funding'
  | 'deposit_instructions_attach'
  | 'deposit_landed'
  | 'float_topup'
  // System-initiated, not operator-initiated: the loss path freezes a sender
  // on a dispute. Recorded here so the freeze has provenance in the same place
  // an investigator already looks — see the migration for why it is not a
  // table of its own.
  | 'sender_freeze'
  // Its human counterpart, and the only one of the pair that is a DECISION:
  // someone judged a suspected-fraud account safe to transact again. Always
  // `ops:<operator uuid>` with a typed note (scripts/unfreeze-sender.ts) —
  // never system-initiated, because no event says a person is trustworthy.
  | 'sender_unfreeze'

export interface OpsActionInput {
  /** `ops:<admin user id>` — the same vocabulary as transfer_transitions.actor. */
  actor: string
  action: OpsActionKind
  /** Null for the actions that are not about one transfer (float_topup, sender_unfreeze). */
  transferId: string | null
  /** MACHINE vocabulary only (hold reason, decision, outcome) — never free text. */
  reason: string | null
  /** The operator's typed note, when the route requires one. */
  note: string | null
  before: Record<string, unknown>
  after: Record<string, unknown>
  /** Fastify request id — joins the row to the audit-plugin log line. */
  requestId: string | null
}

interface Logger {
  error(obj: Record<string, unknown>, msg: string): void
}

/** Returns whether the row landed. Never rejects. */
export async function recordOpsAction(input: OpsActionInput, log: Logger): Promise<boolean> {
  try {
    const { error } = await supabaseAdmin.from('ops_actions').insert({
      actor: input.actor,
      action: input.action,
      transfer_id: input.transferId,
      reason: input.reason,
      note: input.note,
      before: input.before,
      after: input.after,
      request_id: input.requestId,
    })
    if (error) {
      report(input, error.code ?? 'unknown', log)
      return false
    }
    return true
  } catch (err) {
    report(input, err instanceof Error ? err.message : String(err), log)
    return false
  }
}

// ── Slice 2: reading the record back ─────────────────────────────────────────
//
// Two reads, two shapes. The board FEED carries no note and no before/after —
// it is a one-line log across transfers, and the operator's free text belongs
// on the transfer it was written about. The detail HISTORY carries the note
// and a derived `changes` list. `before`/`after` never reach the wire as
// objects: the response schemas are strict allowlists (no additionalProperties
// true), and a free-shaped jsonb would need exactly that. `changes` is the
// list the UI renders anyway.

const ROW_BOUND = 1000
export const ACTIVITY_FEED_LIMIT = 25

// The feed literal deliberately omits note/before/after: what is not selected
// cannot leak, whatever a schema later says.
const FEED_COLUMNS = 'id, created_at, actor, action, transfer_id, reason'
const HISTORY_COLUMNS = 'id, created_at, actor, action, transfer_id, reason, note, before, after, request_id'

export interface OpsActivityFeedRow {
  id: string
  createdAt: string
  actor: string
  action: string
  /** Null for the actions that are not about one transfer (float_topup, sender_unfreeze). */
  transferId: string | null
  reason: string | null
}

export interface OpsActivityChange {
  key: string
  before: string | null
  after: string | null
}

export interface OpsActivityRow extends OpsActivityFeedRow {
  note: string | null
  changes: OpsActivityChange[]
  requestId: string | null
}

interface FeedRawRow {
  id: string
  created_at: string
  actor: string
  action: string
  transfer_id: string | null
  reason: string | null
}

interface HistoryRawRow extends FeedRawRow {
  note: string | null
  before: unknown
  after: unknown
  request_id: string | null
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)

// Display form of one value: strings as they are, everything else as JSON, and
// null/undefined as null so "was unset" reads as an absence, not the word.
function displayValue(v: unknown): string | null {
  if (v == null) return null
  return typeof v === 'string' ? v : JSON.stringify(v)
}

/**
 * The key-by-key difference the operator's action made. Keys are the union of
 * both objects in first-seen order (before's keys, then any after-only keys);
 * a key whose value did not change is omitted. Callers write fixed keys, so
 * this is a short list; a non-object side (should never happen — the CHECK
 * forbids it) is treated as empty rather than thrown, because the read of a
 * history must not fail on one malformed row.
 */
export function deriveChanges(before: unknown, after: unknown): OpsActivityChange[] {
  const b = isRecord(before) ? before : {}
  const a = isRecord(after) ? after : {}
  const keys = [...Object.keys(b), ...Object.keys(a).filter((k) => !Object.hasOwn(b, k))]
  const changes: OpsActivityChange[] = []
  for (const key of keys) {
    const bv = displayValue(b[key])
    const av = displayValue(a[key])
    if (bv === av) continue
    changes.push({ key, before: bv, after: av })
  }
  return changes
}

function feedRow(r: FeedRawRow): OpsActivityFeedRow {
  return {
    id: r.id,
    createdAt: r.created_at,
    actor: r.actor,
    action: r.action,
    transferId: r.transfer_id,
    reason: r.reason,
  }
}

/** Newest N across every transfer — the board's Recent activity feed. */
export async function listRecentOpsActions(limit = ACTIVITY_FEED_LIMIT): Promise<OpsActivityFeedRow[]> {
  const { data, error } = await supabaseAdmin
    .from('ops_actions')
    .select(FEED_COLUMNS)
    .order('created_at', { ascending: false })
    .limit(limit)
  if (error || data == null) {
    throw new Error(`ops activity feed select failed: ${error?.message ?? 'no rows returned'}`)
  }
  return (data as FeedRawRow[]).map(feedRow)
}

/** Every action taken on one transfer, newest first — the detail page's Activity section. */
export async function listOpsActionsForTransfer(transferId: string): Promise<OpsActivityRow[]> {
  const { data, error } = await supabaseAdmin
    .from('ops_actions')
    .select(HISTORY_COLUMNS)
    .eq('transfer_id', transferId)
    .order('created_at', { ascending: false })
    .limit(ROW_BOUND)
  if (error || data == null) {
    throw new Error(`ops activity history select failed: ${error?.message ?? 'no rows returned'}`)
  }
  const rows = data as HistoryRawRow[]
  if (rows.length >= ROW_BOUND) {
    throw new Error(`ops activity history hit the ${ROW_BOUND}-row PostgREST cap — results may be silently truncated`)
  }
  return rows.map((r) => ({
    ...feedRow(r),
    note: r.note,
    changes: deriveChanges(r.before, r.after),
    requestId: r.request_id,
  }))
}

function report(input: OpsActionInput, detail: string, log: Logger): void {
  // Ids and codes only — the note is operator free text and stays out of logs.
  log.error(
    { action: input.action, transferId: input.transferId, supabaseError: detail },
    'ops_actions write failed — the action itself completed; provenance row is missing',
  )
  Sentry.withScope((scope) => {
    scope.setFingerprint(['ops-actions-write-failed', input.action])
    scope.setContext('ops_action', {
      action: input.action,
      transferId: input.transferId,
      requestId: input.requestId,
      detail,
    })
    Sentry.captureMessage('ops_actions write failed', 'error')
  })
}
