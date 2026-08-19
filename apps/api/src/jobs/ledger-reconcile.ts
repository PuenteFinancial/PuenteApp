import * as Sentry from '@sentry/node'
import { supabaseAdmin } from '../services/supabase.js'
import {
  buildChecks,
  type CheckFinding,
  type CheckSeverity,
  type CheckStatus,
} from '../services/reconciliation.js'

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

interface CheckRunRecord {
  name: string
  status: CheckStatus
  findings_count: number
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

export async function reconcileLedger(): Promise<number> {
  const startedAt = new Date().toISOString()
  const records: CheckRunRecord[] = []
  let balances: Record<string, { amount_minor: number; currency: string }> = {}
  let findingsTotal = 0
  let anyError = false

  for (const check of buildChecks()) {
    try {
      const outcome = await check.run()
      records.push({
        name: check.name,
        status: outcome.status,
        findings_count: outcome.findings.length,
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
      findingsTotal += outcome.findings.length
      for (const finding of outcome.findings) {
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

  const status = anyError ? 'error' : findingsTotal > 0 ? 'findings' : 'pass'
  const { error: insertError } = await supabaseAdmin.from('reconciliation_runs').insert({
    started_at: startedAt,
    finished_at: new Date().toISOString(),
    status,
    findings_count: findingsTotal,
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
      `worker: ledger.reconcile ${status} — ${findingsTotal} finding(s) across ${records.length} check(s)`,
    )
  }
  return findingsTotal
}
