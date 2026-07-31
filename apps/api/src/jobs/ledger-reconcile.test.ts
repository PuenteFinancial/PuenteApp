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
