// stopBoss — the one-shot-process shutdown seam (#196). The rest of the
// module's behavior is covered against a real Postgres in queue.db.test.ts;
// this file exists because the bug it fixes is about a HANDLE that outlives
// the work, which no round-trip test can observe.
import { describe, it, expect, beforeEach, vi } from 'vitest'

const stop = vi.fn().mockResolvedValue(undefined)
const send = vi.fn().mockResolvedValue('job-1')
const createQueue = vi.fn().mockResolvedValue(undefined)
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
  },
}))

vi.mock('../config/env.js', () => ({
  env: { DATABASE_URL: 'postgresql://user:pw@127.0.0.1:5432/postgres' },
}))

vi.mock('@sentry/node', () => ({ captureException: vi.fn() }))

const { stopBoss, enqueuePayoutSubmit } = await import('./queue.js')

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
