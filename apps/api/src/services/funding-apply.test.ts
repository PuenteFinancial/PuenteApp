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

const { recordManualFunding, applyFundingSucceeded, applyOnrampFunded, applyOnrampSettlement } =
  await import('./funding-apply.js')
const { TransferRpcError } = await import('./transfers.js')

const TRANSFER_ID = 'cccccccc-1111-4222-8333-444444444444'
const OPERATOR = 'aaaaaaaa-1111-4222-8333-444444444444'
const EXTERNAL_REF = 'c8617cef-1adf-4dba-b978-c68150901663'

const PENDING = {
  id: TRANSFER_ID,
  state: 'PENDING_PAYMENT',
  send_amount_minor: 5000,
  fee_amount_minor: 100,
  margin_minor: 0,
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

describe('applyOnrampFunded — the amount guard (#213)', () => {
  // PENDING's send+fee = 5100 cents = 51_000_000 USDC micro-units.
  const MATCHING = 51_000_000

  function funded(deliveredAmountMicro?: number) {
    return applyOnrampFunded({
      transferId: TRANSFER_ID,
      paymentRef: 'cos_guard_1',
      eventId: 'evt_guard_1',
      ...(deliveredAmountMicro !== undefined && { deliveredAmountMicro }),
    })
  }

  it('a to-the-cent match delegates to the shared FUNDED applier', async () => {
    const result = await funded(MATCHING)
    expect(result).toEqual({ outcome: 'applied', enqueueFailed: false })
    const transition = transitionTransfer.mock.calls[0]![0] as Record<string, unknown>
    expect(transition['toState']).toBe('FUNDED')
    expect(transition['fundingPaymentRef']).toBe('cos_guard_1')
    expect(enqueuePayoutSubmit).toHaveBeenCalledWith(TRANSFER_ID, 'api')
  })

  it('THE DRILL: an underpaid session funds nothing and releases no payout', async () => {
    // The widget's amount field is user-editable — a sender who edits $51
    // down to $1.04 must not buy a full MXN delivery.
    const result = await funded(1_040_000)
    expect(result).toEqual({
      outcome: 'amount_mismatch',
      expectedMinor: 5100,
      deliveredAmountMicro: 1_040_000,
    })
    expect(transitionTransfer).not.toHaveBeenCalled()
    expect(enqueuePayoutSubmit).not.toHaveBeenCalled()
    expect(postLedgerTransaction).not.toHaveBeenCalled()
  })

  it('an overpaid session is refused the same way — unbooked treasury money is a review case', async () => {
    const result = await funded(60_000_000)
    expect(result).toMatchObject({ outcome: 'amount_mismatch', expectedMinor: 5100 })
    expect(transitionTransfer).not.toHaveBeenCalled()
  })

  it('an event with NO parseable amount refuses — fail closed, never fund unverified', async () => {
    const result = await funded(undefined)
    expect(result).toEqual({
      outcome: 'amount_mismatch',
      expectedMinor: 5100,
      deliveredAmountMicro: null,
    })
    expect(transitionTransfer).not.toHaveBeenCalled()
  })

  it('a sub-cent discrepancy is a mismatch — exact or nothing', async () => {
    expect(await funded(MATCHING - 1)).toMatchObject({ outcome: 'amount_mismatch' })
  })

  it('replays short-circuit BEFORE the guard — settled history never pages', async () => {
    stubTransfer({ ...PENDING, state: 'FUNDED' })
    expect(await funded(1)).toEqual({ outcome: 'replayed' })
  })

  it('unknown transfers stay the ack-and-log path', async () => {
    stubTransfer(null)
    expect(await funded(MATCHING)).toEqual({ outcome: 'unknown_transfer' })
  })
})

describe('applyOnrampSettlement (#213)', () => {
  const SESSION_REF = 'cos_settle_1'

  // Live row the stub reads on EVERY select, so a transition mid-call is
  // visible to the next read — the out-of-order catch-up depends on exactly
  // that (FUNDED must be observable by the cleared leg's own load).
  let row: Record<string, unknown>

  function stubLiveTransfer() {
    from.mockImplementation(() => {
      const b: Record<string, unknown> = {}
      for (const m of ['select', 'eq', 'update']) b[m] = () => b
      b['maybeSingle'] = async () => ({ data: { ...row }, error: null })
      b['single'] = async () => ({ data: { ...row }, error: null })
      return b
    })
  }

  // PENDING's send+fee = 5100 cents → 51_000_000 USDC micro-units. The guard
  // demands the match on every call, so the helper passes it by default and
  // the mismatch tests override it.
  const MATCHING_MICRO = 51_000_000

  /** Narrows away the mismatch arm for tests asserting the settled shape. */
  function settled(result: Awaited<ReturnType<typeof settle>>) {
    if ('outcome' in result) throw new Error(`unexpected amount mismatch: ${JSON.stringify(result)}`)
    return result
  }

  function settle(deliveredAmountMicro: number | 'absent' = MATCHING_MICRO) {
    return applyOnrampSettlement({
      transferId: TRANSFER_ID,
      paymentRef: SESSION_REF,
      eventId: 'evt_complete_1',
      ...(deliveredAmountMicro !== 'absent' && { deliveredAmountMicro }),
    })
  }

  beforeEach(() => {
    row = { ...PENDING, state: 'FUNDED', refund_payment_ref: null }
    stubLiveTransfer()
  })

  it('normal order: posts the cash leg then the float top-up, no transition', async () => {
    const result = settled(await settle())

    expect(result.caughtUp).toBe(false)
    expect(result.cleared).toEqual({ outcome: 'applied' })
    expect(result.floatTopUpKey).toBe(`float_topup:${SESSION_REF}`)
    expect(transitionTransfer).not.toHaveBeenCalled()

    expect(postLedgerTransaction).toHaveBeenCalledTimes(2)
    const cashLeg = postLedgerTransaction.mock.calls[0]![0] as Record<string, unknown>
    expect(cashLeg['transition']).toBe('funding_cleared')
    const topUp = postLedgerTransaction.mock.calls[1]![0] as {
      idempotencyKey: string
      entries: { accountCode: string; direction: string; money: { amountMinor: number } }[]
    }
    // Keyed on the session id: a redelivered fulfillment_complete re-derives
    // the SAME key, so the DB uniqueness makes the replay a no-op.
    expect(topUp.idempotencyKey).toBe(`float_topup:${SESSION_REF}`)
    // send+fee — the session's destination_amount at USDC≈USD par
    expect(topUp.entries).toEqual([
      expect.objectContaining({
        accountCode: 'bridge_wallet_float',
        direction: 'debit',
        money: { amountMinor: 5100, currency: 'USD' },
      }),
      expect.objectContaining({
        accountCode: 'cash_clearing',
        direction: 'credit',
        money: { amountMinor: 5100, currency: 'USD' },
      }),
    ])
  })

  it('out-of-order: catches up PENDING_PAYMENT → FUNDED before the cash leg', async () => {
    row = { ...PENDING, refund_payment_ref: null } // still PENDING_PAYMENT
    transitionTransfer.mockImplementation(async () => {
      row['state'] = 'FUNDED'
      return { id: TRANSFER_ID }
    })

    const result = settled(await settle())

    expect(result.caughtUp).toBe(true)
    expect(result.cleared).toEqual({ outcome: 'applied' })
    expect(result.floatTopUpKey).toBe(`float_topup:${SESSION_REF}`)

    // FUNDED first (with its ledger batch inside the transition), THEN the
    // cash leg, THEN the top-up — applyFundingCleared alone would have read
    // PENDING_PAYMENT as receivable-never-opened and stranded it.
    expect(transitionTransfer).toHaveBeenCalledTimes(1)
    const transition = transitionTransfer.mock.calls[0]![0] as Record<string, unknown>
    expect(transition['fromState']).toBe('PENDING_PAYMENT')
    expect(transition['toState']).toBe('FUNDED')
    expect(transition['fundingPaymentRef']).toBe(SESSION_REF)
    expect(postLedgerTransaction).toHaveBeenCalledTimes(2)
    expect(enqueuePayoutSubmit).toHaveBeenCalledWith(TRANSFER_ID, 'api')
  })

  it.each(['CANCELED', 'PAYMENT_FAILED'])(
    'suppresses the top-up when the cash leg skips (%s) — a closed receivable books nothing',
    async (state) => {
      row = { ...PENDING, state, refund_payment_ref: null }
      const result = settled(await settle())
      expect(result.cleared).toEqual({ outcome: 'skipped', state })
      expect(result.floatTopUpKey).toBeNull()
      expect(postLedgerTransaction).not.toHaveBeenCalled()
    },
  )

  it('lost catch-up race falls through to the cleared leg rather than failing', async () => {
    row = { ...PENDING, refund_payment_ref: null }
    // Another actor (the late processing webhook) wins between read and RPC —
    // but the row IS funded now, so the cash leg must still post.
    transitionTransfer.mockImplementation(async () => {
      row['state'] = 'FUNDED'
      throw new TransferRpcError('transition_conflict')
    })

    const result = settled(await settle())
    expect(result.caughtUp).toBe(false)
    expect(result.cleared).toEqual({ outcome: 'applied' })
    expect(result.floatTopUpKey).toBe(`float_topup:${SESSION_REF}`)
  })

  it('unknown transfer: skips everything without throwing', async () => {
    stubTransfer(null)
    const result = settled(await settle())
    expect(result).toEqual({
      caughtUp: false,
      cleared: { outcome: 'skipped', state: 'unknown' },
      floatTopUpKey: null,
    })
    expect(postLedgerTransaction).not.toHaveBeenCalled()
  })

  it('refuses every leg on an underpaid fulfillment_complete', async () => {
    const result = await settle(1_040_000)
    expect(result).toEqual({
      outcome: 'amount_mismatch',
      expectedMinor: 5100,
      deliveredAmountMicro: 1_040_000,
    })
    expect(transitionTransfer).not.toHaveBeenCalled()
    expect(postLedgerTransaction).not.toHaveBeenCalled()
  })

  it('refuses when the event carries no amount — fail closed even at settlement', async () => {
    const result = await settle('absent')
    expect(result).toMatchObject({ outcome: 'amount_mismatch', deliveredAmountMicro: null })
    expect(postLedgerTransaction).not.toHaveBeenCalled()
  })

  it('the guard also fronts the out-of-order catch-up — an underpaid complete never drives FUNDED', async () => {
    row = { ...PENDING, refund_payment_ref: null } // still PENDING_PAYMENT
    const result = await settle(1_040_000)
    expect(result).toMatchObject({ outcome: 'amount_mismatch' })
    expect(transitionTransfer).not.toHaveBeenCalled()
    expect(enqueuePayoutSubmit).not.toHaveBeenCalled()
  })

  it('replay: identical keys on every leg, so the DB uniqueness absorbs it', async () => {
    await settle()
    await settle()
    // Four posts across two runs — but only two DISTINCT identities: the
    // (transfer, funding_cleared) transition and float_topup:<session>.
    const keys = postLedgerTransaction.mock.calls.map((c) => {
      const arg = c[0] as { transition?: string; idempotencyKey?: string }
      return arg.transition ?? arg.idempotencyKey
    })
    expect(keys).toEqual([
      'funding_cleared',
      `float_topup:${SESSION_REF}`,
      'funding_cleared',
      `float_topup:${SESSION_REF}`,
    ])
    expect(transitionTransfer).not.toHaveBeenCalled()
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
