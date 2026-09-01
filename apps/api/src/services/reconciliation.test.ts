import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

// The O2 checks registry. Harness mirrors correction-watch.test.ts: per-query
// chain mocks + frozen clock. The pure helpers (aging buckets, PI status
// classification, par parsing) are tested directly; each registry check is
// tested through buildChecks() so the wiring (names, severities, skip gates,
// fail-closed reads) is part of the contract.

const from = vi.fn()
const rpc = vi.fn()
vi.mock('./supabase.js', () => ({
  supabaseAdmin: {
    from: (...args: unknown[]) => from(...args),
    rpc: (...args: unknown[]) => rpc(...args),
  },
}))

const envMock = vi.hoisted(() => ({
  BRIDGE_TREASURY_WALLET_ID: 'wallet-1' as string | undefined,
  FUNDING_PROCESSOR: 'mock' as string,
  MANUAL_PENDING_MAX_AGE_DAYS: 7,
}))
vi.mock('../config/env.js', () => ({ env: envMock }))

const getAccountBalance = vi.hoisted(() => vi.fn())
vi.mock('./ledger.js', () => ({
  getAccountBalance: (...args: unknown[]) => getAccountBalance(...args),
}))

const listBridgeTransfers = vi.hoisted(() => vi.fn())
const getBridgeWalletBalances = vi.hoisted(() => vi.fn())
vi.mock('./bridge.js', () => ({
  listBridgeTransfers: (...args: unknown[]) => listBridgeTransfers(...args),
  getBridgeWalletBalances: (...args: unknown[]) => getBridgeWalletBalances(...args),
}))

const getFundingProcessor = vi.hoisted(() => vi.fn())
vi.mock('./funding/index.js', () => ({
  getFundingProcessor: (...args: unknown[]) => getFundingProcessor(...args),
}))

const pollPayouts = vi.hoisted(() => vi.fn())
vi.mock('../jobs/payout-poll.js', () => ({
  pollPayouts: (...args: unknown[]) => pollPayouts(...args),
}))

const { buildChecks, agingFindings, parMinorFromDecimal, classifyStripeStatus } =
  await import('./reconciliation.js')

const check = (name: string) => {
  const found = buildChecks().find((c) => c.name === name)
  if (!found) throw new Error(`no check named ${name}`)
  return found
}

// Supabase query builders are thenables — one chain object whose every
// builder method returns itself, resolving to `result` when awaited.
function chainResolving(result: { data: unknown; error: unknown }) {
  const c: Record<string, unknown> = {}
  for (const method of ['select', 'or', 'limit', 'like', 'in', 'eq']) {
    c[method] = vi.fn().mockReturnValue(c)
  }
  c['then'] = (resolve: (v: unknown) => unknown, reject: (e: unknown) => unknown) =>
    Promise.resolve(result).then(resolve, reject)
  return c as Record<string, ReturnType<typeof vi.fn>> & PromiseLike<unknown>
}

const NOW = new Date('2026-07-31T06:00:00.000Z')
const nowMs = NOW.getTime()
const hoursAgo = (h: number) => new Date(nowMs - h * 3600_000).toISOString()
const daysAgo = (d: number) => hoursAgo(d * 24)

beforeEach(() => {
  from.mockReset()
  rpc.mockReset()
  getAccountBalance.mockReset()
  listBridgeTransfers.mockReset()
  getBridgeWalletBalances.mockReset()
  getFundingProcessor.mockReset()
  pollPayouts.mockReset()
  envMock.BRIDGE_TREASURY_WALLET_ID = 'wallet-1'
  envMock.FUNDING_PROCESSOR = 'mock'
  envMock.MANUAL_PENDING_MAX_AGE_DAYS = 7
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(NOW)
})

afterEach(() => {
  vi.useRealTimers()
})

// ── Pure helpers ────────────────────────────────────────────────────────────

describe('parMinorFromDecimal', () => {
  it('converts decimal balance strings at par, in string math', () => {
    expect(parMinorFromDecimal('5.69')).toEqual({ minor: 569, dustDropped: false })
    expect(parMinorFromDecimal('0.0')).toEqual({ minor: 0, dustDropped: false })
    expect(parMinorFromDecimal('17')).toEqual({ minor: 1700, dustDropped: false })
    expect(parMinorFromDecimal('0.5')).toEqual({ minor: 50, dustDropped: false })
  })

  it('drops sub-cent dust but reports it', () => {
    expect(parMinorFromDecimal('5.123456')).toEqual({ minor: 512, dustDropped: true })
    expect(parMinorFromDecimal('5.1200')).toEqual({ minor: 512, dustDropped: false })
  })

  it('refuses anything that is not a plain non-negative decimal', () => {
    for (const bad of ['-1.00', '1e3', 'NaN', '', '1.2.3', ' 5.69']) {
      expect(() => parMinorFromDecimal(bad)).toThrow(/unparseable/)
    }
  })
})

describe('agingFindings', () => {
  const row = (over: Partial<Parameters<typeof agingFindings>[0][number]>) => ({
    id: 't-1',
    state: 'FUNDED',
    created_at: hoursAgo(1),
    payment_at: hoursAgo(1),
    submit_attempted_at: null,
    completed_at: null,
    refund_payment_ref: null,
    payout_hold_reason: null,
    payout_held_at: null,
    funding_cleared: false,
    ...over,
  })

  it('flags PENDING_PAYMENT older than the auto-fail window (reconcile-pending is dead)', () => {
    const fresh = row({ state: 'PENDING_PAYMENT', created_at: hoursAgo(0.5), payment_at: null })
    const stale = row({ id: 't-2', state: 'PENDING_PAYMENT', created_at: hoursAgo(1), payment_at: null })
    const findings = agingFindings([fresh, stale], nowMs)
    expect(findings).toHaveLength(1)
    expect(findings[0]).toMatchObject({
      key: 'aging:pending-payment-autofail-dead:t-2',
      detail: { transferId: 't-2', state: 'PENDING_PAYMENT', ageHours: 1 },
    })
  })

  // #216: the manual rail's PENDING_PAYMENT clock is days (a sender mid-wire
  // is NORMAL), so the aging bound must follow the reaper's own window — the
  // 40-minute webhook bound would page every real out-of-band sender.
  it('manual rail: leaves a days-old PENDING_PAYMENT alone inside the reaper window', () => {
    envMock.FUNDING_PROCESSOR = 'manual'
    const midWire = row({ state: 'PENDING_PAYMENT', created_at: hoursAgo(48), payment_at: null })
    expect(agingFindings([midWire], nowMs)).toHaveLength(0)
  })

  it('manual rail: flags PENDING_PAYMENT past the reaper window + grace (reaper is dead)', () => {
    envMock.FUNDING_PROCESSOR = 'manual'
    const reaperDead = row({
      id: 't-dead',
      state: 'PENDING_PAYMENT',
      created_at: hoursAgo(7 * 24 + 7), // 7-day window + 6h grace, exceeded
      payment_at: null,
    })
    const keys = agingFindings([reaperDead], nowMs).map((f) => f.key)
    expect(keys).toEqual(['aging:pending-payment-autofail-dead:t-dead'])
  })

  it('manual rail: the bound tracks MANUAL_PENDING_MAX_AGE_DAYS', () => {
    envMock.FUNDING_PROCESSOR = 'manual'
    envMock.MANUAL_PENDING_MAX_AGE_DAYS = 2
    const pastSmallerWindow = row({
      id: 't-2d',
      state: 'PENDING_PAYMENT',
      created_at: hoursAgo(2 * 24 + 7),
      payment_at: null,
    })
    const insideSmallerWindow = row({
      id: 't-ok',
      state: 'PENDING_PAYMENT',
      created_at: hoursAgo(2 * 24 + 1), // past 2d but inside the 6h grace
      payment_at: null,
    })
    const keys = agingFindings([pastSmallerWindow, insideSmallerWindow], nowMs).map((f) => f.key)
    expect(keys).toEqual(['aging:pending-payment-autofail-dead:t-2d'])
  })

  it('flags unheld FUNDED past 2h but leaves held FUNDED alone until the clearing window', () => {
    const unheldStuck = row({ id: 't-1', payment_at: hoursAgo(3) })
    const heldWaiting = row({ id: 't-2', payment_at: daysAgo(5), payout_hold_reason: 'first_transfer_hold' })
    const heldOverdue = row({ id: 't-3', payment_at: daysAgo(9), payout_hold_reason: 'first_transfer_hold' })
    const keys = agingFindings([unheldStuck, heldWaiting, heldOverdue], nowMs).map((f) => f.key)
    expect(keys).toContain('aging:funded-unheld-stuck:t-1')
    expect(keys).not.toContain('aging:funded-held-overdue:t-2')
    expect(keys).toContain('aging:funded-held-overdue:t-3')
  })

  // A hold set by payout-submit waits on the RUNBOOK, not on the ACH clock.
  // Behind the 8-day clearing window its single page at hold time was the only
  // signal for a week — stuck-watch skips held rows entirely.
  it('flags an ops-actioned hold at 24h, not at the 8-day clearing bound', () => {
    const fresh = row({
      id: 't-1',
      payment_at: daysAgo(9),
      payout_hold_reason: 'submit_error',
      payout_held_at: hoursAgo(23),
    })
    const overdue = row({
      id: 't-2',
      payment_at: daysAgo(9),
      payout_hold_reason: 'submit_error',
      payout_held_at: hoursAgo(25),
    })
    const keys = agingFindings([fresh, overdue], nowMs).map((f) => f.key)
    expect(keys).not.toContain('aging:funded-held-overdue:t-1')
    expect(keys).toContain('aging:funded-held-overdue:t-2')
  })

  it('anchors a hold on the hold stamp, so long-funded rows are not instantly overdue', () => {
    // Pre-fix this flagged immediately: the funding anchor was 9 days old even
    // though ops had held the row a minute earlier.
    // funding_cleared so the unrelated funding-uncleared-overdue bucket, which
    // legitimately fires on a 9-day-old uncleared row, stays out of the way.
    const justHeld = row({
      id: 't-1',
      payment_at: daysAgo(9),
      funding_cleared: true,
      payout_hold_reason: 'payability',
      payout_held_at: hoursAgo(0.02),
    })
    const keys = agingFindings([justHeld], nowMs).map((f) => f.key)
    expect(keys).not.toContain('aging:funded-held-overdue:t-1')
  })

  it('keeps the clearing bound for a hold reason outside the ops set', () => {
    const policy = row({
      id: 't-1',
      payment_at: daysAgo(5),
      funding_cleared: true,
      payout_hold_reason: 'first_transfer_hold',
      payout_held_at: daysAgo(5),
    })
    const keys = agingFindings([policy], nowMs).map((f) => f.key)
    expect(keys).not.toContain('aging:funded-held-overdue:t-1')
  })

  it('flags SUBMITTED/IN_FLIGHT past 24h from funding (SPEI settles in seconds)', () => {
    const inFlight = row({ id: 't-1', state: 'IN_FLIGHT', payment_at: hoursAgo(25) })
    const submitted = row({ id: 't-2', state: 'SUBMITTED', payment_at: hoursAgo(23) })
    const keys = agingFindings([inFlight, submitted], nowMs).map((f) => f.key)
    expect(keys).toContain('aging:payout-in-transit-stuck:t-1')
    expect(keys).not.toContain('aging:payout-in-transit-stuck:t-2')
  })

  it('flags PAYOUT_FAILED with no refund in motion, not one with a persisted undo ref', () => {
    const owed = row({
      id: 't-1',
      state: 'PAYOUT_FAILED',
      created_at: hoursAgo(40),
      payment_at: hoursAgo(30),
    })
    const refunding = row({
      id: 't-2',
      state: 'PAYOUT_FAILED',
      created_at: hoursAgo(40),
      payment_at: hoursAgo(30),
      refund_payment_ref: 're_1',
    })
    const keys = agingFindings([owed, refunding], nowMs).map((f) => f.key)
    expect(keys).toContain('aging:payout-failed-unrefunded:t-1')
    expect(keys).not.toContain('aging:payout-failed-unrefunded:t-2')
  })

  it('anchors PAYOUT_FAILED on the LATEST lifecycle stamp — a held-then-failed row gets its full 24h', () => {
    // Funded 5 days ago (first-transfer hold), payout attempted 2h ago, failed
    // since: a funding-time anchor would page immediately; the submit stamp
    // says the tail is only 2h old (review finding).
    const heldThenFailed = row({
      id: 't-1',
      state: 'PAYOUT_FAILED',
      created_at: daysAgo(5),
      payment_at: daysAgo(5),
      submit_attempted_at: hoursAgo(2),
    })
    expect(agingFindings([heldThenFailed], nowMs)).toHaveLength(0)
  })

  it('flags UNDER_REVIEW aging and uncleared funding past the ACH window — including COMPLETED', () => {
    const review = row({
      id: 't-1',
      state: 'UNDER_REVIEW',
      created_at: hoursAgo(40),
      payment_at: hoursAgo(30),
    })
    const unclearedCompleted = row({ id: 't-2', state: 'COMPLETED', payment_at: daysAgo(9) })
    const clearedCompleted = row({
      id: 't-3',
      state: 'COMPLETED',
      payment_at: daysAgo(9),
      funding_cleared: true,
    })
    const keys = agingFindings([review, unclearedCompleted, clearedCompleted], nowMs).map((f) => f.key)
    expect(keys).toContain('aging:under-review-aging:t-1')
    expect(keys).toContain('aging:funding-uncleared-overdue:t-2')
    expect(keys.filter((k) => k.includes('t-3'))).toHaveLength(0)
  })

  it('a young book yields nothing', () => {
    const rows = [
      row({ id: 't-1', state: 'PENDING_PAYMENT', created_at: hoursAgo(0.2), payment_at: null }),
      row({ id: 't-2', state: 'FUNDED', payment_at: hoursAgo(1) }),
      row({ id: 't-3', state: 'IN_FLIGHT', payment_at: hoursAgo(2) }),
    ]
    expect(agingFindings(rows, nowMs)).toHaveLength(0)
  })
})

describe('classifyStripeStatus', () => {
  const row = (state: string, cleared = false, refundRef: string | null = null) => ({
    id: 't-1',
    state,
    funding_payment_ref: 'pi_123',
    funding_cleared: cleared,
    refund_payment_ref: refundRef,
  })

  it('PENDING_PAYMENT with a live or settled debit = missed processing webhook', () => {
    expect(classifyStripeStatus(row('PENDING_PAYMENT'), 'processing')?.key).toBe(
      'stripe-missed-processing:t-1',
    )
    expect(classifyStripeStatus(row('PENDING_PAYMENT'), 'succeeded')?.key).toBe(
      'stripe-missed-processing:t-1',
    )
  })

  it('PENDING_PAYMENT awaiting the sender (or canceled) is routine', () => {
    expect(classifyStripeStatus(row('PENDING_PAYMENT'), 'requires_payment_method')).toBeNull()
    expect(classifyStripeStatus(row('PENDING_PAYMENT'), 'requires_confirmation')).toBeNull()
    expect(classifyStripeStatus(row('PENDING_PAYMENT'), 'canceled')).toBeNull()
  })

  it('past FUNDED, a canceled or regressed PI is a serious mismatch', () => {
    expect(classifyStripeStatus(row('FUNDED'), 'canceled')?.key).toBe('stripe-pi-regressed:t-1')
    expect(classifyStripeStatus(row('IN_FLIGHT'), 'requires_payment_method')?.key).toBe(
      'stripe-pi-regressed:t-1',
    )
  })

  it('settled PI with funding_cleared still false = missed cleared webhook', () => {
    expect(classifyStripeStatus(row('COMPLETED'), 'succeeded')?.key).toBe('stripe-missed-cleared:t-1')
    expect(classifyStripeStatus(row('COMPLETED', true), 'succeeded')).toBeNull()
  })

  it('a processing PI past FUNDED is the expected in-flight shape', () => {
    expect(classifyStripeStatus(row('FUNDED'), 'processing')).toBeNull()
  })

  it('a live or settled debit on a DEAD transfer pages — unless an undo ref owns the money truth', () => {
    // reconcile-pending auto-fails without touching the PI: a missed
    // processing webhook leaves the pull marching to settlement on a row we
    // consider dead (review finding).
    expect(classifyStripeStatus(row('PAYMENT_FAILED'), 'processing')?.key).toBe(
      'stripe-debit-on-dead-transfer:t-1',
    )
    expect(classifyStripeStatus(row('PAYMENT_FAILED'), 'succeeded')?.key).toBe(
      'stripe-debit-on-dead-transfer:t-1',
    )
    expect(classifyStripeStatus(row('CANCELED'), 'succeeded')?.key).toBe(
      'stripe-debit-on-dead-transfer:t-1',
    )
    // Void-fell-back-to-refund: settled PI + persisted refund ref is the
    // expected shape while the refund tail runs.
    expect(classifyStripeStatus(row('CANCELED', false, 're_1'), 'succeeded')).toBeNull()
    // A properly voided dead transfer is silent.
    expect(classifyStripeStatus(row('CANCELED'), 'canceled')).toBeNull()
    expect(classifyStripeStatus(row('PAYMENT_FAILED'), 'requires_payment_method')).toBeNull()
  })
})

// ── Ledger self-checks (RPC-backed) ─────────────────────────────────────────

describe('ledger self-checks', () => {
  it('ledger_net_zero passes on an empty result and maps violations to findings', async () => {
    rpc.mockResolvedValue({ data: [], error: null })
    expect(await check('ledger_net_zero').run()).toMatchObject({ status: 'pass', findings: [] })
    expect(rpc).toHaveBeenCalledWith('reconcile_ledger_net_zero')

    rpc.mockResolvedValue({
      data: [{ ledger_transaction_id: 'tx-1', currency: 'USD', net_minor: -5 }],
      error: null,
    })
    const outcome = await check('ledger_net_zero').run()
    expect(outcome.status).toBe('findings')
    expect(outcome.findings[0]).toEqual({
      key: 'net-zero:tx-1:USD',
      detail: { ledgerTransactionId: 'tx-1', currency: 'USD', netMinor: -5 },
    })
  })

  it('ledger_min_entries maps violations', async () => {
    rpc.mockResolvedValue({ data: [{ ledger_transaction_id: 'tx-2', entry_count: 1 }], error: null })
    const outcome = await check('ledger_min_entries').run()
    expect(rpc).toHaveBeenCalledWith('reconcile_ledger_min_entries')
    expect(outcome.findings[0]).toEqual({
      key: 'min-entries:tx-2',
      detail: { ledgerTransactionId: 'tx-2', entryCount: 1 },
    })
  })

  it('state_postings maps violations', async () => {
    rpc.mockResolvedValue({
      data: [{ transfer_id: 't-9', state: 'COMPLETED', problem: 'missing_COMPLETED_posting' }],
      error: null,
    })
    const outcome = await check('state_postings').run()
    expect(rpc).toHaveBeenCalledWith('reconcile_state_postings')
    expect(outcome.findings[0]).toEqual({
      key: 'state-postings:t-9:missing_COMPLETED_posting',
      detail: { transferId: 't-9', state: 'COMPLETED', problem: 'missing_COMPLETED_posting' },
    })
  })

  it('self-checks fail CLOSED on a broken read', async () => {
    rpc.mockResolvedValue({ data: null, error: { message: 'boom' } })
    await expect(check('ledger_net_zero').run()).rejects.toThrow(/reconcile_ledger_net_zero failed: boom/)
    rpc.mockResolvedValue({ data: null, error: null })
    await expect(check('state_postings').run()).rejects.toThrow(/no rows returned/)
  })

  it('the self-checks page FATAL — that severity is the contract', () => {
    for (const name of ['ledger_net_zero', 'ledger_min_entries', 'state_postings', 'account_balances']) {
      expect(check(name).severity).toBe('fatal')
    }
  })
})

describe('account_balances', () => {
  const balanceRow = (code: string, amount_minor: number) => ({ code, amount_minor, currency: 'USD' })

  it('snapshots every account and flags a negative open-item balance', async () => {
    rpc.mockResolvedValue({
      data: [
        balanceRow('transfer_payable', -100),
        balanceRow('funding_receivable', 500),
        // legitimately signed accounts must NOT page: cash_clearing goes
        // negative on fee refunds pre-cash-legs; fx_slippage on favorable fills
        balanceRow('cash_clearing', -199),
        balanceRow('fx_slippage', -12),
      ],
      error: null,
    })
    const outcome = await check('account_balances').run()
    expect(rpc).toHaveBeenCalledWith('reconcile_account_balances')
    expect(outcome.status).toBe('findings')
    expect(outcome.findings).toEqual([
      { key: 'negative-balance:transfer_payable', detail: { accountCode: 'transfer_payable', amountMinor: -100 } },
    ])
    expect(outcome.balances).toEqual({
      transfer_payable: { amount_minor: -100, currency: 'USD' },
      funding_receivable: { amount_minor: 500, currency: 'USD' },
      cash_clearing: { amount_minor: -199, currency: 'USD' },
      fx_slippage: { amount_minor: -12, currency: 'USD' },
    })
  })

  it('passes with the snapshot attached when nothing is negative', async () => {
    rpc.mockResolvedValue({ data: [balanceRow('funding_receivable', 0)], error: null })
    const outcome = await check('account_balances').run()
    expect(outcome.status).toBe('pass')
    expect(outcome.balances).toEqual({ funding_receivable: { amount_minor: 0, currency: 'USD' } })
  })
})

// ── Transfer aging (query wiring) ───────────────────────────────────────────

describe('transfer_aging', () => {
  it('selects the open states plus COMPLETED-uncleared, bounded one past max_rows', async () => {
    const c = chainResolving({ data: [], error: null })
    from.mockReturnValue(c)
    const outcome = await check('transfer_aging').run()
    expect(outcome).toMatchObject({ status: 'pass', summary: { openRows: 0 } })
    expect(from).toHaveBeenCalledWith('transfers')
    expect(c['or']).toHaveBeenCalledWith(
      'state.in.(PENDING_PAYMENT,FUNDED,SUBMITTED,IN_FLIGHT,PAYOUT_FAILED,UNDER_REVIEW),and(state.eq.COMPLETED,funding_cleared.eq.false)',
    )
    expect(c['limit']).toHaveBeenCalledWith(1000)
  })

  it('throws rather than under-reporting when the read hits the PostgREST cap', async () => {
    // max_rows caps the response AT 1000, so 1000 rows is indistinguishable
    // from a truncated read — the guard must fire at the cap, not past it.
    const flood = Array.from({ length: 1000 }, (_, i) => ({
      id: `t-${i}`,
      state: 'FUNDED',
      created_at: hoursAgo(1),
      payment_at: hoursAgo(1),
      submit_attempted_at: null,
      completed_at: null,
      refund_payment_ref: null,
      payout_hold_reason: null,
      funding_cleared: false,
    }))
    from.mockReturnValue(chainResolving({ data: flood, error: null }))
    await expect(check('transfer_aging').run()).rejects.toThrow(/PostgREST cap/)
  })

  it('fails CLOSED on a broken read', async () => {
    from.mockReturnValue(chainResolving({ data: null, error: { message: 'db down' } }))
    await expect(check('transfer_aging').run()).rejects.toThrow(/transfer-aging select failed: db down/)
  })
})

// ── Bridge checks ───────────────────────────────────────────────────────────

describe('bridge_state_sweep', () => {
  it('passes when the poller replay path synthesizes nothing', async () => {
    pollPayouts.mockResolvedValue(0)
    expect(await check('bridge_state_sweep').run()).toMatchObject({
      status: 'pass',
      findings: [],
      summary: { synthesized: 0 },
    })
  })

  it('reports a synthesis count as a finding — the poller has a gap', async () => {
    pollPayouts.mockResolvedValue(2)
    const outcome = await check('bridge_state_sweep').run()
    expect(outcome.status).toBe('findings')
    expect(outcome.findings).toEqual([{ key: 'bridge-sweep-synthesized', detail: { synthesized: 2 } }])
  })
})

describe('bridge_orphans', () => {
  const bridgeTransfer = (over: Partial<{
    bridgeTransferId: string
    clientReferenceId: string | null
    state: string
    createdAt: string
  }>) => ({
    bridgeTransferId: 'bt-1',
    clientReferenceId: null,
    state: 'payment_processed',
    createdAt: daysAgo(1),
    ...over,
  })

  // Two sequential transfers selects: by provider_transfer_ref, then by id.
  function mockTransferLookups(byRef: string[], byId: string[]) {
    const refChain = chainResolving({
      data: byRef.map((provider_transfer_ref) => ({ provider_transfer_ref })),
      error: null,
    })
    const idChain = chainResolving({ data: byId.map((id) => ({ id })), error: null })
    from.mockReturnValueOnce(refChain).mockReturnValueOnce(idChain)
    return { refChain, idChain }
  }

  it('pages a recent Bridge transfer we have no row for', async () => {
    listBridgeTransfers.mockResolvedValue([bridgeTransfer({})])
    mockTransferLookups([], [])
    const outcome = await check('bridge_orphans').run()
    expect(outcome.status).toBe('findings')
    expect(outcome.findings[0]).toMatchObject({
      key: 'bridge-orphan:bt-1',
      detail: { bridgeTransferId: 'bt-1', bridgeState: 'payment_processed' },
    })
  })

  it('matches by provider_transfer_ref OR by client_reference_id (crash-window rows are not orphans)', async () => {
    listBridgeTransfers.mockResolvedValue([
      bridgeTransfer({ bridgeTransferId: 'bt-1' }),
      bridgeTransfer({ bridgeTransferId: 'bt-2', clientReferenceId: '11111111-2222-4333-8444-555555555555' }),
    ])
    mockTransferLookups(['bt-1'], ['11111111-2222-4333-8444-555555555555'])
    const outcome = await check('bridge_orphans').run()
    expect(outcome.status).toBe('pass')
    expect(outcome.findings).toHaveLength(0)
  })

  it('ignores Bridge transfers older than the window (pre-pilot sandbox artifacts)', async () => {
    listBridgeTransfers.mockResolvedValue([bridgeTransfer({ createdAt: daysAgo(30) })])
    const outcome = await check('bridge_orphans').run()
    expect(outcome.status).toBe('pass')
    expect(outcome.summary).toMatchObject({ listed: 1, inWindow: 0 })
    expect(from).not.toHaveBeenCalled()
  })

  it('marks a full page as truncated — never "everything"', async () => {
    listBridgeTransfers.mockResolvedValue(
      Array.from({ length: 100 }, (_, i) => bridgeTransfer({ bridgeTransferId: `bt-${i}` })),
    )
    mockTransferLookups(
      Array.from({ length: 100 }, (_, i) => `bt-${i}`),
      [],
    )
    const outcome = await check('bridge_orphans').run()
    expect(outcome.summary).toMatchObject({ truncated: true })
    // A capped page is an incomplete sweep — it pages instead of passing.
    expect(outcome.status).toBe('findings')
    expect(outcome.findings.map((f) => f.key)).toContain('bridge-orphans-truncated')
  })
})

describe('bridge_wallet_float', () => {
  it('skips without a treasury wallet id — never a fake pass', async () => {
    envMock.BRIDGE_TREASURY_WALLET_ID = undefined
    const outcome = await check('bridge_wallet_float').run()
    expect(outcome.status).toBe('skipped')
    expect(getBridgeWalletBalances).not.toHaveBeenCalled()
  })

  it('sums USD-pegged stables at par, ignores other currencies, and passes on equality', async () => {
    getBridgeWalletBalances.mockResolvedValue([
      { currency: 'usdc', balance: '5.69' },
      { currency: 'usdb', balance: '17.46' },
      { currency: 'eurc', balance: '99.99' },
    ])
    getAccountBalance.mockResolvedValue({ amountMinor: 2315, currency: 'USD' })
    const outcome = await check('bridge_wallet_float').run()
    expect(getBridgeWalletBalances).toHaveBeenCalledWith('wallet-1')
    expect(getAccountBalance).toHaveBeenCalledWith('bridge_wallet_float')
    expect(outcome.status).toBe('pass')
    expect(outcome.summary).toMatchObject({ walletMinor: 2315, ledgerMinor: 2315, diffMinor: 0 })
  })

  it('reports a mismatch with the signed diff — and never adjusts anything', async () => {
    getBridgeWalletBalances.mockResolvedValue([{ currency: 'usdc', balance: '10.00' }])
    getAccountBalance.mockResolvedValue({ amountMinor: 1500, currency: 'USD' })
    const outcome = await check('bridge_wallet_float').run()
    expect(outcome.status).toBe('findings')
    expect(outcome.findings[0]).toMatchObject({
      key: 'bridge-wallet-float-mismatch',
      detail: { walletMinor: 1000, ledgerMinor: 1500, diffMinor: -500 },
    })
  })

  it('flags dust so a sub-cent wallet residue is visible, not a phantom page', async () => {
    getBridgeWalletBalances.mockResolvedValue([{ currency: 'usdc', balance: '10.001' }])
    getAccountBalance.mockResolvedValue({ amountMinor: 1000, currency: 'USD' })
    const outcome = await check('bridge_wallet_float').run()
    expect(outcome.status).toBe('pass')
    expect(outcome.summary).toMatchObject({ dustDropped: true })
  })
})

// ── Stripe checks ───────────────────────────────────────────────────────────

const stripeProcessor = () => ({
  provider: 'stripe',
  isConfigured: () => true,
  getPaymentStatus: vi.fn(),
  listRecentPayments: vi.fn(),
})

describe('stripe_receivables', () => {
  it('skips under the mock processor', async () => {
    getFundingProcessor.mockReturnValue({ provider: 'mock', isConfigured: () => true })
    const outcome = await check('stripe_receivables').run()
    expect(outcome.status).toBe('skipped')
    expect(from).not.toHaveBeenCalled()
  })

  it('classifies each candidate against its live PI', async () => {
    const processor = stripeProcessor()
    processor.getPaymentStatus.mockResolvedValueOnce({ paymentRef: 'pi_a', status: 'succeeded' })
    processor.getPaymentStatus.mockResolvedValueOnce({ paymentRef: 'pi_b', status: 'processing' })
    getFundingProcessor.mockReturnValue(processor)
    const c = chainResolving({
      data: [
        { id: 't-1', state: 'FUNDED', funding_payment_ref: 'pi_a', funding_cleared: false, refund_payment_ref: null },
        { id: 't-2', state: 'FUNDED', funding_payment_ref: 'pi_b', funding_cleared: false, refund_payment_ref: null },
      ],
      error: null,
    })
    from.mockReturnValue(c)

    const outcome = await check('stripe_receivables').run()
    expect(c['like']).toHaveBeenCalledWith('funding_payment_ref', 'pi_%')
    // Live states unbounded; dead states windowed to the 14-day settlement
    // horizon (frozen clock pins the cutoff exactly).
    expect(c['or']).toHaveBeenCalledWith(
      'state.in.(PENDING_PAYMENT,FUNDED,SUBMITTED,IN_FLIGHT),' +
        'and(state.eq.COMPLETED,funding_cleared.eq.false),' +
        'and(state.in.(PAYMENT_FAILED,CANCELED),created_at.gte.2026-07-17T06:00:00.000Z)',
    )
    expect(outcome.status).toBe('findings')
    expect(outcome.findings.map((f) => f.key)).toEqual(['stripe-missed-cleared:t-1'])
    expect(outcome.summary).toMatchObject({ checked: 2, readFailures: 0 })
  })

  it('a PI read failure degrades the sweep to error — partial is never a clean pass', async () => {
    const processor = stripeProcessor()
    processor.getPaymentStatus.mockRejectedValueOnce(new Error('stripe timeout'))
    processor.getPaymentStatus.mockResolvedValueOnce({ paymentRef: 'pi_b', status: 'canceled' })
    getFundingProcessor.mockReturnValue(processor)
    from.mockReturnValue(
      chainResolving({
        data: [
          { id: 't-1', state: 'FUNDED', funding_payment_ref: 'pi_a', funding_cleared: false, refund_payment_ref: null },
          { id: 't-2', state: 'IN_FLIGHT', funding_payment_ref: 'pi_b', funding_cleared: false, refund_payment_ref: null },
        ],
        error: null,
      }),
    )

    const outcome = await check('stripe_receivables').run()
    expect(outcome.status).toBe('error')
    // ...but the findings it did reach are still reported and paged.
    expect(outcome.findings.map((f) => f.key)).toEqual(['stripe-pi-regressed:t-2'])
    expect(outcome.summary).toMatchObject({ readFailures: 1, firstReadFailure: 'stripe timeout' })
  })
})

describe('stripe_orphans', () => {
  it('skips under the mock processor', async () => {
    getFundingProcessor.mockReturnValue({ provider: 'mock', isConfigured: () => true })
    expect((await check('stripe_orphans').run()).status).toBe('skipped')
  })

  it('pages PIs with no transfer echo and PIs whose echo matches nothing', async () => {
    const processor = stripeProcessor()
    processor.listRecentPayments.mockResolvedValue([
      { paymentRef: 'pi_no_echo', transferRef: null, status: 'processing', createdAt: daysAgo(1) },
      // UUID-shaped echo that matches no row of ours
      { paymentRef: 'pi_ghost', transferRef: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee', status: 'succeeded', createdAt: daysAgo(1) },
      // non-UUID echo: excluded from the .in() lookup (22P02 guard) but still an orphan
      { paymentRef: 'pi_junk', transferRef: 'dashboard-created', status: 'processing', createdAt: daysAgo(1) },
      { paymentRef: 'pi_ok', transferRef: '99999999-8888-4777-8666-555555555554', status: 'processing', createdAt: daysAgo(1) },
    ])
    getFundingProcessor.mockReturnValue(processor)
    const c = chainResolving({ data: [{ id: '99999999-8888-4777-8666-555555555554' }], error: null })
    from.mockReturnValue(c)

    const outcome = await check('stripe_orphans').run()
    expect(processor.listRecentPayments).toHaveBeenCalledWith({
      createdAfter: new Date(nowMs - 7 * 24 * 3600_000),
      limit: 100,
    })
    expect(outcome.status).toBe('findings')
    expect(outcome.findings.map((f) => f.key)).toEqual([
      'stripe-orphan:pi_no_echo',
      'stripe-orphan:pi_ghost',
      'stripe-orphan:pi_junk',
    ])
    // The non-UUID echo never reached the uuid-typed .in() lookup.
    expect(c['in']).toHaveBeenCalledWith('id', [
      'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
      '99999999-8888-4777-8666-555555555554',
    ])
  })
})
