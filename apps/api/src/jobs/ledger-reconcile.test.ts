import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

// The O2 orchestrator: registry mocked, so these tests pin the run semantics —
// one check failing never sinks the others, the run row always persists with
// the right status, and every finding pages with the (check, key) fingerprint
// at the check's severity. The checks themselves are covered in
// services/reconciliation.test.ts.

const buildChecks = vi.hoisted(() => vi.fn())
vi.mock('../services/reconciliation.js', () => ({
  buildChecks: (...args: unknown[]) => buildChecks(...args),
}))

const insert = vi.fn()
const from = vi.fn()
vi.mock('../services/supabase.js', () => ({
  supabaseAdmin: {
    from: (...args: unknown[]) => from(...args),
  },
}))

// The ack SERVICE is covered in services/reconciliation-ack.test.ts. Here only the LOAD is
// mocked — partitionFindings stays real, because "a fatal check is never suppressed" is a runner
// guarantee and mocking the function that enforces it would test nothing.
const loadActiveAcknowledgements = vi.hoisted(() => vi.fn())
vi.mock('../services/reconciliation-ack.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../services/reconciliation-ack.js')>()),
  loadActiveAcknowledgements: (...args: unknown[]) => loadActiveAcknowledgements(...args),
}))

const captureMessage = vi.hoisted(() => vi.fn())
const setFingerprint = vi.hoisted(() => vi.fn())
const setContext = vi.hoisted(() => vi.fn())
vi.mock('@sentry/node', () => ({
  withScope: (fn: (s: unknown) => void) => fn({ setFingerprint, setContext }),
  captureMessage: (...a: unknown[]) => captureMessage(...a),
}))

const { reconcileLedger } = await import('./ledger-reconcile.js')

type Outcome = {
  status: 'pass' | 'findings' | 'skipped' | 'error'
  findings: Array<{ key: string; detail: Record<string, unknown> }>
  summary?: Record<string, unknown>
  balances?: Record<string, { amount_minor: number; currency: string }>
}

const mkCheck = (
  name: string,
  severity: 'fatal' | 'error' | 'warning',
  outcome: Outcome | Error,
) => ({
  name,
  severity,
  runbook: 'docs/runbooks/reconciliation.md',
  run: vi.fn(
    outcome instanceof Error ? () => Promise.reject(outcome) : () => Promise.resolve(outcome),
  ),
})

const pass: Outcome = { status: 'pass', findings: [] }

// noUncheckedIndexedAccess-safe read of the single persisted run row.
const insertedRow = () => insert.mock.calls[0]?.[0] as Record<string, unknown>

let errorSpy: ReturnType<typeof vi.spyOn>
let warnSpy: ReturnType<typeof vi.spyOn>

beforeEach(() => {
  buildChecks.mockReset()
  loadActiveAcknowledgements.mockReset().mockResolvedValue(new Map())
  insert.mockReset().mockResolvedValue({ error: null })
  from.mockReset().mockImplementation((table: string) => {
    if (table === 'reconciliation_runs') return { insert }
    throw new Error(`unexpected supabase.from('${table}')`)
  })
  captureMessage.mockReset()
  setFingerprint.mockReset()
  setContext.mockReset()
  errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
  warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
})

afterEach(() => {
  errorSpy.mockRestore()
  warnSpy.mockRestore()
})

describe('reconcileLedger', () => {
  it('a clean run persists a pass row, pages nothing, returns 0', async () => {
    buildChecks.mockReturnValue([mkCheck('a', 'fatal', pass), mkCheck('b', 'warning', pass)])

    await expect(reconcileLedger()).resolves.toBe(0)

    expect(captureMessage).not.toHaveBeenCalled()
    // Clean runs leave stdout to handle()'s count line — no warn evidence.
    expect(warnSpy).not.toHaveBeenCalled()
    expect(insert).toHaveBeenCalledTimes(1)
    const row = insertedRow()
    expect(row).toMatchObject({
      status: 'pass',
      findings_count: 0,
      checks: [
        { name: 'a', status: 'pass', findings_count: 0 },
        { name: 'b', status: 'pass', findings_count: 0 },
      ],
      balances: {},
    })
    expect(typeof row.started_at).toBe('string')
    expect(typeof row.finished_at).toBe('string')
  })

  it('pages each finding with the (check, key) fingerprint at the check severity', async () => {
    buildChecks.mockReturnValue([
      mkCheck('ledger_net_zero', 'fatal', {
        status: 'findings',
        findings: [{ key: 'net-zero:tx-1:USD', detail: { ledgerTransactionId: 'tx-1' } }],
      }),
      mkCheck('transfer_aging', 'warning', {
        status: 'findings',
        findings: [
          { key: 'aging:funded-unheld-stuck:t-1', detail: { transferId: 't-1' } },
          { key: 'aging:under-review-aging:t-2', detail: { transferId: 't-2' } },
        ],
      }),
    ])

    await expect(reconcileLedger()).resolves.toBe(3)

    expect(captureMessage).toHaveBeenCalledTimes(3)
    expect(setFingerprint).toHaveBeenNthCalledWith(1, [
      'reconcile',
      'ledger_net_zero',
      'net-zero:tx-1:USD',
    ])
    expect(captureMessage).toHaveBeenNthCalledWith(
      1,
      'reconciliation: ledger_net_zero — net-zero:tx-1:USD',
      'fatal',
    )
    expect(setContext).toHaveBeenNthCalledWith(1, 'reconciliation_finding', {
      ledgerTransactionId: 'tx-1',
      check: 'ledger_net_zero',
      runbook: 'docs/runbooks/reconciliation.md',
    })
    expect(captureMessage).toHaveBeenNthCalledWith(
      2,
      'reconciliation: transfer_aging — aging:funded-unheld-stuck:t-1',
      'warning',
    )
    expect(insertedRow()).toMatchObject({ status: 'findings', findings_count: 3 })
  })

  it('one check throwing never sinks the rest — it becomes an error outcome and pages', async () => {
    const survivor = mkCheck('bridge_orphans', 'error', {
      status: 'findings',
      findings: [{ key: 'bridge-orphan:bt-1', detail: { bridgeTransferId: 'bt-1' } }],
    })
    buildChecks.mockReturnValue([
      mkCheck('bridge_wallet_float', 'warning', new Error('bridge 502')),
      survivor,
    ])

    await expect(reconcileLedger()).resolves.toBe(1)

    expect(survivor.run).toHaveBeenCalledTimes(1)
    expect(setFingerprint).toHaveBeenCalledWith(['reconcile-check-error', 'bridge_wallet_float'])
    expect(captureMessage).toHaveBeenCalledWith(
      'reconciliation: bridge_wallet_float could not complete',
      'error',
    )
    // Message-only logging (worker convention — no error objects on stdout).
    expect(errorSpy).toHaveBeenCalledWith(
      'worker: ledger.reconcile check bridge_wallet_float failed: bridge 502',
    )
    // Non-pass runs leave local evidence beside the Sentry pages.
    expect(warnSpy).toHaveBeenCalledWith(
      'worker: ledger.reconcile error — 1 finding(s) across 2 check(s)',
    )
    const row = insertedRow()
    expect(row).toMatchObject({
      status: 'error',
      findings_count: 1,
      checks: [
        { name: 'bridge_wallet_float', status: 'error', findings_count: 0, error: 'bridge 502' },
        { name: 'bridge_orphans', status: 'findings', findings_count: 1 },
      ],
    })
  })

  it('a check RETURNING status error (partial sweep) marks the run error AND pages', async () => {
    buildChecks.mockReturnValue([
      mkCheck('stripe_receivables', 'error', {
        status: 'error',
        findings: [],
        summary: { readFailures: 1, firstReadFailure: 'stripe timeout' },
      }),
    ])

    await reconcileLedger()

    expect(insertedRow()).toMatchObject({ status: 'error', findings_count: 0 })
    // A quiet run row is not an alert (codex-review finding): a returned
    // error outcome pages exactly like a thrown one, carrying the first
    // underlying failure message.
    expect(setFingerprint).toHaveBeenCalledWith(['reconcile-check-error', 'stripe_receivables'])
    expect(setContext).toHaveBeenCalledWith('reconciliation_check_error', {
      check: 'stripe_receivables',
      runbook: 'docs/runbooks/reconciliation.md',
      message: 'stripe timeout',
    })
    expect(captureMessage).toHaveBeenCalledWith(
      'reconciliation: stripe_receivables could not complete',
      'error',
    )
  })

  it('skipped checks record their reason and keep the run status pass', async () => {
    buildChecks.mockReturnValue([
      mkCheck('stripe_orphans', 'error', {
        status: 'skipped',
        findings: [],
        summary: { reason: 'funding processor is not stripe' },
      }),
    ])

    await reconcileLedger()

    expect(insertedRow()).toMatchObject({
      status: 'pass',
      checks: [
        {
          name: 'stripe_orphans',
          status: 'skipped',
          summary: { reason: 'funding processor is not stripe' },
        },
      ],
    })
  })

  it('the account_balances snapshot rides into the run row', async () => {
    buildChecks.mockReturnValue([
      mkCheck('account_balances', 'fatal', {
        status: 'pass',
        findings: [],
        balances: { funding_receivable: { amount_minor: 500, currency: 'USD' } },
      }),
    ])

    await reconcileLedger()

    expect(insertedRow()).toMatchObject({
      balances: { funding_receivable: { amount_minor: 500, currency: 'USD' } },
    })
  })

  it('throws when the run row cannot be persisted — a broken audit write is loud', async () => {
    buildChecks.mockReturnValue([mkCheck('a', 'fatal', pass)])
    insert.mockResolvedValue({ error: { message: 'insert denied' } })

    await expect(reconcileLedger()).rejects.toThrow(/reconciliation_runs insert failed: insert denied/)
  })
})

// ── acknowledgements ────────────────────────────────────────────────────────
// The runner's three guarantees. The service's own rules (expiry, fatal refusal at write time,
// duplicate refusal) live in services/reconciliation-ack.test.ts.
//
// Keys are built with the REAL ackKey rather than a hand-written separator: hardcoding it here
// would let the runner and the service drift apart with every test still green.
const { ackKey } = await import('../services/reconciliation-ack.js')

describe('reconcileLedger acknowledgements', () => {
  const ack = (checkName: string, findingKey: string) => ({
    id: 'ack-1',
    checkName,
    findingKey,
    actor: 'ops:someone',
    note: 'investigated, predates the loss path',
    expiresAt: '2099-01-01T00:00:00.000Z',
    revokedAt: null,
    createdAt: '2026-09-15T00:00:00.000Z',
  })
  const finding = (key: string) => ({ key, detail: {} })
  const activeFor = (checkName: string, findingKey: string) =>
    new Map([[ackKey(checkName, findingKey), ack(checkName, findingKey)]])

  it('an acknowledged finding does not page, and the run passes', async () => {
    loadActiveAcknowledgements.mockResolvedValue(activeFor('stripe_disputes', 'dispute:du_1'))
    buildChecks.mockReturnValue([
      mkCheck('stripe_disputes', 'error', {
        status: 'findings',
        findings: [finding('dispute:du_1')],
      }),
    ])

    await expect(reconcileLedger()).resolves.toBe(0)

    expect(captureMessage).not.toHaveBeenCalled()
    expect(insertedRow()).toMatchObject({
      status: 'pass',
      findings_count: 0,
      acknowledged_count: 1,
      checks: [{ name: 'stripe_disputes', findings_count: 0, acknowledged_count: 1 }],
    })
  })

  it('a clean-looking run says so on stdout when something is only silent', async () => {
    loadActiveAcknowledgements.mockResolvedValue(activeFor('stripe_disputes', 'dispute:du_1'))
    buildChecks.mockReturnValue([
      mkCheck('stripe_disputes', 'error', {
        status: 'findings',
        findings: [finding('dispute:du_1')],
      }),
    ])

    await reconcileLedger()

    // The whole point: a pass that is only a pass because something is muted must not read like
    // an empty one on the Railway stream.
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('1 acknowledged'))
  })

  it('only the acknowledged key is suppressed — its neighbours still page', async () => {
    loadActiveAcknowledgements.mockResolvedValue(activeFor('stripe_disputes', 'dispute:du_1'))
    buildChecks.mockReturnValue([
      mkCheck('stripe_disputes', 'error', {
        status: 'findings',
        findings: [finding('dispute:du_1'), finding('dispute:du_2')],
      }),
    ])

    await expect(reconcileLedger()).resolves.toBe(1)

    expect(captureMessage).toHaveBeenCalledTimes(1)
    expect(captureMessage).toHaveBeenCalledWith(
      'reconciliation: stripe_disputes — dispute:du_2',
      'error',
    )
    expect(insertedRow()).toMatchObject({
      status: 'findings',
      findings_count: 1,
      acknowledged_count: 1,
    })
  })

  it('an acknowledgement for one check never silences the same key on another', async () => {
    loadActiveAcknowledgements.mockResolvedValue(activeFor('stripe_disputes', 'shared-key'))
    buildChecks.mockReturnValue([
      mkCheck('bridge_orphans', 'error', { status: 'findings', findings: [finding('shared-key')] }),
    ])

    await expect(reconcileLedger()).resolves.toBe(1)
    expect(captureMessage).toHaveBeenCalledWith(
      'reconciliation: bridge_orphans — shared-key',
      'error',
    )
  })

  it('a FATAL check is never suppressed, even with a row saying otherwise', async () => {
    loadActiveAcknowledgements.mockResolvedValue(activeFor('ledger_net_zero', 'imbalance'))
    buildChecks.mockReturnValue([
      mkCheck('ledger_net_zero', 'fatal', { status: 'findings', findings: [finding('imbalance')] }),
    ])

    await expect(reconcileLedger()).resolves.toBe(1)

    expect(captureMessage).toHaveBeenCalledWith(
      'reconciliation: ledger_net_zero — imbalance',
      'fatal',
    )
    expect(insertedRow()).toMatchObject({
      status: 'findings',
      findings_count: 1,
      acknowledged_count: 0,
    })
  })

  it('an unreadable acknowledgements table FAILS OPEN — everything pages, loudly', async () => {
    loadActiveAcknowledgements.mockRejectedValue(new Error('select denied'))
    buildChecks.mockReturnValue([
      mkCheck('stripe_disputes', 'error', {
        status: 'findings',
        findings: [finding('dispute:du_1')],
      }),
    ])

    await expect(reconcileLedger()).resolves.toBe(1)

    // The finding pages...
    expect(captureMessage).toHaveBeenCalledWith(
      'reconciliation: stripe_disputes — dispute:du_1',
      'error',
    )
    // ...and so does the fact that suppression was not applied. A silently-disabled suppression
    // layer looks exactly like a system with nothing acknowledged.
    expect(captureMessage).toHaveBeenCalledWith(
      'reconciliation: acknowledgements unreadable — every finding paged',
      'error',
    )
    expect(insertedRow()).toMatchObject({ status: 'error' })
  })

  it('acknowledged_count is omitted per-check when nothing was silenced', async () => {
    buildChecks.mockReturnValue([mkCheck('a', 'warning', pass)])

    await reconcileLedger()

    const row = insertedRow()
    expect(row['acknowledged_count']).toBe(0)
    expect((row['checks'] as Array<Record<string, unknown>>)[0]).not.toHaveProperty(
      'acknowledged_count',
    )
  })
})
