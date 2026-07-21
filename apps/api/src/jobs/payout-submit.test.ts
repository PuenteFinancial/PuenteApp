import { describe, it, expect, beforeEach, vi } from 'vitest'

// Guard-ordering suite for the payout submission job: every refusal path must
// short-circuit BEFORE the Bridge call, holds must land only where the plan
// says, and the recovery path must skip the guards entirely.

const from = vi.fn()
vi.mock('../services/supabase.js', () => ({
  supabaseAdmin: { from: (...args: unknown[]) => from(...args) },
}))

const transition = vi.hoisted(() => vi.fn())
vi.mock('../services/transfers.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../services/transfers.js')>()
  return { ...actual, transitionTransfer: (...args: unknown[]) => transition(...args) }
})

const payability = vi.hoisted(() => vi.fn())
const floatCeiling = vi.hoisted(() => vi.fn())
const driftBps = vi.hoisted(() => vi.fn())
const parseMinor = vi.hoisted(() => vi.fn())
const ledgerEntries = vi.hoisted(() => vi.fn())
vi.mock('../services/payouts.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../services/payouts.js')>()
  return {
    ...actual,
    checkPayability: (...args: unknown[]) => payability(...args),
    isFloatCeilingTripped: (...args: unknown[]) => floatCeiling(...args),
    computeDriftBps: (...args: unknown[]) => driftBps(...args),
    parseDecimalToMinor: (...args: unknown[]) => parseMinor(...args),
    minorToDecimal: () => '3960.14',
    submittedLedgerEntries: (...args: unknown[]) => ledgerEntries(...args),
  }
})

const createPayout = vi.hoisted(() => vi.fn())
const exchangeRate = vi.hoisted(() => vi.fn())
vi.mock('../services/bridge.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../services/bridge.js')>()
  return {
    ...actual,
    createBridgePayout: (...args: unknown[]) => createPayout(...args),
    getExchangeRate: (...args: unknown[]) => exchangeRate(...args),
  }
})

const enqueueEvent = vi.hoisted(() => vi.fn())
vi.mock('../services/queue.js', () => ({
  enqueuePaymentEventProcess: (...args: unknown[]) => enqueueEvent(...args),
}))

const captureMessage = vi.hoisted(() => vi.fn())
const setFingerprint = vi.hoisted(() => vi.fn())
vi.mock('@sentry/node', () => ({
  withScope: (fn: (scope: unknown) => void) =>
    fn({ setFingerprint, setContext: vi.fn() }),
  captureMessage: (...args: unknown[]) => captureMessage(...args),
  captureException: vi.fn(),
}))

const envMock = vi.hoisted(() => ({
  WAIT_FOR_CLEARING: false,
  FX_MAX_DRIFT_BPS: 200,
  FX_MAX_QUOTE_AGE_MINUTES: 240,
  BRIDGE_TREASURY_WALLET_ID: 'wallet_1',
}))
vi.mock('../config/env.js', () => ({ env: envMock }))

const { submitPayout } = await import('./payout-submit.js')
const { BridgeApiError } = await import('../services/bridge.js')
const { TransferRpcError } = await import('../services/transfers.js')
const { PayoutValidationError } = await import('../services/payouts.js')

// A permissive thenable chain: every builder method returns the chain, and
// awaiting it (or .maybeSingle()) resolves the configured result.
type Chain = Record<string, ReturnType<typeof vi.fn>> & PromiseLike<unknown>
function chain(result: unknown): Chain {
  const c = {} as Chain
  for (const m of ['select', 'update', 'upsert', 'eq', 'is', 'lt', 'or']) {
    c[m] = vi.fn(() => c)
  }
  c.maybeSingle = vi.fn(() => Promise.resolve(result))
  ;(c as { then: unknown }).then = (
    res: (v: unknown) => unknown,
    rej: (e: unknown) => unknown,
  ) => Promise.resolve(result).then(res, rej)
  return c
}

const baseTransfer = {
  id: 'tr-1',
  user_id: 'user-1',
  quote_id: 'q-1',
  payout_destination_id: 'dest-1',
  state: 'FUNDED',
  send_amount_minor: 19801,
  receive_amount_minor: 396014,
  funding_cleared: false,
  idempotency_key: 'idem-1',
  provider_transfer_ref: null,
  payout_hold_reason: null,
  submit_attempted_at: null,
}

const queues: Record<string, Chain[]> = {}
function route(table: string, ...chains: Chain[]) {
  queues[table] = chains
}

function setupHappy(overrides: Partial<typeof baseTransfer> = {}) {
  const load = chain({ data: { ...baseTransfer, ...overrides }, error: null })
  const claim = chain({ data: [{ id: 'tr-1' }], error: null })
  route('transfers', load, claim)
  route('quotes', chain({ data: { source_rate: 20.100251, created_at: new Date().toISOString() }, error: null }))
  route('users', chain({ data: { bridge_customer_id: 'cust_1' }, error: null }))
  route('payment_events', chain({ data: { id: 'ev-1' }, error: null }))
  payability.mockResolvedValue({ payable: true, providerAccountRef: 'ext_1' })
  floatCeiling.mockResolvedValue({ tripped: false, balanceMinor: 0, ceilingMinor: 100 })
  exchangeRate.mockResolvedValue({ buyRate: '20.15' })
  driftBps.mockReturnValue(25)
  createPayout.mockResolvedValue({
    bridgeTransferId: 'bt-1',
    state: 'awaiting_funds',
    sourceAmount: '198.55',
  })
  parseMinor.mockReturnValue(19855)
  ledgerEntries.mockReturnValue([{ account_code: 'due_from_bridge' }])
  transition.mockResolvedValue({})
  return { load, claim }
}

beforeEach(() => {
  vi.clearAllMocks()
  for (const k of Object.keys(queues)) delete queues[k]
  envMock.WAIT_FOR_CLEARING = false
  envMock.FX_MAX_DRIFT_BPS = 200
  envMock.FX_MAX_QUOTE_AGE_MINUTES = 240
  envMock.BRIDGE_TREASURY_WALLET_ID = 'wallet_1'
  from.mockImplementation((table: string) => {
    const next = queues[table]?.shift()
    if (!next) throw new Error(`unexpected supabase.from('${table}')`)
    return next
  })
})

describe('submitPayout — short-circuits (no Bridge call)', () => {
  it('returns 0 for a transfer that is not FUNDED', async () => {
    route('transfers', chain({ data: { ...baseTransfer, state: 'SUBMITTED' }, error: null }))
    expect(await submitPayout('tr-1')).toBe(0)
    expect(payability).not.toHaveBeenCalled()
    expect(createPayout).not.toHaveBeenCalled()
  })

  it('returns 0 for a missing transfer', async () => {
    route('transfers', chain({ data: null, error: null }))
    expect(await submitPayout('tr-1')).toBe(0)
    expect(createPayout).not.toHaveBeenCalled()
  })

  it('returns 0 when a hold is set — ops owns held rows', async () => {
    route('transfers', chain({ data: { ...baseTransfer, payout_hold_reason: 'fx_drift' }, error: null }))
    expect(await submitPayout('tr-1')).toBe(0)
    expect(payability).not.toHaveBeenCalled()
    expect(createPayout).not.toHaveBeenCalled()
  })

  it('WAIT_FOR_CLEARING on + uncleared → 0 with no claim and no hold', async () => {
    envMock.WAIT_FOR_CLEARING = true
    const load = chain({ data: baseTransfer, error: null })
    route('transfers', load)
    expect(await submitPayout('tr-1')).toBe(0)
    expect(load.update).not.toHaveBeenCalled()
    expect(payability).not.toHaveBeenCalled()
    expect(createPayout).not.toHaveBeenCalled()
  })

  it('WAIT_FOR_CLEARING on + cleared → proceeds to submission', async () => {
    envMock.WAIT_FOR_CLEARING = true
    setupHappy({ funding_cleared: true })
    expect(await submitPayout('tr-1')).toBe(1)
    expect(createPayout).toHaveBeenCalledTimes(1)
  })

  it('losing the claim race → 0, no Bridge call', async () => {
    setupHappy()
    queues.transfers = [chain({ data: baseTransfer, error: null }), chain({ data: [], error: null })]
    expect(await submitPayout('tr-1')).toBe(0)
    expect(createPayout).not.toHaveBeenCalled()
  })
})

describe('submitPayout — holds', () => {
  it('payability failure → payability hold, no float/fx checks, no Bridge call', async () => {
    const load = chain({ data: baseTransfer, error: null })
    const hold = chain({ data: [{ id: 'tr-1' }], error: null })
    route('transfers', load, hold)
    payability.mockResolvedValue({ payable: false, reason: 'recipient_not_active' })
    expect(await submitPayout('tr-1')).toBe(0)
    expect(hold.update).toHaveBeenCalledWith(
      expect.objectContaining({ payout_hold_reason: 'payability' }),
    )
    expect(floatCeiling).not.toHaveBeenCalled()
    expect(exchangeRate).not.toHaveBeenCalled()
    expect(createPayout).not.toHaveBeenCalled()
    expect(setFingerprint).toHaveBeenCalledWith(['payout-hold', 'payability'])
  })

  it('hold race (guarded update matches 0 rows) → no Sentry hold signal', async () => {
    const load = chain({ data: baseTransfer, error: null })
    const hold = chain({ data: [], error: null }) // another actor held/moved first
    route('transfers', load, hold)
    payability.mockResolvedValue({ payable: false, reason: 'recipient_not_active' })
    expect(await submitPayout('tr-1')).toBe(0)
    expect(hold.update).toHaveBeenCalled()
    expect(captureMessage).not.toHaveBeenCalled() // the winner's signal stands alone
    expect(createPayout).not.toHaveBeenCalled()
  })

  it('float ceiling tripped → NO hold, Sentry alert, no Bridge call', async () => {
    const load = chain({ data: baseTransfer, error: null })
    route('transfers', load)
    payability.mockResolvedValue({ payable: true, providerAccountRef: 'ext_1' })
    floatCeiling.mockResolvedValue({ tripped: true, balanceMinor: 900, ceilingMinor: 100 })
    expect(await submitPayout('tr-1')).toBe(0)
    expect(load.update).not.toHaveBeenCalled() // the whole point: self-healing, no hold
    expect(setFingerprint).toHaveBeenCalledWith(['float-ceiling'])
    expect(exchangeRate).not.toHaveBeenCalled()
    expect(createPayout).not.toHaveBeenCalled()
  })

  it('drift over the cap → fx_drift hold, no claim, no Bridge call', async () => {
    const load = chain({ data: baseTransfer, error: null })
    const hold = chain({ data: [{ id: 'tr-1' }], error: null })
    route('transfers', load, hold)
    route('quotes', chain({ data: { source_rate: 20.1, created_at: new Date().toISOString() }, error: null }))
    payability.mockResolvedValue({ payable: true, providerAccountRef: 'ext_1' })
    floatCeiling.mockResolvedValue({ tripped: false, balanceMinor: 0, ceilingMinor: 100 })
    exchangeRate.mockResolvedValue({ buyRate: '22.00' })
    driftBps.mockReturnValue(945)
    expect(await submitPayout('tr-1')).toBe(0)
    expect(hold.update).toHaveBeenCalledWith(
      expect.objectContaining({ payout_hold_reason: 'fx_drift' }),
    )
    expect(createPayout).not.toHaveBeenCalled()
  })

  it('stale quote (age over cap) → fx_drift hold even at zero drift', async () => {
    const load = chain({ data: baseTransfer, error: null })
    const hold = chain({ data: [{ id: 'tr-1' }], error: null })
    route('transfers', load, hold)
    const oldCreated = new Date(Date.now() - 241 * 60_000).toISOString()
    route('quotes', chain({ data: { source_rate: 20.1, created_at: oldCreated }, error: null }))
    payability.mockResolvedValue({ payable: true, providerAccountRef: 'ext_1' })
    floatCeiling.mockResolvedValue({ tripped: false, balanceMinor: 0, ceilingMinor: 100 })
    exchangeRate.mockResolvedValue({ buyRate: '20.10' })
    driftBps.mockReturnValue(0)
    expect(await submitPayout('tr-1')).toBe(0)
    expect(hold.update).toHaveBeenCalledWith(
      expect.objectContaining({ payout_hold_reason: 'fx_drift' }),
    )
    expect(createPayout).not.toHaveBeenCalled()
  })

  it('rate-fetch failure → throws (never submit on unknown drift)', async () => {
    route('transfers', chain({ data: baseTransfer, error: null }))
    route('quotes', chain({ data: { source_rate: 20.1, created_at: new Date().toISOString() }, error: null }))
    payability.mockResolvedValue({ payable: true, providerAccountRef: 'ext_1' })
    floatCeiling.mockResolvedValue({ tripped: false, balanceMinor: 0, ceilingMinor: 100 })
    exchangeRate.mockRejectedValue(new BridgeApiError(503, {}))
    await expect(submitPayout('tr-1')).rejects.toThrow()
    expect(createPayout).not.toHaveBeenCalled()
  })
})

describe('submitPayout — submission and transition', () => {
  it('happy path: claims, POSTs the contract input, transitions with ledger + ref', async () => {
    const { claim } = setupHappy()
    expect(await submitPayout('tr-1')).toBe(1)
    expect(claim.update).toHaveBeenCalledWith(
      expect.objectContaining({ submit_attempted_at: expect.any(String) }),
    )
    expect(createPayout).toHaveBeenCalledWith({
      idempotencyKey: 'idem-1',
      clientReferenceId: 'tr-1',
      onBehalfOf: 'cust_1',
      sourceWalletId: 'wallet_1',
      destinationExternalAccountId: 'ext_1',
      destinationAmountMxn: '3960.14',
    })
    expect(ledgerEntries).toHaveBeenCalledWith({
      sendAmountMinor: 19801,
      actualSourceAmountMinor: 19855,
    })
    const [input] = transition.mock.calls[0] as [Record<string, unknown>]
    expect(input).toMatchObject({
      transferId: 'tr-1',
      fromState: 'FUNDED',
      toState: 'SUBMITTED',
      actor: 'worker:payout',
      providerTransferRef: 'bt-1',
      metadata: expect.objectContaining({
        bridgeTransferId: 'bt-1',
        sourceAmountMinor: 19855,
        driftBps: 25,
      }),
    })
    // Guard order: payability → float → fx → claim → Bridge
    const order = [
      payability.mock.invocationCallOrder[0]!,
      floatCeiling.mock.invocationCallOrder[0]!,
      exchangeRate.mock.invocationCallOrder[0]!,
      createPayout.mock.invocationCallOrder[0]!,
    ]
    expect([...order]).toEqual([...order].sort((a, b) => a - b))
  })

  it('sync 400 (wallet drained / serialization) → rethrows for retry, no hold', async () => {
    setupHappy()
    createPayout.mockRejectedValue(new BridgeApiError(400, {}))
    await expect(submitPayout('tr-1')).rejects.toThrow()
    expect(queues.transfers).toHaveLength(0) // no third chain: no hold write
    expect(transition).not.toHaveBeenCalled()
  })

  it('422 idempotency mismatch → submit_error hold, no throw, no transition', async () => {
    setupHappy()
    const hold = chain({ data: [{ id: 'tr-1' }], error: null })
    queues.transfers!.push(hold)
    createPayout.mockRejectedValue(new BridgeApiError(422, {}))
    expect(await submitPayout('tr-1')).toBe(0)
    expect(hold.update).toHaveBeenCalledWith(
      expect.objectContaining({ payout_hold_reason: 'submit_error' }),
    )
    expect(transition).not.toHaveBeenCalled()
  })

  it('5xx → rethrows for retry, no hold', async () => {
    setupHappy()
    createPayout.mockRejectedValue(new BridgeApiError(502, {}))
    await expect(submitPayout('tr-1')).rejects.toThrow()
    expect(transition).not.toHaveBeenCalled()
  })

  it('source.amount failing the strict 2-dp parse → submit_error hold + alert, no transition', async () => {
    setupHappy()
    const hold = chain({ data: [{ id: 'tr-1' }], error: null })
    queues.transfers!.push(hold)
    parseMinor.mockImplementation(() => {
      throw new PayoutValidationError('more than 2 decimal places')
    })
    expect(await submitPayout('tr-1')).toBe(0)
    expect(setFingerprint).toHaveBeenCalledWith(['bridge-source-amount-precision'])
    expect(hold.update).toHaveBeenCalledWith(
      expect.objectContaining({ payout_hold_reason: 'submit_error' }),
    )
    expect(transition).not.toHaveBeenCalled()
  })

  it('transition_conflict → warns and returns 1 (poller reconciles), no retry loop', async () => {
    setupHappy()
    transition.mockRejectedValue(new TransferRpcError('transition_conflict'))
    expect(await submitPayout('tr-1')).toBe(1)
    expect(setFingerprint).toHaveBeenCalledWith(['payout-submit-transition-conflict'])
  })

  it('advanced Bridge state on create → synthesizes a bridge_poll event and enqueues it', async () => {
    setupHappy()
    createPayout.mockResolvedValue({
      bridgeTransferId: 'bt-1',
      state: 'payment_processed',
      sourceAmount: '198.55',
    })
    expect(await submitPayout('tr-1')).toBe(1)
    const eventChain = queues.payment_events
    expect(eventChain).toHaveLength(0) // consumed
    expect(enqueueEvent).toHaveBeenCalledWith('ev-1')
  })

  it('awaiting_funds state → no synthesized event', async () => {
    setupHappy()
    expect(await submitPayout('tr-1')).toBe(1)
    expect(queues.payment_events).toHaveLength(1) // untouched
    expect(enqueueEvent).not.toHaveBeenCalled()
  })
})

describe('submitPayout — crash recovery', () => {
  it('claimed row: skips every guard, re-POSTs from the raw destination ref', async () => {
    const load = chain({
      data: { ...baseTransfer, submit_attempted_at: '2026-07-20T12:00:00.000Z' },
      error: null,
    })
    route('transfers', load)
    route('payout_destinations', chain({ data: { provider_account_ref: 'ext_1' }, error: null }))
    route('users', chain({ data: { bridge_customer_id: 'cust_1' }, error: null }))
    route('payment_events', chain({ data: { id: 'ev-1' }, error: null }))
    createPayout.mockResolvedValue({
      bridgeTransferId: 'bt-1',
      state: 'awaiting_funds',
      sourceAmount: '198.55',
    })
    parseMinor.mockReturnValue(19855)
    ledgerEntries.mockReturnValue([{ account_code: 'due_from_bridge' }])
    transition.mockResolvedValue({})

    expect(await submitPayout('tr-1')).toBe(1)
    expect(payability).not.toHaveBeenCalled()
    expect(floatCeiling).not.toHaveBeenCalled()
    expect(exchangeRate).not.toHaveBeenCalled()
    expect(load.update).not.toHaveBeenCalled() // no re-claim
    expect(createPayout).toHaveBeenCalledWith(
      expect.objectContaining({ idempotencyKey: 'idem-1', destinationExternalAccountId: 'ext_1' }),
    )
    const [input] = transition.mock.calls[0] as [Record<string, unknown>]
    expect((input.metadata as Record<string, unknown>).driftBps).toBeUndefined()
  })

  it('recovery with a missing destination ref → submit_error hold, no Bridge call', async () => {
    const load = chain({
      data: { ...baseTransfer, submit_attempted_at: '2026-07-20T12:00:00.000Z' },
      error: null,
    })
    const hold = chain({ data: [{ id: 'tr-1' }], error: null })
    route('transfers', load, hold)
    route('payout_destinations', chain({ data: { provider_account_ref: null }, error: null }))
    expect(await submitPayout('tr-1')).toBe(0)
    expect(hold.update).toHaveBeenCalledWith(
      expect.objectContaining({ payout_hold_reason: 'submit_error' }),
    )
    expect(createPayout).not.toHaveBeenCalled()
  })
})
