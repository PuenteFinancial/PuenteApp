// pg-boss singleton + the slice-5 job contract (Contract A). Job names,
// payload shapes, and retry policies are frozen here — call sites use these
// exports, never string literals. Both the API (send-only) and the worker
// (send + work + schedule) go through this module, so there is exactly one
// pg-boss instance per process.
//
// pg-boss v12: queues are first-class rows — send/work/schedule throw
// "Queue X does not exist" until createQueue runs. createQueue is
// ON CONFLICT DO NOTHING (idempotent, but it does NOT update an existing
// queue's config), so retry policy is also passed per-send where it matters.
import { PgBoss, type SendOptions } from 'pg-boss'
import * as Sentry from '@sentry/node'
import { env } from '../config/env.js'

export const JOB_PAYOUT_SUBMIT = 'payout.submit'
export const JOB_PAYMENT_EVENT_PROCESS = 'payment-event.process'
export const JOB_FUNDING_ONRAMP_PREPARE = 'funding.onramp_prepare'
export const JOB_PAYOUT_SWEEP = 'payout.sweep'
export const JOB_PAYOUT_POLL = 'payout.poll'
export const JOB_RECONCILE_PENDING = 'transfer.reconcile-pending'
export const JOB_IDEMPOTENCY_PURGE = 'idempotency.purge'
export const JOB_OTP_ATTEMPT_PURGE = 'otp.attempts.purge'
export const JOB_LOSS_CORRECTION_WATCH = 'ledger.correction-watch'
export const JOB_LEDGER_RECONCILE = 'ledger.reconcile'
export const JOB_STUCK_WATCH = 'transfers.stuck-watch'
export const JOB_WORKER_HEARTBEAT = 'worker.heartbeat'

// The heartbeat cadence, exported because TWO places must agree on it:
// boss.schedule() in worker.ts, and the Sentry cron monitor's crontab in
// jobs/worker-heartbeat.ts. A monitor whose schedule disagrees with the real
// cadence either alerts constantly or never alerts at all — and the second
// failure mode looks exactly like a healthy system until the day it matters.
export const WORKER_HEARTBEAT_CRON = '*/5 * * * *'

export interface PayoutSubmitPayload {
  transferId: string
}

export interface PaymentEventProcessPayload {
  paymentEventId: string
}

export interface FundingOnrampPreparePayload {
  transferId: string
}

// Retry policy per Contract A. Declared once and used both at queue creation
// (the durable default) and per-send (wins even if the queue row predates a
// policy change — createQueue never updates existing rows).
//
// policy 'stately': pg-boss v12 only enforces singletonKey dedupe under a
// non-standard queue policy. stately = at most one job per key per state
// (queued / retry / active), which is the Contract A semantic: concurrent
// enqueues collapse, but a re-enqueue while a job is mid-flight is kept —
// jobs are idempotent replays, so extra runs are safe and lost ones are not.
const PAYOUT_SUBMIT_RETRY = { retryLimit: 10, retryBackoff: true, retryDelay: 30 } as const
const PAYMENT_EVENT_RETRY = { retryLimit: 8, retryBackoff: true, retryDelay: 15 } as const
// Onramp creation rides out Bridge downtime on retries (confirm never fails on
// it — the slice-1 attach button covers the tail where these exhaust).
const ONRAMP_PREPARE_RETRY = { retryLimit: 10, retryBackoff: true, retryDelay: 30 } as const
const SINGLETON_POLICY = { policy: 'stately' } as const
// Cron jobs never retry — the next tick is the retry.
const CRON_RETRY = { retryLimit: 0 } as const

let bossPromise: Promise<PgBoss> | undefined

// Both processes share this module, but must NOT share pg-boss config: the
// worker sends + works + schedules and needs the full instance; the API only
// ever calls send() (two webhook call sites), so it gets a deliberately
// light instance — no maintenance supervisor, no cron timekeeper, small pool.
// bossPromise is memoized per-process (API and worker are separate Railway
// processes), so only the first caller's role actually takes effect.
const ROLE_OPTIONS = {
  worker: { max: 4 },
  api: { max: 2, supervise: false, schedule: false },
} as const

// Memoizes the start() promise, not just the instance — concurrent callers
// during startup must share the same in-flight start, or pg-boss would run
// its schema migration twice. A failed start clears the memo so the next
// caller retries instead of being wedged on a rejected promise forever.
export async function getBoss(role: 'api' | 'worker'): Promise<PgBoss> {
  if (!bossPromise) {
    const connectionString = env.DATABASE_URL
    if (!connectionString) {
      throw new Error(
        'DATABASE_URL is not set — pg-boss needs a direct Postgres connection ' +
          '(Supabase session-mode pooler, port 5432; transaction mode 6543 will not work)',
      )
    }
    const boss = new PgBoss({ connectionString, ...ROLE_OPTIONS[role] })
    // pg-boss emits 'error' for background maintenance failures; without a
    // listener that crashes the process (EventEmitter semantics).
    boss.on('error', (err) => Sentry.captureException(err))
    bossPromise = boss.start().catch((err: unknown) => {
      bossPromise = undefined
      throw err
    })
  }
  return bossPromise
}

let queuesPromise: Promise<void> | undefined

// Creates every Contract A queue (idempotent). The worker calls this at
// startup; the API send helpers call it lazily so an enqueue never races a
// not-yet-created queue. Memoized like getBoss, cleared on failure.
export async function ensureQueues(role: 'api' | 'worker'): Promise<void> {
  if (!queuesPromise) {
    queuesPromise = (async () => {
      const boss = await getBoss(role)
      await boss.createQueue(JOB_PAYOUT_SUBMIT, { ...SINGLETON_POLICY, ...PAYOUT_SUBMIT_RETRY })
      await boss.createQueue(JOB_PAYMENT_EVENT_PROCESS, {
        ...SINGLETON_POLICY,
        ...PAYMENT_EVENT_RETRY,
      })
      await boss.createQueue(JOB_FUNDING_ONRAMP_PREPARE, {
        ...SINGLETON_POLICY,
        ...ONRAMP_PREPARE_RETRY,
      })
      await boss.createQueue(JOB_PAYOUT_SWEEP, CRON_RETRY)
      await boss.createQueue(JOB_PAYOUT_POLL, CRON_RETRY)
      await boss.createQueue(JOB_RECONCILE_PENDING, CRON_RETRY)
      await boss.createQueue(JOB_IDEMPOTENCY_PURGE, CRON_RETRY)
      await boss.createQueue(JOB_OTP_ATTEMPT_PURGE, CRON_RETRY)
      await boss.createQueue(JOB_LOSS_CORRECTION_WATCH, CRON_RETRY)
      await boss.createQueue(JOB_LEDGER_RECONCILE, CRON_RETRY)
      await boss.createQueue(JOB_STUCK_WATCH, CRON_RETRY)
      await boss.createQueue(JOB_WORKER_HEARTBEAT, CRON_RETRY)
    })().catch((err: unknown) => {
      queuesPromise = undefined
      throw err
    })
  }
  return queuesPromise
}

// singletonKey = transferId: at most one queued/active submit per transfer,
// so webhook enqueue + sweep re-enqueue can never double-submit.
export async function enqueuePayoutSubmit(
  transferId: string,
  role: 'api' | 'worker',
): Promise<string | null> {
  await ensureQueues(role)
  const boss = await getBoss(role)
  const payload: PayoutSubmitPayload = { transferId }
  const options: SendOptions = { singletonKey: transferId, ...PAYOUT_SUBMIT_RETRY }
  return boss.send(JOB_PAYOUT_SUBMIT, payload, options)
}

// singletonKey = paymentEventId: webhook enqueue + sweep re-enqueue of stale
// 'received' events collapse to one processing job per event.
export async function enqueuePaymentEventProcess(
  paymentEventId: string,
  role: 'api' | 'worker',
): Promise<string | null> {
  await ensureQueues(role)
  const boss = await getBoss(role)
  const payload: PaymentEventProcessPayload = { paymentEventId }
  const options: SendOptions = { singletonKey: paymentEventId, ...PAYMENT_EVENT_RETRY }
  return boss.send(JOB_PAYMENT_EVENT_PROCESS, payload, options)
}

// singletonKey = transferId: a confirm-retry re-enqueue while a prepare job is
// queued collapses to one; the job itself is an idempotent replay either way
// (skips when instructions exist; the Bridge POST is idempotency-keyed).
export async function enqueueFundingOnrampPrepare(
  transferId: string,
  role: 'api' | 'worker',
): Promise<string | null> {
  await ensureQueues(role)
  const boss = await getBoss(role)
  const payload: FundingOnrampPreparePayload = { transferId }
  const options: SendOptions = { singletonKey: transferId, ...ONRAMP_PREPARE_RETRY }
  return boss.send(JOB_FUNDING_ONRAMP_PREPARE, payload, options)
}

// Releases the pg-boss connection pool and clears the memos.
//
// Long-lived processes shut down through worker.ts's signal handler; this
// exists for SHORT-LIVED ones — the operator scripts. `applyFundingSucceeded`
// enqueues payout.submit, which lazily opens a pool that nothing in a one-shot
// process ever closes, so the script sat at the terminal indefinitely after its
// work was already committed (#196). Never starts an instance that does not
// already exist: a dry run, or a `--kind cleared` that touches no queue, must
// stay a no-op rather than open a pool just to close it.
//
// graceful: false because a send-only process has no in-flight work to drain —
// waiting out the 30s graceful timeout would be the same hang with a deadline.
export async function stopBoss(): Promise<void> {
  const started = bossPromise
  if (!started) return
  bossPromise = undefined
  queuesPromise = undefined
  const boss = await started
  await boss.stop({ graceful: false })
}
