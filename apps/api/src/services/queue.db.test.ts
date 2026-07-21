// pg-boss round-trip against a real local Supabase Postgres (Docker).
// Gated like ledger.db.test.ts: runs only with RUN_DB_TESTS=1. Uses a raw
// PgBoss instance on TEST_DB_URL rather than getBoss() — the singleton reads
// env.DATABASE_URL, and this test must not depend on process-wide state.
// First start() installs the pgboss schema into the local DB; that is the
// same migration the worker runs on first boot, so it doubles as a check
// that pg-boss can install against our Postgres.
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { PgBoss } from 'pg-boss'

const runDb = process.env.RUN_DB_TESTS === '1'

const DB_URL = process.env.TEST_DB_URL ?? 'postgresql://postgres:postgres@127.0.0.1:54322/postgres'

interface TestPayload {
  transferId: string
}

describe.skipIf(!runDb)('pg-boss round-trip (integration, local Supabase)', () => {
  let boss: PgBoss
  // Unique per run — a leftover queue from an aborted run must not collide.
  const QUEUE = `queue-db-test-${Date.now()}`

  beforeAll(async () => {
    boss = new PgBoss(DB_URL)
    // Background maintenance errors surface via 'error'; without a listener
    // an emit would crash the test process instead of failing an assertion.
    boss.on('error', (err) => console.error('pg-boss error', err))
    await boss.start()
  }, 60_000) // first start runs the pg-boss schema install

  afterAll(async () => {
    await boss.deleteQueue(QUEUE).catch(() => undefined)
    await boss.stop()
  }, 30_000)

  it(
    'creates a queue, dedupes on singletonKey, and delivers the payload to work()',
    async () => {
      // 'stately' mirrors the real payout.submit / payment-event.process
      // queues — singletonKey dedupe is only enforced under a non-standard
      // policy in pg-boss v12.
      await boss.createQueue(QUEUE, { policy: 'stately' })
      // createQueue is ON CONFLICT DO NOTHING — a second call must not throw.
      await boss.createQueue(QUEUE, { policy: 'stately' })

      const firstId = await boss.send(QUEUE, { transferId: 't-1' } satisfies TestPayload, {
        singletonKey: 't-1',
      })
      expect(firstId).toBeTruthy()

      // Same singletonKey while the first job is still queued → dropped.
      const dupId = await boss.send(QUEUE, { transferId: 't-1' } satisfies TestPayload, {
        singletonKey: 't-1',
      })
      expect(dupId).toBeNull()

      const received: TestPayload[] = []
      const delivered = new Promise<void>((resolve) => {
        void boss.work<TestPayload>(QUEUE, async (jobs) => {
          received.push(...jobs.map((j) => j.data))
          resolve()
        })
      })
      await delivered

      expect(received).toEqual([{ transferId: 't-1' }])
    },
    30_000,
  )
})
