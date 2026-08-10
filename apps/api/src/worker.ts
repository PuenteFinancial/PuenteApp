/* eslint-disable no-console -- no Fastify/pino here; stdout IS the worker's
   log stream on Railway, and these lines carry no PII (job names + counts). */
// Background worker entrypoint — deployed as its own Railway service
// (start: node dist/worker.js, healthcheck: /health). Same codebase as the
// API; only this process talks to Postgres directly (pg-boss over
// DATABASE_URL) — the API stays PostgREST-only.
import './instrument.js'
import * as Sentry from '@sentry/node'
import http from 'node:http'
import { env } from './config/env.js'
import { withBootRetry } from './utils/boot-retry.js'
import {
  getBoss,
  ensureQueues,
  JOB_PAYOUT_SUBMIT,
  JOB_PAYOUT_SWEEP,
  JOB_PAYOUT_POLL,
  JOB_PAYMENT_EVENT_PROCESS,
  JOB_RECONCILE_PENDING,
  JOB_IDEMPOTENCY_PURGE,
  JOB_LOSS_CORRECTION_WATCH,
  JOB_LEDGER_RECONCILE,
  JOB_STUCK_WATCH,
  JOB_WORKER_HEARTBEAT,
  WORKER_HEARTBEAT_CRON,
  type PayoutSubmitPayload,
  type PaymentEventProcessPayload,
} from './services/queue.js'
import { reconcilePendingTransfers } from './jobs/reconcile-pending.js'
import { watchLossCorrections } from './jobs/correction-watch.js'
import { purgeExpiredIdempotencyKeys } from './jobs/purge-idempotency.js'
import { reconcileLedger } from './jobs/ledger-reconcile.js'
import { watchStuckTransfers } from './jobs/stuck-watch.js'
import { submitPayout } from './jobs/payout-submit.js'
import { sweepPayouts } from './jobs/payout-sweep.js'
import { pollPayouts } from './jobs/payout-poll.js'
import { processPaymentEvent } from './jobs/payment-event-process.js'
import {
  recordWorkerHeartbeat,
  WORKER_HEARTBEAT_MONITOR,
  WORKER_HEARTBEAT_MONITOR_SLUG,
  type MonitorConfig,
} from './jobs/worker-heartbeat.js'

// pg-boss schedule() takes cron (1-min floor), but the poll cadence is
// configured in seconds — convert to an every-N-minutes expression.
const pollCron = (() => {
  const minutes = Math.max(1, Math.round(env.WORKER_POLL_INTERVAL_SECONDS / 60))
  return `*/${minutes} * * * *`
})()

// Fail fast on missing worker-only env — a worker that boots without these
// would sit healthy-looking while every payout job errors. (Both are optional
// in the shared schema so the API can boot without them.)
if (!env.DATABASE_URL) {
  console.error(
    'worker: DATABASE_URL is required — set it to the Supabase SESSION-mode ' +
      'pooler connection string (port 5432, never transaction mode 6543)',
  )
  process.exit(1)
}
if (!env.BRIDGE_TREASURY_WALLET_ID) {
  console.error(
    'worker: BRIDGE_TREASURY_WALLET_ID is required — payout submission has no source wallet without it',
  )
  process.exit(1)
}

// Health endpoint starts BEFORE pg-boss boot, not after. Railway health-checks
// this within a 30s timeout; if it only came up once the whole pg-boss boot
// sequence finished, a slow-but-recovering retry below would race that
// timeout and get killed regardless of whether it would have succeeded.
// Liveness (process is up) and pg-boss readiness are deliberately decoupled.
const server = http.createServer((req, res) => {
  if (req.method === 'GET' && req.url === '/health') {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ status: 'ok' }))
  } else {
    res.writeHead(404, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ error: { code: 'not_found' } }))
  }
})
server.listen(env.PORT, env.HOST, () => {
  console.log(`worker: health endpoint listening on ${env.HOST}:${env.PORT}`)
})

// Job handlers return the number of rows they touched. Errors are reported
// to Sentry and rethrown so pg-boss records the failure and applies the
// queue's retry policy — a handler rejection must never crash the process
// (pg-boss catches it; the rethrow only fails the job).
// Log the MESSAGE only, never the error object: BridgeApiError (and future
// error types) can carry raw provider bodies with PII, and console.error
// prints enumerable properties. Sentry gets the full exception (scrubbed —
// sendDefaultPii: false).
const errMessage = (err: unknown) => (err instanceof Error ? err.message : String(err))

const handle = (jobName: string, fn: () => Promise<number>) => async () => {
  try {
    const count = await fn()
    console.log(`worker: ${jobName} handled ${count} row(s)`)
  } catch (err) {
    Sentry.captureException(err)
    console.error(`worker: ${jobName} failed: ${errMessage(err)}`)
    throw err
  }
}

// Sentry cron check-in, wrapped around the INNER fn so handle()'s
// () => Promise<number> contract is untouched and the failure order is right:
// withMonitor marks the check-in 'error' first, then handle captures and
// rethrows, then pg-boss records the job failure.
//
// Applied to exactly ONE job — the beat whose whole purpose is to prove the
// dispatcher still dispatches. Deliberately not folded into handle() for every
// cron: a monitor needs its own slug AND a crontab matching the real cadence
// (handle() has neither), and monitoring all eight would create a monitor for
// payout.sweep at 1-minute cadence alone. The other crons report failures
// through Sentry.captureException above, as they do today — a failing
// idempotency.purge is a bug report, not a liveness signal.
const monitored =
  (slug: string, config: MonitorConfig, fn: () => Promise<number>) => (): Promise<number> =>
    Sentry.withMonitor(slug, fn, config)

// Safe to wait out a retry here because the health endpoint above is already
// listening — Railway won't kill the container mid-retry the way it would if
// liveness depended on this whole sequence succeeding.
const boss = await withBootRetry(
  async () => {
    const boss = await getBoss('worker')
    await ensureQueues('worker')

    await boss.work(JOB_RECONCILE_PENDING, handle(JOB_RECONCILE_PENDING, reconcilePendingTransfers))
    await boss.work(
      JOB_IDEMPOTENCY_PURGE,
      handle(JOB_IDEMPOTENCY_PURGE, purgeExpiredIdempotencyKeys),
    )
    await boss.work(
      JOB_LOSS_CORRECTION_WATCH,
      handle(JOB_LOSS_CORRECTION_WATCH, watchLossCorrections),
    )
    await boss.work(JOB_LEDGER_RECONCILE, handle(JOB_LEDGER_RECONCILE, reconcileLedger))
    await boss.work(JOB_STUCK_WATCH, handle(JOB_STUCK_WATCH, watchStuckTransfers))
    await boss.work(JOB_PAYOUT_SWEEP, handle(JOB_PAYOUT_SWEEP, sweepPayouts))
    await boss.work(JOB_PAYOUT_POLL, handle(JOB_PAYOUT_POLL, pollPayouts))
    await boss.work(
      JOB_WORKER_HEARTBEAT,
      handle(
        JOB_WORKER_HEARTBEAT,
        monitored(WORKER_HEARTBEAT_MONITOR_SLUG, WORKER_HEARTBEAT_MONITOR, recordWorkerHeartbeat),
      ),
    )
    // payment-event.process carries a paymentEventId payload; same batch-of-1
    // semantics as payout.submit (a rejection fails the job and pg-boss retries).
    await boss.work<PaymentEventProcessPayload>(JOB_PAYMENT_EVENT_PROCESS, async (jobs) => {
      for (const job of jobs) {
        try {
          await processPaymentEvent(job.data.paymentEventId)
          console.log(`worker: ${JOB_PAYMENT_EVENT_PROCESS} handled ${job.data.paymentEventId}`)
        } catch (err) {
          Sentry.captureException(err)
          console.error(`worker: ${JOB_PAYMENT_EVENT_PROCESS} failed: ${errMessage(err)}`)
          throw err
        }
      }
    })
    // Payload jobs arrive as a batch (size 1 by default); each transfer submits
    // independently — a rejection fails the whole batch job, and pg-boss applies
    // the queue's retry policy per job, so batches must stay size 1.
    await boss.work<PayoutSubmitPayload>(JOB_PAYOUT_SUBMIT, async (jobs) => {
      for (const job of jobs) {
        try {
          const submitted = await submitPayout(job.data.transferId)
          console.log(`worker: ${JOB_PAYOUT_SUBMIT} transfer handled (submitted=${submitted})`)
        } catch (err) {
          Sentry.captureException(err)
          console.error(`worker: ${JOB_PAYOUT_SUBMIT} failed: ${errMessage(err)}`)
          throw err
        }
      }
    })

    // Housekeeping crons (slice-5 decision 8) — they double as the deploy smoke
    // test — plus the 1-min payout sweep (PR 2). payout.poll is scheduled in PR 3.
    await boss.schedule(JOB_RECONCILE_PENDING, '*/5 * * * *')
    await boss.schedule(JOB_IDEMPOTENCY_PURGE, '0 4 * * *')
    await boss.schedule(JOB_PAYOUT_SWEEP, '* * * * *')
    await boss.schedule(JOB_PAYOUT_POLL, pollCron)
    await boss.schedule(JOB_LOSS_CORRECTION_WATCH, '0 * * * *')
    // Daily reconciliation (slice-8 O2): 6am UTC = overnight US — off-peak, after
    // the 4am idempotency purge, before the workday reads the findings.
    await boss.schedule(JOB_LEDGER_RECONCILE, '0 6 * * *')
    // Stuck-transfer pager (slice-8 O1): 5-min sweep of non-terminal dwell.
    await boss.schedule(JOB_STUCK_WATCH, '*/5 * * * *')
    // Liveness beat (Workstream A). Last in the block because it is not a
    // business cron: it exists so the silence of the others is detectable.
    await boss.schedule(JOB_WORKER_HEARTBEAT, WORKER_HEARTBEAT_CRON)

    return boss
  },
  5,
  1000,
  (attempt, delay, err) =>
    console.error(
      `worker: boot attempt ${attempt}/5 failed, retrying in ${delay}ms: ${errMessage(err)}`,
    ),
)

// stop() with graceful (the default) lets in-flight jobs finish, bounded by
// its 30s timeout — under Railway's SIGTERM grace period.
let shuttingDown = false
const shutdown = async (signal: string) => {
  if (shuttingDown) return
  shuttingDown = true
  console.log(`worker: ${signal} received, shutting down`)
  try {
    await boss.stop()
  } catch (err) {
    Sentry.captureException(err)
    console.error('worker: pg-boss stop failed', err)
  }
  server.close(() => process.exit(0))
  // Lingering health-check keep-alives must not block exit forever.
  setTimeout(() => process.exit(0), 5000).unref()
}
process.on('SIGTERM', () => void shutdown('SIGTERM'))
process.on('SIGINT', () => void shutdown('SIGINT'))
