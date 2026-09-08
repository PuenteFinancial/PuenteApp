// stopBoss — the one-shot-process shutdown seam (#196). The rest of the
// module's behavior is covered against a real Postgres in queue.db.test.ts;
// this file exists because the bug it fixes is about a HANDLE that outlives
// the work, which no round-trip test can observe.
import { describe, it, expect, beforeEach, vi } from 'vitest'

const stop = vi.fn().mockResolvedValue(undefined)
const send = vi.fn().mockResolvedValue('job-1')
const createQueue = vi.fn().mockResolvedValue(undefined)
const updateQueue = vi.fn().mockResolvedValue(undefined)
const constructed = vi.fn()

vi.mock('pg-boss', () => ({
  PgBoss: class {
    constructor(options: unknown) {
      constructed(options)
    }
    on() {}
    // The real start() resolves to the instance; getBoss memoizes that promise.
    start() {
      return Promise.resolve(this)
    }
    stop = stop
    send = send
    createQueue = createQueue
    updateQueue = updateQueue
  },
}))

vi.mock('../config/env.js', () => ({
  env: { DATABASE_URL: 'postgresql://user:pw@127.0.0.1:5432/postgres' },
}))

vi.mock('@sentry/node', () => ({ captureException: vi.fn() }))

const { stopBoss, enqueuePayoutSubmit, ALL_QUEUES } = await import('./queue.js')

beforeEach(() => {
  constructed.mockClear()
  stop.mockClear()
})

describe('stopBoss', () => {
  // The scripts call this unconditionally. A dry run — or a `--kind cleared`
  // that touches no queue — must not open a pool purely to close it.
  it('is a no-op when no instance was ever started', async () => {
    await stopBoss()

    expect(constructed).not.toHaveBeenCalled()
    expect(stop).not.toHaveBeenCalled()
  })

  it('stops a started instance non-gracefully — a send-only process has no work to drain', async () => {
    await enqueuePayoutSubmit('transfer-1', 'api')
    expect(constructed).toHaveBeenCalledTimes(1)

    await stopBoss()

    expect(stop).toHaveBeenCalledWith({ graceful: false })
  })

  it('clears the memo so a later enqueue builds a fresh instance rather than reusing the stopped one', async () => {
    await enqueuePayoutSubmit('transfer-2', 'api')

    expect(constructed).toHaveBeenCalledTimes(1)
    expect(createQueue).toHaveBeenCalled()
  })
})

describe('LISTEN/NOTIFY wiring (Supabase egress — 96.7% of it was queue polling)', () => {
  // Last in the file on purpose: these enqueue, which constructs and memoizes
  // an instance, and the stopBoss cases above assert against a process that
  // has never started one.
  it('turns NOTIFY on for EVERY queue via updateQueue, not just at creation', async () => {
    await stopBoss()
    updateQueue.mockClear()

    await enqueuePayoutSubmit('t-notify-1', 'worker')

    // createQueue is ON CONFLICT DO NOTHING, so on staging and production —
    // where every queue row already exists — passing `notify` at creation is
    // silently ignored. updateQueue is the only call that reaches an existing
    // row. Without this the change ships, looks correct, and moves no egress
    // whatsoever; that failure mode is invisible, which is why it is pinned.
    const updated = updateQueue.mock.calls.map((c) => c[0] as string)
    expect(new Set(updated)).toEqual(new Set(ALL_QUEUES))
    for (const call of updateQueue.mock.calls) {
      expect(call[1]).toMatchObject({ notify: true })
    }
  })

  it('gives the worker a listener and the send-only API none', async () => {
    // `useListenNotify` holds a dedicated connection open for LISTEN. The
    // worker needs it — it is the process being woken. The API never works a
    // queue (NOTIFY is emitted by the queue on job creation regardless of who
    // sent it), so a listener there would cost a connection and buy nothing.
    await stopBoss()
    constructed.mockClear()
    await enqueuePayoutSubmit('t-notify-worker', 'worker')
    const workerOpts = constructed.mock.calls.at(-1)?.[0] as Record<string, unknown>
    expect(workerOpts.useListenNotify).toBe(true)

    await stopBoss()
    constructed.mockClear()
    await enqueuePayoutSubmit('t-notify-api', 'api')
    const apiOpts = constructed.mock.calls.at(-1)?.[0] as Record<string, unknown>
    expect(apiOpts.supervise).toBe(false)
    expect(apiOpts.useListenNotify).toBeUndefined()
  })
})
