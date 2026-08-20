import { describe, it, expect, beforeEach, vi } from 'vitest'

// The funding.onramp_prepare job (slice 3): auto-create the Bridge onramp at
// confirm and attach its coordinates with system attribution. The suite pins
// the skip conditions (idempotent replays), the exact Bridge input (amount
// from the frozen terms), the retry-vs-retire split on failures, and the
// per-transfer pages on the deterministic dead ends.

const from = vi.fn()
vi.mock('../services/supabase.js', () => ({
  supabaseAdmin: { from: (...args: unknown[]) => from(...args) },
}))

const envMock = vi.hoisted(() => ({
  FUNDING_PROCESSOR: 'manual',
  BRIDGE_TREASURY_WALLET_ID: 'wallet-treasury-1' as string | undefined,
}))
vi.mock('../config/env.js', () => ({ env: envMock }))

const createBridgeOnramp = vi.hoisted(() => vi.fn())
vi.mock('../services/bridge.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../services/bridge.js')>()
  // real BridgeApiError — the 422 branch checks instanceof
  return { ...actual, createBridgeOnramp: (...a: unknown[]) => createBridgeOnramp(...a) }
})

const attach = vi.hoisted(() => vi.fn())
vi.mock('../services/deposit-instructions.js', () => ({
  attachDepositInstructions: (...a: unknown[]) => attach(...a),
}))

const captureMessage = vi.hoisted(() => vi.fn())
const setFingerprint = vi.hoisted(() => vi.fn())
vi.mock('@sentry/node', () => ({
  withScope: (fn: (s: unknown) => void) => fn({ setFingerprint, setContext: vi.fn() }),
  captureMessage: (...a: unknown[]) => captureMessage(...a),
}))

const { prepareOnramp } = await import('./onramp-prepare.js')
const { BridgeApiError } = await import('../services/bridge.js')

const queues: Record<string, unknown[]> = {}
function q(table: string, ...results: unknown[]) {
  queues[table] = (queues[table] ?? []).concat(results)
}
function chain(result: unknown) {
  const c: Record<string, unknown> = {}
  for (const m of ['select', 'eq']) {
    c[m] = () => c
  }
  c.maybeSingle = () => Promise.resolve(result)
  return c
}

const T = 'tr-1'
const transferRow = (over: Record<string, unknown> = {}) => ({
  data: {
    id: T,
    user_id: 'user-1',
    state: 'PENDING_PAYMENT',
    send_amount_minor: 19801,
    fee_amount_minor: 199,
    funding_payment_ref: 'manualpay_1',
    ...over,
  },
  error: null,
})
const noInstructions = { data: null, error: null }
const customerRow = (id: string | null = 'cust-1') => ({
  data: { bridge_customer_id: id },
  error: null,
})

beforeEach(() => {
  vi.clearAllMocks()
  for (const k of Object.keys(queues)) delete queues[k]
  envMock.FUNDING_PROCESSOR = 'manual'
  envMock.BRIDGE_TREASURY_WALLET_ID = 'wallet-treasury-1'
  createBridgeOnramp.mockResolvedValue({ bridgeTransferId: 'onramp-bt-1', state: 'awaiting_funds' })
  attach.mockResolvedValue({ outcome: 'attached', row: {} })
  from.mockImplementation((table: string) => {
    const next = queues[table]?.shift()
    if (next === undefined) throw new Error(`unexpected from('${table}')`)
    return chain(next)
  })
})

describe('prepareOnramp — happy path', () => {
  it('creates the onramp from the frozen terms and attaches with system attribution', async () => {
    q('transfers', transferRow())
    q('deposit_instructions', noInstructions)
    q('users', customerRow())

    await expect(prepareOnramp(T)).resolves.toBe(1)

    // amount = send + fee, cent-exact 2dp decimal — the attach-time mismatch
    // check is a tautology for auto-created onramps
    expect(createBridgeOnramp).toHaveBeenCalledWith({
      transferId: T,
      onBehalfOf: 'cust-1',
      treasuryWalletId: 'wallet-treasury-1',
      amountUsd: '200.00',
    })
    expect(attach).toHaveBeenCalledWith({
      transferId: T,
      bridgeTransferId: 'onramp-bt-1',
      operator: null, // system attribution — no human vouched
    })
    expect(captureMessage).not.toHaveBeenCalled()
  })
})

describe('prepareOnramp — skip conditions (idempotent replays)', () => {
  it('does nothing under a non-manual processor (replay after a flip)', async () => {
    envMock.FUNDING_PROCESSOR = 'stripe'
    await expect(prepareOnramp(T)).resolves.toBe(0)
    expect(from).not.toHaveBeenCalled()
    expect(createBridgeOnramp).not.toHaveBeenCalled()
  })

  it('does nothing when the transfer is gone', async () => {
    q('transfers', { data: null, error: null })
    await expect(prepareOnramp(T)).resolves.toBe(0)
    expect(createBridgeOnramp).not.toHaveBeenCalled()
  })

  it('does nothing once the transfer left PENDING_PAYMENT', async () => {
    q('transfers', transferRow({ state: 'FUNDED' }))
    await expect(prepareOnramp(T)).resolves.toBe(0)
    expect(createBridgeOnramp).not.toHaveBeenCalled()
  })

  it('does nothing for an unconfirmed transfer (no funding ref)', async () => {
    q('transfers', transferRow({ funding_payment_ref: null }))
    await expect(prepareOnramp(T)).resolves.toBe(0)
    expect(createBridgeOnramp).not.toHaveBeenCalled()
  })

  it('never overwrites existing instructions (prior run or operator re-attach)', async () => {
    q('transfers', transferRow())
    q('deposit_instructions', { data: { transfer_id: T }, error: null })
    await expect(prepareOnramp(T)).resolves.toBe(0)
    expect(createBridgeOnramp).not.toHaveBeenCalled()
    expect(attach).not.toHaveBeenCalled()
  })
})

describe('prepareOnramp — deterministic dead ends page and retire', () => {
  it('no bridge_customer_id → per-transfer page, no Bridge call, retired', async () => {
    q('transfers', transferRow())
    q('deposit_instructions', noInstructions)
    q('users', customerRow(null))

    await expect(prepareOnramp(T)).resolves.toBe(0)

    expect(createBridgeOnramp).not.toHaveBeenCalled()
    expect(setFingerprint).toHaveBeenCalledWith(['onramp-prepare-no-customer', T])
    expect(captureMessage).toHaveBeenCalledWith(expect.stringContaining('attach instructions by hand'), 'error')
  })

  it('Bridge 422 (hand-created onramp under our key) → page, retired', async () => {
    q('transfers', transferRow())
    q('deposit_instructions', noInstructions)
    q('users', customerRow())
    createBridgeOnramp.mockRejectedValue(new BridgeApiError(422, { code: 'idempotency_key_mismatch' }))

    await expect(prepareOnramp(T)).resolves.toBe(0)

    expect(attach).not.toHaveBeenCalled()
    expect(setFingerprint).toHaveBeenCalledWith(['onramp-prepare-conflict', T])
  })

  it('amount_mismatch from attach → page, retired', async () => {
    q('transfers', transferRow())
    q('deposit_instructions', noInstructions)
    q('users', customerRow())
    attach.mockResolvedValue({ outcome: 'amount_mismatch', expectedMinor: 20000, bridgeMinor: 19900 })

    await expect(prepareOnramp(T)).resolves.toBe(0)

    expect(setFingerprint).toHaveBeenCalledWith(['onramp-prepare-amount-mismatch', T])
  })
})

describe('prepareOnramp — retryable failures rethrow', () => {
  it('a Bridge 5xx rethrows for pg-boss retry', async () => {
    q('transfers', transferRow())
    q('deposit_instructions', noInstructions)
    q('users', customerRow())
    createBridgeOnramp.mockRejectedValue(new BridgeApiError(503, null))

    await expect(prepareOnramp(T)).rejects.toBeInstanceOf(BridgeApiError)
    expect(captureMessage).not.toHaveBeenCalled()
  })

  it('coordinates not issued yet (instructions_unavailable) rethrows for retry', async () => {
    q('transfers', transferRow())
    q('deposit_instructions', noInstructions)
    q('users', customerRow())
    attach.mockResolvedValue({ outcome: 'instructions_unavailable' })

    await expect(prepareOnramp(T)).rejects.toThrow('instructions unavailable')
  })

  it('a missing treasury wallet rethrows (config error, retry until fixed)', async () => {
    envMock.BRIDGE_TREASURY_WALLET_ID = undefined
    q('transfers', transferRow())
    q('deposit_instructions', noInstructions)
    q('users', customerRow())

    await expect(prepareOnramp(T)).rejects.toThrow('BRIDGE_TREASURY_WALLET_ID')
    expect(createBridgeOnramp).not.toHaveBeenCalled()
  })
})

describe('prepareOnramp — races that resolved elsewhere', () => {
  it('the transfer moved between load and attach (not_pending_payment) → quiet no-op', async () => {
    q('transfers', transferRow())
    q('deposit_instructions', noInstructions)
    q('users', customerRow())
    attach.mockResolvedValue({ outcome: 'not_pending_payment', state: 'FUNDED' })

    await expect(prepareOnramp(T)).resolves.toBe(0)
    expect(captureMessage).not.toHaveBeenCalled()
  })
})
