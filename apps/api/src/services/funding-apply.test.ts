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

const holdPayoutForDispute = vi.hoisted(() => vi.fn(async (..._a: unknown[]) => true))
vi.mock('./payout-holds.js', () => ({
  holdPayoutForDispute: (...a: unknown[]) => holdPayoutForDispute(...a),
}))

const recordOpsAction = vi.hoisted(() => vi.fn(async (..._a: unknown[]) => true))
vi.mock('./ops-actions.js', () => ({
  recordOpsAction: (...a: unknown[]) => recordOpsAction(...a),
}))

const {
  recordManualFunding,
  applyFundingSucceeded,
  applyFundingReversed,
  applyFundingCleared,
  applyOnrampFunded,
  applyOnrampSettlement,
} = await import('./funding-apply.js')
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

  // Audit 2026-09-02 corner 1: the row's stamped rail decides, not the
  // deployment's. Both directions of a FUNDING_PROCESSOR flip are covered.
  it('refuses a row stamped under another rail even on a manual deployment', async () => {
    getFundingProcessor.mockReturnValue({ provider: 'manual' })
    stubTransfer({ ...PENDING, funding_processor: 'stripe', funding_payment_ref: 'pi_123' })
    const result = await call()
    expect(result).toEqual({ done: false, reason: 'processor_not_manual', provider: 'stripe' })
    expect(transitionTransfer).not.toHaveBeenCalled()
  })

  it('still records a manual-stamped row after the deployment flips to stripe', async () => {
    getFundingProcessor.mockReturnValue({ provider: 'stripe' })
    stubTransfer({ ...PENDING, funding_processor: 'manual' })
    const result = await call()
    expect(result).not.toMatchObject({ reason: 'processor_not_manual' })
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
    // The deferred rail has NO ref until the pay step creates the session, so
    // at funding time the row's ref is null and the event's is what gets
    // written. (The shared PENDING fixture carries a manual-rail ref, which a
    // funding event must never replace — the C5 ref-overwrite guard.)
    stubTransfer({ ...PENDING, funding_payment_ref: null })
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
    row = { ...PENDING, refund_payment_ref: null, funding_payment_ref: null /* deferred rail: no ref yet */ } // still PENDING_PAYMENT
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

describe('out-of-order clearing catch-up (C5 — found by the first real payment)', () => {
  // On the Checkout rail a CARD emits payment_intent.succeeded and
  // checkout.session.completed about a second apart, in either order. When
  // clearing wins, applyFundingCleared sets the flag and correctly skips its
  // ledger leg (no receivable exists yet) — and nothing would ever post that
  // leg afterwards, because a card sends no further event. The row would claim
  // cleared while the ledger carried an open receivable, permanently.
  beforeEach(() => {
    transitionTransfer.mockReset()
    postLedgerTransaction.mockReset()
    enqueuePayoutSubmit.mockReset()
    transitionTransfer.mockResolvedValue(undefined)
    postLedgerTransaction.mockResolvedValue(undefined)
    enqueuePayoutSubmit.mockResolvedValue(undefined)
  })

  /** The applier reads the row, transitions it, then the catch-up RE-READS it.
   *  The second read has to see FUNDED — the transition is a committed RPC — or
   *  the catch-up would judge the receivable still closed. Modelling that is
   *  the whole point: the fix depends on it. */
  function stubTransferThenFunded(first: unknown, second: unknown) {
    let n = 0
    from.mockImplementation(() => {
      const b: Record<string, unknown> = {}
      for (const m of ['select', 'eq', 'update']) b[m] = () => b
      const read = async () => ({ data: n++ === 0 ? first : second, error: null })
      b['maybeSingle'] = read
      b['single'] = read
      return b
    })
  }

  const succeed = () =>
    applyFundingSucceeded({
      transferId: TRANSFER_ID,
      paymentRef: 'cs_test_x',
      eventId: 'evt_completed',
      actor: 'webhook:funding',
    })

  it('posts the clearing leg when the cleared event already landed first', async () => {
    stubTransferThenFunded(
      { ...PENDING, funding_cleared: true },
      { ...PENDING, state: 'FUNDED', funding_cleared: true },
    )

    const out = await succeed()

    expect(out.outcome).toBe('applied')
    // FUNDED went through the RPC (which carries its own ledger batch), and the
    // clearing leg posted separately — the leg that was silently lost.
    expect(transitionTransfer).toHaveBeenCalledTimes(1)
    expect(postLedgerTransaction).toHaveBeenCalledTimes(1)
    expect(postLedgerTransaction.mock.calls[0]![0]).toMatchObject({
      transferId: TRANSFER_ID,
      transition: 'funding_cleared',
    })
  })

  it('posts nothing extra in the ordinary order — clearing arrives later on its own', async () => {
    stubTransfer({ ...PENDING, funding_cleared: false })

    const out = await succeed()

    expect(out.outcome).toBe('applied')
    expect(transitionTransfer).toHaveBeenCalledTimes(1)
    expect(postLedgerTransaction).not.toHaveBeenCalled()
  })

  it('still funds and still enqueues the payout when the catch-up itself fails', async () => {
    // FUNDED is committed and cannot be unwound, so a clearing failure is
    // reported, never thrown — a funded transfer must still get its payout.
    stubTransferThenFunded(
      { ...PENDING, funding_cleared: true },
      { ...PENDING, state: 'FUNDED', funding_cleared: true },
    )
    postLedgerTransaction.mockRejectedValueOnce(new Error('ledger down'))

    const out = await succeed()

    expect(out).toEqual({ outcome: 'applied', enqueueFailed: false })
    expect(enqueuePayoutSubmit).toHaveBeenCalledWith(TRANSFER_ID, 'api')
  })
})

describe('the concurrent race — the flag flips while FUNDED is committing', () => {
  // The two ordering bugs were fixed for the observed orders; this pins the
  // interleaving that survived them. cleared loads state (PENDING), FUNDED
  // commits, cleared sets the flag and skips on its stale state, FUNDED's
  // catch-up read the flag BEFORE the transition and saw false. Both skip;
  // the clearing leg is lost again. The fix reads the flag AFTER the commit.
  beforeEach(() => {
    transitionTransfer.mockReset()
    postLedgerTransaction.mockReset()
    enqueuePayoutSubmit.mockReset()
    transitionTransfer.mockResolvedValue(undefined)
    postLedgerTransaction.mockResolvedValue(undefined)
    enqueuePayoutSubmit.mockResolvedValue(undefined)
  })

  /** Reads in order: the pre-load (flag false), the post-transition re-read
   *  (flag TRUE — a concurrent cleared landed in the gap), then the row the
   *  catch-up's own cleared read sees (FUNDED). */
  function stubRaceReads() {
    const reads = [
      { ...PENDING, funding_cleared: false, funding_payment_ref: 'cs_race' },
      { funding_cleared: true },
      { ...PENDING, state: 'FUNDED', funding_cleared: true, funding_payment_ref: 'cs_race' },
    ]
    let n = 0
    from.mockImplementation(() => {
      const b: Record<string, unknown> = {}
      for (const m of ['select', 'eq', 'update']) b[m] = () => b
      const read = async () => ({ data: reads[Math.min(n++, reads.length - 1)], error: null })
      b['maybeSingle'] = read
      b['single'] = read
      return b
    })
  }

  it('posts the clearing leg when the flag was false at load but true after the commit', async () => {
    stubRaceReads()
    const out = await applyFundingSucceeded({
      transferId: TRANSFER_ID,
      paymentRef: 'cs_race',
      eventId: 'evt_race',
      actor: 'webhook:funding',
    })
    expect(out.outcome).toBe('applied')
    expect(postLedgerTransaction).toHaveBeenCalledTimes(1)
    expect(postLedgerTransaction.mock.calls[0]![0]).toMatchObject({ transition: 'funding_cleared' })
  })

  it('applyFundingCleared judges the receivable from a read taken AFTER its update', async () => {
    // First read is what the update-then-read order produces: FUNDED. If the
    // implementation ever regresses to reading before updating, a PENDING
    // pre-read would make it skip — this stub has no such row to hand it.
    stubTransfer({ ...PENDING, state: 'FUNDED', funding_cleared: true, refund_payment_ref: null })
    const { applyFundingCleared } = await import('./funding-apply.js')
    const out = await applyFundingCleared({ transferId: TRANSFER_ID })
    expect(out).toEqual({ outcome: 'applied' })
    expect(postLedgerTransaction).toHaveBeenCalledTimes(1)
  })
})

describe('a funding event never replaces the ref initiation persisted (C5 — the ACH overwrite)', () => {
  beforeEach(() => {
    transitionTransfer.mockReset()
    postLedgerTransaction.mockReset()
    enqueuePayoutSubmit.mockReset()
    transitionTransfer.mockResolvedValue(undefined)
    enqueuePayoutSubmit.mockResolvedValue(undefined)
  })

  const succeedWith = (paymentRef: string) =>
    applyFundingSucceeded({ transferId: TRANSFER_ID, paymentRef, eventId: 'evt_x', actor: 'webhook:funding' })

  it('keeps the persisted cs_ ref when the funding event carries a pi_ ref', async () => {
    // The RPC coalesces (new ?? existing); passing the event's ref would win.
    // On 2026-09-10 payment_intent.processing did exactly that to f07c8e67,
    // after which void/refund — which retrieve the Session by this ref —
    // threw on a 404.
    stubTransfer({ ...PENDING, funding_cleared: false, funding_payment_ref: 'cs_test_persisted' })
    await succeedWith('pi_from_event')
    expect(transitionTransfer).toHaveBeenCalledTimes(1)
    expect(transitionTransfer.mock.calls[0]![0]).toMatchObject({ fundingPaymentRef: 'cs_test_persisted' })
  })

  it('writes the event ref only when initiation persisted none — the deferred crypto rail', async () => {
    stubTransfer({ ...PENDING, funding_cleared: false, funding_payment_ref: null })
    await succeedWith('cos_from_pay_step')
    expect(transitionTransfer.mock.calls[0]![0]).toMatchObject({ fundingPaymentRef: 'cos_from_pay_step' })
  })
})

// ---------------------------------------------------------------------------
// applyFundingReversed — THE LOSS PATH.
//
// The only place the system recognizes money it has LOST, so each arm is
// pinned: what is booked, what is stopped, and what is merely paged. Getting
// the branch wrong either invents money (booking a loss on pesos we still
// hold) or hides one (paying out against a clawback).
// ---------------------------------------------------------------------------

const USER_ID = 'dddddddd-1111-4222-8333-444444444444'

const reversibleRow = (overrides: Record<string, unknown> = {}) => ({
  id: TRANSFER_ID,
  state: 'COMPLETED',
  user_id: USER_ID,
  send_amount_minor: 5000,
  fee_amount_minor: 100,
  margin_minor: 0,
  funding_cleared: true,
  funding_payment_ref: 'pi_123',
  ...overrides,
})

/** The transfer read, then the sender-freeze update. `frozen` false means the
 *  sender was ALREADY suspended (a second dispute), which must not re-page. */
function stubReversal(row: unknown, frozen = true) {
  let call = 0
  from.mockImplementation(() => {
    const b: Record<string, unknown> = {}
    for (const m of ['select', 'eq', 'update', 'neq']) b[m] = () => b
    b['single'] = async () => ({ data: row, error: null })
    b['maybeSingle'] = async () => ({ data: row, error: null })
    ;(b as { then?: unknown }).then = (r: (v: unknown) => void) =>
      r({ data: frozen ? [{ id: USER_ID }] : [], error: null })
    call += 1
    return b
  })
  return () => call
}

const reverse = () =>
  applyFundingReversed({
    transferId: TRANSFER_ID,
    paymentRef: 'pi_123',
    eventId: 'evt_1',
    actor: 'system:funding_webhook',
    reason: 'fraudulent',
  })

describe('applyFundingReversed', () => {
  beforeEach(() => {
    transitionTransfer.mockReset().mockResolvedValue({})
    holdPayoutForDispute.mockReset().mockResolvedValue(true)
    recordOpsAction.mockReset().mockResolvedValue(true)
  })

  it('COMPLETED + cleared: books the loss against CASH and freezes the sender', async () => {
    stubReversal(reversibleRow())

    const out = await reverse()

    expect(out).toEqual({ outcome: 'reversed', frozen: true, cleared: true })
    const arg = transitionTransfer.mock.calls[0]![0] as Record<string, unknown>
    expect(arg['fromState']).toBe('COMPLETED')
    expect(arg['toState']).toBe('FUNDING_REVERSED')
    // send + fee, the whole sum collected.
    expect(arg['ledgerEntries']).toEqual([
      { account_code: 'loss_funding_reversed', direction: 'debit', amount_minor: 5100, currency: 'USD' },
      { account_code: 'cash_clearing', direction: 'credit', amount_minor: 5100, currency: 'USD' },
    ])
  })

  it('COMPLETED + NOT cleared: credits the RECEIVABLE, never cash that never arrived', async () => {
    // The ACH returned while the pull was still in flight. Crediting
    // cash_clearing here would claim a withdrawal from money we never held and
    // strand funding_receivable open forever.
    stubReversal(reversibleRow({ funding_cleared: false }))

    const out = await reverse()

    expect(out).toEqual({ outcome: 'reversed', frozen: true, cleared: false })
    const arg = transitionTransfer.mock.calls[0]![0] as Record<string, unknown>
    expect(arg['ledgerEntries']).toEqual([
      { account_code: 'loss_funding_reversed', direction: 'debit', amount_minor: 5100, currency: 'USD' },
      { account_code: 'funding_receivable', direction: 'credit', amount_minor: 5100, currency: 'USD' },
    ])
  })

  it('FUNDED: stops the payout and books NOTHING — nothing is lost yet', async () => {
    stubReversal(reversibleRow({ state: 'FUNDED' }))

    const out = await reverse()

    expect(out).toEqual({ outcome: 'held', frozen: true, held: true })
    expect(holdPayoutForDispute).toHaveBeenCalledWith(TRANSFER_ID)
    expect(transitionTransfer).not.toHaveBeenCalled()
  })

  it.each(['SUBMITTED', 'IN_FLIGHT'])(
    '%s: cannot stop it and cannot book it — reports for a human, freezes anyway',
    async (state) => {
      stubReversal(reversibleRow({ state }))

      const out = await reverse()

      expect(out).toEqual({ outcome: 'in_flight', state, frozen: true })
      expect(transitionTransfer).not.toHaveBeenCalled()
      expect(holdPayoutForDispute).not.toHaveBeenCalled()
    },
  )

  it('REFUNDED: no open exposure, but still a fraud signal worth freezing on', async () => {
    stubReversal(reversibleRow({ state: 'REFUNDED' }))

    const out = await reverse()

    expect(out).toEqual({ outcome: 'no_exposure', state: 'REFUNDED', frozen: true })
    expect(transitionTransfer).not.toHaveBeenCalled()
  })

  it('already FUNDING_REVERSED: a replay books nothing and does not re-freeze', async () => {
    stubReversal(reversibleRow({ state: 'FUNDING_REVERSED' }))

    expect(await reverse()).toEqual({ outcome: 'replayed' })
    expect(transitionTransfer).not.toHaveBeenCalled()
    // The freeze read must not even run — a redelivered dispute is not news.
    expect(holdPayoutForDispute).not.toHaveBeenCalled()
  })

  it('an already-suspended sender reports frozen:false so the page does not repeat', async () => {
    stubReversal(reversibleRow(), false)
    expect(await reverse()).toEqual({ outcome: 'reversed', frozen: false, cleared: true })
    // And writes no second audit row for a freeze that did not happen.
    expect(recordOpsAction).not.toHaveBeenCalled()
  })

  it('the freeze leaves an audit row tying the frozen account to the disputed transfer', async () => {
    // Without this the only evidence is users.status and a Sentry event: an
    // auditor could not say when the freeze happened or what caused it.
    stubReversal(reversibleRow())

    await reverse()

    expect(recordOpsAction).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'sender_freeze',
        transferId: TRANSFER_ID,
        reason: 'fraudulent',
        before: { status: 'active' },
        after: { status: 'suspended', eventId: 'evt_1' },
      }),
      expect.anything(),
    )
  })

  it('unknown transfer: nothing to act on', async () => {
    stubReversal(null)
    expect(await reverse()).toEqual({ outcome: 'unknown_transfer' })
    expect(transitionTransfer).not.toHaveBeenCalled()
  })

  it('a lost transition race is stale, never forced', async () => {
    stubReversal(reversibleRow())
    transitionTransfer.mockRejectedValue(new TransferRpcError('transition_conflict'))
    expect(await reverse()).toEqual({ outcome: 'stale' })
  })
})

describe('applyFundingCleared — the loss path already closed the receivable', () => {
  it('skips the cash leg on a FUNDING_REVERSED transfer, never crediting the receivable twice', async () => {
    // The double-credit: a dispute on an UNCLEARED transfer writes the
    // receivable off (CR funding_receivable). A clearing arriving afterwards —
    // late, redelivered, or via the out-of-order catch-up — would credit the
    // SAME receivable again while debiting cash once. Unbalanced ledger,
    // negative funding_receivable.
    stubReversal(reversibleRow({ state: 'FUNDING_REVERSED' }))

    const out = await applyFundingCleared({ transferId: TRANSFER_ID })

    expect(out).toEqual({ outcome: 'skipped', state: 'FUNDING_REVERSED' })
    expect(postLedgerTransaction).not.toHaveBeenCalled()
  })
})
