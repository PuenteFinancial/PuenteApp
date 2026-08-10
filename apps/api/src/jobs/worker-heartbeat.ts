import type * as Sentry from '@sentry/node'
import { supabaseAdmin } from '../services/supabase.js'
import { WORKER_HEARTBEAT_CRON } from '../services/queue.js'

// Derived from the public withMonitor signature rather than imported from
// @sentry/core: that package is a transitive of @sentry/node and pnpm's strict
// layout makes it unresolvable, and depending on the SDK's internal package to
// name one type is not worth a package.json entry. This also stays correct on
// its own if the SDK reshapes the config.
export type MonitorConfig = NonNullable<Parameters<typeof Sentry.withMonitor>[2]>

// `worker.heartbeat` (slice-8 Workstream A): the liveness beat.
//
// On 2026-08-02 the staging worker stopped creating jobs for ~22.4 hours with
// zero Sentry events — the process stayed up, so /health kept answering 200 and
// Railway never restarted it. Nothing ran, so nothing failed, so nothing paged.
// This job exists so that the SILENCE of every other cron becomes detectable.
//
// The handler does a real database round-trip rather than just checking in,
// because BOTH cron dispatch and database access were implicated that day: a
// beat must prove the dispatcher dispatched AND that the worker could still
// reach the database. A no-op handler would prove only the first.
//
// It rides supabaseAdmin (PostgREST), NOT pg-boss's direct DATABASE_URL
// connection. Deliberate, with a known consequence: a sustained Supabase edge
// outage fails the beat even while Postgres and pg-boss are healthy. Accepted —
// PostgREST is the path every real job and the ops page depend on, so it is the
// path worth proving, and one issue for a >15-minute outage is proportionate
// (contrast the 136 events the 08-09 edge cluster produced). It is also why
// Workstream B's retry wrapper must NOT be added here: a beat that succeeds
// only after retries is one that should have registered as degraded.

// The logical dispatcher this process beats for — see the migration for why
// this is a literal and not the Railway service name (a rename would orphan the
// old row, which then goes stale forever and alarms about a worker that no
// longer exists).
const WORKER_KEY = 'worker'

// Which build last beat. Diagnostic only, never on the ops wire; it is also the
// non-key column that makes the upsert a genuine UPDATE, which is what fires
// the moddatetime trigger that writes updated_at. Railway injects this at build
// time (same source as /health's commit field); local dev has no value and the
// column is nullable.
const INSTANCE = process.env.RAILWAY_GIT_COMMIT_SHA?.slice(0, 7) ?? null

export const WORKER_HEARTBEAT_MONITOR_SLUG = 'worker-heartbeat'

// Sentry cron monitor config, upserted by withMonitor on every check-in — no
// pre-creation in the Sentry UI is required. The schedule REFERENCES the same
// constant boss.schedule() consumes so the two cannot drift; a monitor whose
// crontab disagrees with the real cadence either alerts constantly or never
// alerts at all, and the second failure mode is invisible until it matters.
export const WORKER_HEARTBEAT_MONITOR: MonitorConfig = {
  schedule: { type: 'crontab', value: WORKER_HEARTBEAT_CRON },
  timezone: 'UTC',
  // A deploy restarts the worker, and the beat is usually LATE rather than
  // skipped (SIGTERM, graceful boss.stop() up to 30s, container swap, then
  // pg-boss boot — occasionally a withBootRetry backoff chain). checkinMargin
  // absorbs lateness; only failureIssueThreshold absorbs an outright skip.
  // Deploys can produce either, so both are set — but the margin stays small,
  // because a large one buys nothing a deploy needs and only delays detection.
  checkinMargin: 2,
  // Three consecutive misses ≈ 17 minutes of dead dispatch before an issue
  // opens. One miss is noise (a deploy); two is plausible (a rollback or a slow
  // boot-retry chain); three is signal. Measured against a 22.4-hour outage,
  // 17 minutes is not the constraint worth optimizing.
  failureIssueThreshold: 3,
  // One good beat resolves it — a worker that beats is alive, full stop.
  recoveryThreshold: 1,
  // One PostgREST upsert. supabase-js sets no fetch timeout, so a hung socket
  // would otherwise leave the check-in in_progress indefinitely.
  maxRuntime: 2,
}

/**
 * Upserts this worker's heartbeat row. Returns the number of rows written (1).
 *
 * `updated_at` is deliberately NOT sent — the moddatetime trigger writes it
 * with the database clock, so a worker with a skewed clock cannot report itself
 * recently alive while dead. `instance` is sent on every beat so the upsert is
 * a genuine UPDATE of a non-key column, which is what fires that trigger.
 */
export async function recordWorkerHeartbeat(): Promise<number> {
  const { data, error } = await supabaseAdmin
    .from('worker_heartbeat')
    .upsert({ worker: WORKER_KEY, instance: INSTANCE }, { onConflict: 'worker' })
    .select('worker')
  if (error) throw new Error(`worker heartbeat upsert failed: ${error.message}`)
  // Asking for the returning representation is the point, not a convenience: a
  // write that silently affected no row (a filtered write, a schema-cache miss)
  // must FAIL the beat, not report a healthy zero-row success. A liveness
  // signal that can pass without writing anything is not a liveness signal.
  if (data == null || data.length !== 1) {
    throw new Error(`worker heartbeat upsert wrote ${data?.length ?? 0} row(s), expected 1`)
  }
  return data.length
}
