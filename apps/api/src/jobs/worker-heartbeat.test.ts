import { describe, it, expect, beforeEach, vi } from 'vitest'

const from = vi.fn()

vi.mock('../services/supabase.js', () => ({
  supabaseAdmin: {
    from: (...args: unknown[]) => from(...args),
  },
}))

// No @sentry/node mock: the check-in is wired at the registration site in
// worker.ts, not inside this module. That seam is what keeps the job testable
// without stubbing Sentry, and stops a stray manual call of this function from
// emitting a check-in that would make a dead cron look alive.
const { recordWorkerHeartbeat, WORKER_HEARTBEAT_MONITOR, WORKER_HEARTBEAT_MONITOR_SLUG } =
  await import('./worker-heartbeat.js')
const { WORKER_HEARTBEAT_CRON } = await import('../services/queue.js')

function mockUpsert(result: { data: unknown; error: unknown }) {
  const select = vi.fn().mockResolvedValue(result)
  const upsert = vi.fn().mockReturnValue({ select })
  from.mockReturnValue({ upsert })
  return { upsert, select }
}

beforeEach(() => {
  from.mockReset()
})

describe('recordWorkerHeartbeat', () => {
  it('upserts the worker row keyed on `worker` and returns the rows written', async () => {
    const { upsert, select } = mockUpsert({ data: [{ worker: 'worker' }], error: null })

    const count = await recordWorkerHeartbeat()

    expect(count).toBe(1)
    expect(from).toHaveBeenCalledWith('worker_heartbeat')
    expect(upsert).toHaveBeenCalledWith(
      { worker: 'worker', instance: null },
      { onConflict: 'worker' },
    )
    // The returning representation is load-bearing, not decoration — see the
    // zero-row case below.
    expect(select).toHaveBeenCalledWith('worker')
  })

  it('never sends updated_at — the database owns the beat clock', async () => {
    const { upsert } = mockUpsert({ data: [{ worker: 'worker' }], error: null })

    await recordWorkerHeartbeat()

    // Assert the call happened before inspecting it — `expect(undefined).not
    // .toHaveProperty(...)` would pass vacuously and this test would silently
    // stop guarding anything.
    expect(upsert).toHaveBeenCalledTimes(1)
    // If a future edit "helpfully" stamps updated_at here, the moddatetime
    // trigger stops being the source of truth and a worker with a skewed clock
    // could report itself recently alive while dead — the one direction this
    // signal must never fail in.
    expect(upsert.mock.calls[0]![0]).not.toHaveProperty('updated_at')
  })

  it('writes `instance` on every beat so the upsert is a real UPDATE', async () => {
    const { upsert } = mockUpsert({ data: [{ worker: 'worker' }], error: null })

    await recordWorkerHeartbeat()

    expect(upsert).toHaveBeenCalledTimes(1)
    // A key-only upsert would not update a non-key column, and the
    // before-update trigger is what advances updated_at. Dropping this field
    // would silently freeze the beat after the first write.
    expect(upsert.mock.calls[0]![0]).toHaveProperty('instance')
  })

  it('throws when the upsert errors', async () => {
    mockUpsert({ data: null, error: { message: 'connection terminated' } })

    await expect(recordWorkerHeartbeat()).rejects.toThrow(
      /worker heartbeat upsert failed: connection terminated/,
    )
  })

  it('throws when the write affected no rows', async () => {
    mockUpsert({ data: [], error: null })

    // A liveness signal that can pass without writing anything is not a
    // liveness signal — a silent zero-row write must fail the beat.
    await expect(recordWorkerHeartbeat()).rejects.toThrow(
      /worker heartbeat upsert wrote 0 row\(s\), expected 1/,
    )
  })

  it('throws when data comes back null despite no error', async () => {
    mockUpsert({ data: null, error: null })

    await expect(recordWorkerHeartbeat()).rejects.toThrow(/wrote 0 row\(s\), expected 1/)
  })
})

describe('WORKER_HEARTBEAT_MONITOR', () => {
  it('declares the same cadence pg-boss schedules', () => {
    // The only automated defense against changing the cron in one place. A
    // monitor whose crontab disagrees with the real cadence either alerts
    // constantly or never alerts — and "never" looks identical to healthy.
    expect(WORKER_HEARTBEAT_MONITOR.schedule).toEqual({
      type: 'crontab',
      value: WORKER_HEARTBEAT_CRON,
    })
  })

  it('pins the alerting thresholds', () => {
    expect(WORKER_HEARTBEAT_MONITOR_SLUG).toBe('worker-heartbeat')
    // 3 misses × 5 min + 2 min margin ≈ 17 min to detection. Retuning these is
    // fine — doing it by accident is not.
    expect(WORKER_HEARTBEAT_MONITOR.failureIssueThreshold).toBe(3)
    expect(WORKER_HEARTBEAT_MONITOR.recoveryThreshold).toBe(1)
    expect(WORKER_HEARTBEAT_MONITOR.checkinMargin).toBe(2)
    expect(WORKER_HEARTBEAT_MONITOR.maxRuntime).toBe(2)
    expect(WORKER_HEARTBEAT_MONITOR.timezone).toBe('UTC')
  })
})
