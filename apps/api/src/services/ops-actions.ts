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

export interface OpsActionInput {
  /** `ops:<admin user id>` — the same vocabulary as transfer_transitions.actor. */
  actor: string
  action: OpsActionKind
  /** Null only for treasury-level actions (float_topup). */
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
