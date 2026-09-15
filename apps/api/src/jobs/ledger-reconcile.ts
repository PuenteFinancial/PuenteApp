import * as Sentry from '@sentry/node'
import { supabaseAdmin } from '../services/supabase.js'
import {
  buildChecks,
  type CheckFinding,
  type CheckSeverity,
  type CheckStatus,
} from '../services/reconciliation.js'
import {
  loadActiveAcknowledgements,
  partitionFindings,
  type Acknowledgement,
} from '../services/reconciliation-ack.js'

// The daily reconciliation cron (`ledger.reconcile`, slice-8 O2,
// docs/runbooks/reconciliation.md). Runs the whole checks registry, pages
// Sentry per finding, and persists ONE reconciliation_runs row per run.
//
// Failure posture: once the run starts, one check throwing must not sink the
// others — the error becomes that check's outcome ('error': its findings are
// UNKNOWN, not zero) and is paged. The job itself only throws when the run row
// cannot be persisted (worker handle() reports it; the queue's no-retry policy
// means the next tick is hours away, which is exactly what a broken audit write
// should surface as: loudly, not silently).
//
// NOTHING here mutates money. The one auto-action in the registry is the
// bridge state sweep, which replays missed webhooks through the same
// idempotent worker path the poller uses. Everything else pages a human.
//
// ACKNOWLEDGEMENTS (2026-09-15, services/reconciliation-ack.ts). A finding a human has already
// answered for can be silenced until a stated date, so the inbox keeps meaning something. Three
// properties of that are this file's job, not the service's:
//   * FAIL OPEN — an unreadable acknowledgements table pages everything, loudly.
//   * FATAL IS NEVER SILENCED — partitionFindings is given the running check's own severity.
//   * A SILENCED RUN SAYS SO — acknowledged_count on the run row and on each check record, plus
//     a log line on an otherwise-clean run. A pass that is only a pass because something is
//     muted must never read like an empty one.

interface CheckRunRecord {
  name: string
  /** UNACKNOWLEDGED findings — what a human should react to. See acknowledged_count. */
  findings_count: number
  status: CheckStatus
  /** Findings suppressed by an active acknowledgement. Omitted when zero, so a run with nothing
   *  silenced reads exactly as it did before acknowledgements existed. */
  acknowledged_count?: number
  summary?: Record<string, unknown>
  error?: string
}

const SEVERITY_LEVEL: Record<CheckSeverity, 'fatal' | 'error' | 'warning'> = {
  fatal: 'fatal',
  error: 'error',
  warning: 'warning',
}

function pageFinding(checkName: string, severity: CheckSeverity, runbook: string, finding: CheckFinding): void {
  Sentry.withScope((scope) => {
    // One Sentry issue per (check, finding key) EPISODE: the daily re-fire
    // while unresolved collapses into the same issue; resolving it while the
    // discrepancy persists reopens tomorrow — the correction-watch model.
    scope.setFingerprint(['reconcile', checkName, finding.key])
    scope.setContext('reconciliation_finding', { ...finding.detail, check: checkName, runbook })
    Sentry.captureMessage(`reconciliation: ${checkName} — ${finding.key}`, SEVERITY_LEVEL[severity])
  })
}

function pageCheckError(checkName: string, runbook: string, message: string): void {
  Sentry.withScope((scope) => {
    scope.setFingerprint(['reconcile-check-error', checkName])
    scope.setContext('reconciliation_check_error', { check: checkName, runbook, message })
    Sentry.captureMessage(`reconciliation: ${checkName} could not complete`, 'error')
  })
}

/**
 * The acknowledgements table could not be read, so this run paged everything.
 *
 * Nothing is hidden by that — failing open is the whole design — but it must not be SILENT.
 * A suppression layer that quietly stops working looks exactly like a system with nothing
 * acknowledged, which is the same trap as a LISTEN/NOTIFY fallback nobody is told about
 * (services/queue.ts). The run is marked 'error' for the same reason.
 */
function pageAcknowledgementsUnavailable(message: string): void {
  Sentry.withScope((scope) => {
    scope.setFingerprint(['reconcile-acknowledgements-unavailable'])
    scope.setContext('reconciliation_acknowledgements', { message })
    Sentry.captureMessage(
      'reconciliation: acknowledgements unreadable — every finding paged',
      'error',
    )
  })
}

export async function reconcileLedger(): Promise<number> {
  const startedAt = new Date().toISOString()
  const records: CheckRunRecord[] = []
  let balances: Record<string, { amount_minor: number; currency: string }> = {}
  let findingsTotal = 0
  let acknowledgedTotal = 0
  let anyError = false

  // Read ONCE for the whole run, and FAIL OPEN. An unreadable acknowledgements table means this
  // run cannot tell a silenced finding from a live one, and the only safe reading of "I do not
  // know" is to page. loadActiveAcknowledgements throws rather than returning an empty map
  // precisely so those two cases stay distinguishable here.
  let active = new Map<string, Acknowledgement>()
  try {
    active = await loadActiveAcknowledgements()
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    anyError = true
    pageAcknowledgementsUnavailable(message)
    console.error(`worker: ledger.reconcile acknowledgements unreadable: ${message}`)
  }

  for (const check of buildChecks()) {
    try {
      const outcome = await check.run()
      // Fatal checks are never suppressed — partitionFindings enforces that on the severity of
      // the check actually being run, not on anything the table says.
      const { pageable, acknowledged } = partitionFindings({
        checkName: check.name,
        severity: check.severity,
        findings: outcome.findings,
        active,
      })
      records.push({
        name: check.name,
        status: outcome.status,
        findings_count: pageable.length,
        ...(acknowledged.length > 0 && { acknowledged_count: acknowledged.length }),
        ...(outcome.summary && { summary: outcome.summary }),
      })
      if (outcome.balances) balances = outcome.balances
      if (outcome.status === 'error') {
        // A RETURNED error outcome (partial sweep — e.g. some PI reads failed
        // but the check salvaged the rest) must page exactly like a thrown
        // one: its findings are unknown, and a quiet run row is not an alert
        // (codex-review finding, 2026-07-31).
        anyError = true
        pageCheckError(
          check.name,
          check.runbook,
          String(outcome.summary?.['firstReadFailure'] ?? 'check reported a partial failure'),
        )
      }
      findingsTotal += pageable.length
      acknowledgedTotal += acknowledged.length
      for (const finding of pageable) {
        pageFinding(check.name, check.severity, check.runbook, finding)
      }
    } catch (err) {
      // Log the MESSAGE only (worker.ts convention — error objects can carry
      // provider bodies); Sentry gets the page with the same message.
      const message = err instanceof Error ? err.message : String(err)
      anyError = true
      records.push({ name: check.name, status: 'error', findings_count: 0, error: message })
      pageCheckError(check.name, check.runbook, message)
      console.error(`worker: ledger.reconcile check ${check.name} failed: ${message}`)
    }
  }

  // Status follows the ACTIONABLE count. A run whose only findings are acknowledged is a pass —
  // that is what an acknowledgement means — and acknowledged_count is what stops that pass from
  // being indistinguishable from a genuinely empty one.
  const status = anyError ? 'error' : findingsTotal > 0 ? 'findings' : 'pass'
  const { error: insertError } = await supabaseAdmin.from('reconciliation_runs').insert({
    started_at: startedAt,
    finished_at: new Date().toISOString(),
    status,
    findings_count: findingsTotal,
    acknowledged_count: acknowledgedTotal,
    checks: records,
    balances,
  })
  if (insertError) {
    throw new Error(`reconciliation_runs insert failed: ${insertError.message}`)
  }

  // Local evidence beside the Sentry pages (correction-watch pattern): a
  // Sentry outage must not leave a findings/error run traceless on the Railway
  // log stream. Counts only, never finding detail. Clean runs are already
  // logged by the worker's handle() wrapper.
  if (status !== 'pass') {
    console.warn(
      `worker: ledger.reconcile ${status} — ${findingsTotal} finding(s) across ${records.length} check(s)` +
        (acknowledgedTotal > 0 ? `, ${acknowledgedTotal} acknowledged` : ''),
    )
  } else if (acknowledgedTotal > 0) {
    // A CLEAN run that is only clean because something is silenced still says so. Without this
    // line the Railway stream would show an ordinary pass, which is the one thing an operator
    // must not be able to mistake this for.
    console.warn(
      `worker: ledger.reconcile pass — 0 actionable finding(s), ${acknowledgedTotal} acknowledged`,
    )
  }
  return findingsTotal
}
