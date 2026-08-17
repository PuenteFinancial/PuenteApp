import { describe, it, expect, beforeEach, vi } from 'vitest'

// recordManualFunding is the ONLY path from PENDING_PAYMENT to FUNDED when
// there is no payment gateway, so its refusals are the safety surface. The
// appliers underneath are additionally exercised end-to-end through the funding
// webhook in routes/v1/webhooks.test.ts.

const from = vi.hoisted(() => vi.fn())
vi.mock('./supabase.js', () => ({ supabaseAdmin: { from: (...a: unknown[]) => from(...a) } }))

const transitionTransfer = vi.hoisted(() => vi.fn())
vi.mock('./transfers.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./transfers.js')>()
  return { ...actual, transitionTransfer: (...a: unknown[]) => transitionTransfer(...a) }
})

const enqueuePayoutSubmit = vi.hoisted(() => vi.fn())
vi.mock('./queue.js', () => ({
  enqueuePayoutSubmit: (...a: unknown[]) => enqueuePayoutSubmit(...a),
}))

const postLedgerTransaction = vi.hoisted(() => vi.fn())
vi.mock('./ledger.js', () => ({
  postLedgerTransaction: (...a: unknown[]) => postLedgerTransaction(...a),
}))

const getFundingProcessor = vi.hoisted(() => vi.fn())
vi.mock('./funding/index.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./funding/index.js')>()
  return { ...actual, getFundingProcessor: () => getFundingProcessor() }
})

const { recordManualFunding, applyFundingSucceeded } = await import('./funding-apply.js')
const { TransferRpcError } = await import('./transfers.js')

const TRANSFER_ID = 'cccccccc-1111-4222-8333-444444444444'
const OPERATOR = 'aaaaaaaa-1111-4222-8333-444444444444'
const EXTERNAL_REF = 'c8617cef-1adf-4dba-b978-c68150901663'

const PENDING = {
  id: TRANSFER_ID,
  state: 'PENDING_PAYMENT',
  send_amount_minor: 5000,
  fee_amount_minor: 100,
  funding_payment_ref: 'manualpay_abc',
}

/** Chainable supabase stub whose terminal read resolves to `data`. */
function stubTransfer(data: unknown) {
  from.mockImplementation(() => {
    const b: Record<string, unknown> = {}
    for (const m of ['select', 'eq', 'update']) b[m] = () => b
    b['maybeSingle'] = async () => ({ data, error: null })
    b['single'] = async () => ({ data, error: null })
    return b
  })
}

function call(overrides: Record<string, unknown> = {}) {
  return recordManualFunding({
    transferId: TRANSFER_ID,
    kind: 'funded',
    externalRef: EXTERNAL_REF,
    amountMinor: 5100,
    operator: OPERATOR,
    ...overrides,
  } as Parameters<typeof recordManualFunding>[0])
}

beforeEach(() => {
  from.mockReset()
  transitionTransfer.mockReset().mockResolvedValue({ id: TRANSFER_ID })
  enqueuePayoutSubmit.mockReset().mockResolvedValue(undefined)
  postLedgerTransaction.mockReset().mockResolvedValue(undefined)
  getFundingProcessor.mockReset().mockReturnValue({ provider: 'manual' })
  stubTransfer(PENDING)
})

describe('recordManualFunding — processor guard', () => {
  // The load-bearing guard. Under stripe, funding_payment_ref is a real
  // PaymentIntent whose settlement Stripe owns; letting an operator assert it
  // funded would pay out MXN against a charge that may never clear.
  it.each(['stripe', 'mock'])('refuses when the processor is %s', async (provider) => {
    getFundingProcessor.mockReturnValue({ provider })
    const result = await call()
    expect(result).toEqual({ done: false, reason: 'processor_not_manual', provider })
    expect(transitionTransfer).not.toHaveBeenCalled()
  })

  it('refuses BEFORE reading the transfer', async () => {
    getFundingProcessor.mockReturnValue({ provider: 'stripe' })
    await call()
    expect(from).not.toHaveBeenCalled()
  })
})

describe('recordManualFunding — refusals', () => {
  it('refuses an unknown transfer', async () => {
    stubTransfer(null)
    expect(await call()).toEqual({ done: false, reason: 'transfer_not_found' })
    expect(transitionTransfer).not.toHaveBeenCalled()
  })

  it('refuses when the stated amount does not match to the cent', async () => {
    const result = await call({ amountMinor: 5099 })
    expect(result).toEqual({ done: false, reason: 'amount_mismatch', expectedMinor: 5100 })
    expect(transitionTransfer).not.toHaveBeenCalled()
  })

  it('compares against send + fee, not the send alone', async () => {
    expect(await call({ amountMinor: 5000 })).toMatchObject({ reason: 'amount_mismatch' })
  })

  it('refuses a transfer that is already funded', async () => {
    stubTransfer({ ...PENDING, state: 'FUNDED' })
    expect(await call()).toEqual({ done: false, reason: 'already_funded' })
    expect(transitionTransfer).not.toHaveBeenCalled()
  })

  it.each(['SUBMITTED', 'IN_FLIGHT', 'COMPLETED', 'CANCELED', 'REFUNDED', 'PAYMENT_FAILED'])(
    'refuses from %s',
    async (state) => {
      stubTransfer({ ...PENDING, state })
      expect(await call()).toEqual({ done: false, reason: 'not_pending_payment', state })
      expect(transitionTransfer).not.toHaveBeenCalled()
    },
  )

  it('refuses when the sender never confirmed (no funding ref minted)', async () => {
    stubTransfer({ ...PENDING, funding_payment_ref: null })
    expect(await call()).toEqual({ done: false, reason: 'funding_not_initiated' })
    expect(transitionTransfer).not.toHaveBeenCalled()
  })

  it('reports a lost race as stale rather than forcing the transition', async () => {
    transitionTransfer.mockRejectedValue(new TransferRpcError('transition_conflict'))
    expect(await call()).toEqual({ done: false, reason: 'stale' })
  })

  it('propagates a genuine fault instead of reporting a benign refusal', async () => {
    transitionTransfer.mockRejectedValue(new Error('connection reset'))
    await expect(call()).rejects.toThrow('connection reset')
  })
})

describe('recordManualFunding — funded', () => {
  it('records the operator, the deposit ref, and the confirm-minted payment ref', async () => {
    expect(await call()).toEqual({ done: true, outcome: 'funded' })
    const arg = transitionTransfer.mock.calls[0]![0] as Record<string, unknown>
    expect(arg['fromState']).toBe('PENDING_PAYMENT')
    expect(arg['toState']).toBe('FUNDED')
    expect(arg['actor']).toBe(`ops:${OPERATOR}`)
    // funding_payment_ref keeps the ref minted at confirm; the real-world
    // deposit id is the event identity and rides in metadata as evidence.
    expect(arg['fundingPaymentRef']).toBe('manualpay_abc')
    expect(arg['metadata']).toMatchObject({
      eventId: EXTERNAL_REF,
      externalRef: EXTERNAL_REF,
      operator: OPERATOR,
    })
  })

  it('posts the FUNDED ledger batch in the same transition', async () => {
    await call()
    const arg = transitionTransfer.mock.calls[0]![0] as Record<string, unknown>
    const entries = arg['ledgerEntries'] as { account_code: string; direction: string }[]
    expect(entries).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ account_code: 'funding_receivable', direction: 'debit' }),
        expect.objectContaining({ account_code: 'transfer_payable', direction: 'credit' }),
        expect.objectContaining({ account_code: 'fee_revenue', direction: 'credit' }),
      ]),
    )
  })

  it('releases the payout after the transition commits, never before', async () => {
    const order: string[] = []
    transitionTransfer.mockImplementation(async () => {
      order.push('transition')
      return { id: TRANSFER_ID }
    })
    enqueuePayoutSubmit.mockImplementation(async () => {
      order.push('enqueue')
    })
    await call()
    expect(order).toEqual(['transition', 'enqueue'])
  })

  it('still reports success when the enqueue fails — the sweep heals it', async () => {
    enqueuePayoutSubmit.mockRejectedValue(new Error('pg-boss down'))
    expect(await call()).toEqual({ done: true, outcome: 'funded' })
  })
})

describe('recordManualFunding — cleared', () => {
  it('posts the cash leg for an open receivable', async () => {
    stubTransfer({ ...PENDING, state: 'FUNDED', refund_payment_ref: null })
    expect(await call({ kind: 'cleared' })).toEqual({ done: true, outcome: 'cleared' })
    expect(postLedgerTransaction).toHaveBeenCalledWith(
      expect.objectContaining({ transition: 'funding_cleared' }),
    )
  })

  it.each(['PENDING_PAYMENT', 'PAYMENT_FAILED', 'CANCELED'])(
    'skips the cash leg from %s rather than driving the receivable negative',
    async (state) => {
      stubTransfer({ ...PENDING, state, refund_payment_ref: null })
      const result = await call({ kind: 'cleared' })
      expect(result).toEqual({ done: true, outcome: 'cleared_skipped', state })
      expect(postLedgerTransaction).not.toHaveBeenCalled()
    },
  )

  it('does not require PENDING_PAYMENT — clearing happens days after funding', async () => {
    stubTransfer({ ...PENDING, state: 'COMPLETED', refund_payment_ref: null })
    expect(await call({ kind: 'cleared' })).toMatchObject({ outcome: 'cleared' })
  })
})

describe('applyFundingSucceeded outcomes', () => {
  it('reports a replay without re-posting the ledger', async () => {
    stubTransfer({ ...PENDING, state: 'FUNDED' })
    const result = await applyFundingSucceeded({
      transferId: TRANSFER_ID,
      paymentRef: 'manualpay_abc',
      eventId: 'evt_1',
      actor: 'webhook:funding',
    })
    expect(result).toEqual({ outcome: 'replayed' })
    expect(transitionTransfer).not.toHaveBeenCalled()
  })

  it('flags an enqueue failure so the caller can log it', async () => {
    enqueuePayoutSubmit.mockRejectedValue(new Error('pg-boss down'))
    const result = await applyFundingSucceeded({
      transferId: TRANSFER_ID,
      paymentRef: 'manualpay_abc',
      eventId: 'evt_1',
      actor: 'webhook:funding',
    })
    expect(result).toEqual({ outcome: 'applied', enqueueFailed: true })
  })
})
