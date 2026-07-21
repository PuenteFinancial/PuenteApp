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
import {
  getBoss,
  ensureQueues,
  JOB_RECONCILE_PENDING,
  JOB_IDEMPOTENCY_PURGE,
} from './services/queue.js'
import { reconcilePendingTransfers } from './jobs/reconcile-pending.js'
import { purgeExpiredIdempotencyKeys } from './jobs/purge-idempotency.js'

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
  console.error('worker: BRIDGE_TREASURY_WALLET_ID is required — payout submission has no source wallet without it')
  process.exit(1)
}

// Job handlers return the number of rows they touched. Errors are reported
// to Sentry and rethrown so pg-boss records the failure and applies the
// queue's retry policy — a handler rejection must never crash the process
// (pg-boss catches it; the rethrow only fails the job).
const handle = (jobName: string, fn: () => Promise<number>) => async () => {
  try {
    const count = await fn()
    console.log(`worker: ${jobName} handled ${count} row(s)`)
  } catch (err) {
    Sentry.captureException(err)
    console.error(`worker: ${jobName} failed`, err)
    throw err
  }
}

const boss = await getBoss()
await ensureQueues()

await boss.work(JOB_RECONCILE_PENDING, handle(JOB_RECONCILE_PENDING, reconcilePendingTransfers))
await boss.work(JOB_IDEMPOTENCY_PURGE, handle(JOB_IDEMPOTENCY_PURGE, purgeExpiredIdempotencyKeys))

// Housekeeping crons (slice-5 decision 8) — they double as the deploy smoke
// test. payout.sweep / payout.poll are scheduled in PR 2/3, not here.
await boss.schedule(JOB_RECONCILE_PENDING, '*/5 * * * *')
await boss.schedule(JOB_IDEMPOTENCY_PURGE, '0 4 * * *')

// Minimal health endpoint for Railway — no Fastify, the worker serves no API.
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
