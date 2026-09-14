import { describe, it, expect, beforeEach, vi } from 'vitest'

// The ops cancel of an undeliverable payout (FUNDED → CANCELED → REFUNDED).
// Same rig as refunds.test.ts: hoisted `from` spy, thenable chain builder,
// dynamic import after the mocks are in place. The ledger-entry builders and
// claimRefund are the REAL ones — the batches are asserted line-for-line, and
// the claim is the lock this tail shares with the other two.

const from = vi.hoisted(() => vi.fn())
vi.mock('./supabase.js', () => ({ supabaseAdmin: { from: (...a: unknown[]) => from(...a) } }))

const opsCancel = vi.hoisted(() => vi.fn())
const transition = vi.hoisted(() => vi.fn())
vi.mock('./transfers.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./transfers.js')>()
  return {
    ...actual,
    opsCancelHeldTransfer: (...a: unknown[]) => opsCancel(...a),
    transitionTransfer: (...a: unknown[]) => transition(...a),
  }
})

const processorRefund = vi.hoisted(() => vi.fn())
// Mutable so a test can make the rail expose a dispute check, or not expose one.
const disputeStatus = vi.hoisted(() => ({ impl: null as null | ((...a: unknown[]) => unknown) }))
vi.mock('./funding/index.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./funding/index.js')>()
  // real undoModeForRef / undoRequiresManualDisbursement — the settle picks its
  // batch off the ref prefix on the crash-recovery path
  // Built PER CALL, not once: the absence of getDisputeStatus is itself a case
  // (a rail that cannot be disputed must still be cancelable), so a test needs
  // to add and remove the method between runs. A single object captured in this
  // factory would freeze whatever `disputeStatus.impl` was at import time —
  // which it did, and every interlock test silently fell through to the claim.
  const make = () => ({
    refund: (...a: unknown[]) => processorRefund(...a),
    ...(disputeStatus.impl
      ? { getDisputeStatus: (...a: unknown[]) => disputeStatus.impl!(...a) }
      : {}),
  })
  return { ...actual, getFundingProcessor: make, processorFor: make }
})

const recordOpsAction = vi.hoisted(() => vi.fn())
vi.mock('./ops-actions.js', () => ({
  recordOpsAction: (...a: unknown[]) => recordOpsAction(...a),
}))

const captureMessage = vi.hoisted(() => vi.fn())
const setFingerprint = vi.hoisted(() => vi.fn())
vi.mock('@sentry/node', () => ({
  withScope: (fn: (s: unknown) => void) => fn({ setFingerprint, setContext: vi.fn() }),
  captureMessage: (...a: unknown[]) => captureMessage(...a),
}))

const {
  cancelHeldTransfer,
  verifyFundingNotDisputed,
  cancelRefusal,
  listHeldTransfers,
  CANCELABLE_HOLD_REASONS,
} = await import('./ops-cancel.js')
const {
  cancelRefundOwedLedgerEntries,
  refundOwedPaidLedgerEntries,
  refundOwedVoidedLedgerEntries,
  TransferRpcError,
} = await import('./transfers.js')

// ── PostgREST-ish builder (refunds.test.ts) ─────────────────────────────────
const queues: Record<string, unknown[]> = {}
const filters: Array<{ table: string; method: string; args: unknown[] }> = []

function q(table: string, ...results: unknown[]): void {
  queues[table] = (queues[table] ?? []).concat(results)
}

function chain(table: string, result: unknown): Record<string, unknown> {
  const c: Record<string, unknown> = {}
  for (const m of ['select', 'eq', 'is', 'not', 'in', 'or', 'lt', 'limit', 'update']) {
    c[m] = (...args: unknown[]) => {
      filters.push({ table, method: m, args })
      return c
    }
  }
  c.maybeSingle = () => Promise.resolve(result)
  c.then = (resolve: (v: unknown) => void) => resolve(result)
  return c
}

const T = '00000000-0000-4000-8000-000000000091'
const ACTOR = 'ops:00000000-0000-4000-8000-0000000000aa'
const S = 500
const MARGIN = 5

const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() }

// The shape of the staging rows this exists for: FUNDED, payability-held, never
// claimed by the submit job, never at Bridge, funding already cleared.
const held = (over: Record<string, unknown> = {}) => ({
  data: {
    id: T,
    state: 'FUNDED',
    send_amount_minor: S,
    fee_amount_minor: 0,
    margin_minor: MARGIN,
    payout_hold_reason: 'payability',
    payout_held_at: '2026-09-09T22:11:47.807Z',
    submit_attempted_at: null,
    provider_transfer_ref: null,
    funding_payment_ref: 'cs_test_1',
    funding_processor: 'stripe_checkout',
    funding_cleared: true,
    funding_disputed_at: null,
    idempotency_key: 'bridge-key-1',
    refund_payment_ref: null,
    refund_claimed_at: null,
    refund_claimed_by: null,
    payout_destination_id: 'dest-1',
    created_at: '2026-09-09T21:57:01.775Z',
    ...over,
  },
  error: null,
})

const row = (over: Record<string, unknown> = {}) =>
  ({ ...held().data, ...over }) as Record<string, unknown>

// The resume guard reads the FUNDED → CANCELED transition's metadata; our RPC
// stamps the hold reason there and the sender's cancel_transfer writes {}.
const opsTransition = { data: [{ metadata: { payout_hold_reason: 'payability' } }], error: null }
const senderTransition = { data: [{ metadata: {} }], error: null }

const claimWon = { data: [{ id: T }], error: null }
const claimLost = { data: [], error: null }
const persistOk = { data: null, error: null }

const minutesAgo = (n: number) => new Date(Date.now() - n * 60_000).toISOString()

const input = (over: Record<string, unknown> = {}) => ({
  transferId: T,
  actor: ACTOR,
  holdReason: 'payability' as const,
  note: 'sandbox destination has no SPEI endorsement; Bridge will never pay it',
  requestId: null,
  ...over,
})

beforeEach(() => {
  vi.clearAllMocks()
  for (const k of Object.keys(queues)) delete queues[k]
  filters.length = 0
  opsCancel.mockImplementation(async () =>
    row({ state: 'CANCELED', payout_hold_reason: null, payout_held_at: null }),
  )
  transition.mockResolvedValue({ id: T, state: 'REFUNDED' })
  processorRefund.mockResolvedValue({
    provider: 'stripe_checkout',
    ref: 're_1',
    status: 'pending',
    mode: 'refunded',
  })
  recordOpsAction.mockResolvedValue(true)
  disputeStatus.impl = null
  from.mockImplementation((table: string) =>
    chain(table, queues[table]?.shift() ?? { data: null, error: null }),
  )
})

describe('cancelRefusal', () => {
  const t = (over: Record<string, unknown> = {}) => held(over).data as never

  it('passes a FUNDED row held for exactly the confirmed reason', () => {
    expect(cancelRefusal(t(), 'payability')).toBeNull()
  })

  it('refuses a missing transfer', () => {
    expect(cancelRefusal(null, 'payability')).toEqual({ done: false, reason: 'transfer_not_found' })
  })

  it('refuses anything that is not FUNDED', () => {
    expect(cancelRefusal(t({ state: 'SUBMITTED' }), 'payability')).toEqual({
      done: false,
      reason: 'not_funded',
      state: 'SUBMITTED',
    })
  })

  // The binding slice-6 contract: the submit job stamps submit_attempted_at
  // while the state still reads FUNDED, so a state-only check would let a
  // cancel commit mid-Bridge-POST.
  it.each([
    ['a claimed row', { submit_attempted_at: minutesAgo(1) }],
    ['a row with a Bridge payout', { provider_transfer_ref: 'bridge_tr_1' }],
  ])('refuses %s', (_label, over) => {
    expect(cancelRefusal(t(over), 'payability')).toEqual({
      done: false,
      reason: 'submit_in_progress',
    })
  })

  it('refuses an unheld row — nothing here cancels a healthy payout', () => {
    expect(cancelRefusal(t({ payout_hold_reason: null }), 'payability')).toEqual({
      done: false,
      reason: 'not_held',
    })
  })

  // The loss-path holds are excluded on purpose: the funding is being clawed
  // back, so refunding the sender pays them twice.
  it.each(['funding_disputed', 'sender_suspended', 'sender_kyc_pending'])(
    'refuses a %s hold with the reason that names where it belongs',
    (reason) => {
      expect(cancelRefusal(t({ payout_hold_reason: reason }), 'payability')).toEqual({
        done: false,
        reason: 'hold_not_cancelable',
        actual: reason,
      })
    },
  )

  it('refuses when the hold changed to another cancelable reason underneath', () => {
    expect(cancelRefusal(t({ payout_hold_reason: 'fx_drift' }), 'payability')).toEqual({
      done: false,
      reason: 'hold_reason_mismatch',
      actual: 'fx_drift',
    })
  })

  it('never lets a loss-path hold reach the mismatch branch', () => {
    // Exhaustive over the enum: whichever reason the operator confirms, a
    // funding_disputed row must refuse as hold_not_cancelable — the message
    // that sends them to the loss path, not to hunt a race.
    for (const confirmed of CANCELABLE_HOLD_REASONS) {
      expect(cancelRefusal(t({ payout_hold_reason: 'funding_disputed' }), confirmed)).toMatchObject(
        { reason: 'hold_not_cancelable' },
      )
    }
  })
})

describe('cancelHeldTransfer', () => {
  it('cancels, disburses once, and settles REFUNDED with the two keyed batches', async () => {
    q('transfers', held(), claimWon, persistOk) // load, claim, ref persist

    await expect(cancelHeldTransfer(input(), log)).resolves.toEqual({
      done: true,
      outcome: 'canceled_and_refunded',
    })

    // 1) the cancel — the hold reason is the compare-and-swap, and the batch is
    //    the recognize half, NOT the sender-cancel reversal.
    expect(opsCancel).toHaveBeenCalledTimes(1)
    expect(opsCancel.mock.calls[0]![0]).toMatchObject({
      transferId: T,
      actor: ACTOR,
      holdReason: 'payability',
      ledgerEntries: cancelRefundOwedLedgerEntries({
        send_amount_minor: S,
        fee_amount_minor: 0,
        margin_minor: MARGIN,
      }),
    })

    // 2) the disbursement — the ROW's rail, the shared `:refund` sub-key, the
    //    full send + fee.
    expect(processorRefund).toHaveBeenCalledTimes(1)
    expect(processorRefund.mock.calls[0]![0]).toEqual({
      transferId: T,
      paymentRef: 'cs_test_1',
      amountMinor: S,
      currency: 'USD',
      idempotencyKey: 'bridge-key-1:refund',
    })

    // 3) the settle — the batch the undo's MODE selected, under its own key.
    expect(transition).toHaveBeenCalledTimes(1)
    expect(transition.mock.calls[0]![0]).toMatchObject({
      transferId: T,
      fromState: 'CANCELED',
      toState: 'REFUNDED',
      actor: ACTOR,
      ledgerEntries: refundOwedPaidLedgerEntries({
        send_amount_minor: S,
        fee_amount_minor: 0,
        margin_minor: MARGIN,
      }),
    })
  })

  // The order IS the safety property: once the state leaves FUNDED no payout
  // can be created by any path, so the cancel must commit before the processor
  // is called — not after.
  it('cancels BEFORE it touches the processor', async () => {
    const order: string[] = []
    opsCancel.mockImplementation(async () => {
      order.push('cancel')
      return row({ state: 'CANCELED', payout_hold_reason: null })
    })
    processorRefund.mockImplementation(async () => {
      order.push('refund')
      return { provider: 'stripe_checkout', ref: 're_1', status: 'pending', mode: 'refunded' }
    })
    q('transfers', held(), claimWon, persistOk)

    await cancelHeldTransfer(input(), log)

    expect(order).toEqual(['cancel', 'refund'])
  })

  it('posts the VOIDED settle batch when the pull was canceled instead of refunded', async () => {
    processorRefund.mockResolvedValue({
      provider: 'stripe_checkout',
      ref: 'pi_1',
      status: 'succeeded',
      mode: 'voided',
    })
    q('transfers', held(), claimWon, persistOk)

    await expect(cancelHeldTransfer(input(), log)).resolves.toEqual({
      done: true,
      outcome: 'canceled_and_refunded',
    })
    expect(transition.mock.calls[0]![0]).toMatchObject({
      ledgerEntries: refundOwedVoidedLedgerEntries({
        send_amount_minor: S,
        fee_amount_minor: 0,
        margin_minor: MARGIN,
      }),
    })
  })

  it('resumes an already-CANCELED row without re-cancelling or double-paying', async () => {
    // A prior run died between the cancel and the disbursement.
    q('transfer_transitions', opsTransition)
    q('transfers', held({ state: 'CANCELED', payout_hold_reason: null }), claimWon, persistOk)

    await expect(cancelHeldTransfer(input(), log)).resolves.toEqual({
      done: true,
      outcome: 'canceled_and_refunded',
    })
    expect(opsCancel).not.toHaveBeenCalled()
    expect(processorRefund).toHaveBeenCalledTimes(1)
  })

  it('finishes a row whose disbursement already went out, paying nothing more', async () => {
    // The crash-recovery shape: ref persisted, state never settled. The mode
    // comes off the ref namespace — `re_` is unknown, so `refunded`.
    q('transfer_transitions', opsTransition)
    q('transfers', held({ state: 'CANCELED', refund_payment_ref: 're_1' }))

    await expect(cancelHeldTransfer(input(), log)).resolves.toEqual({
      done: true,
      outcome: 'already_disbursed',
    })
    expect(processorRefund).not.toHaveBeenCalled()
    expect(transition.mock.calls[0]![0]).toMatchObject({
      ledgerEntries: refundOwedPaidLedgerEntries({
        send_amount_minor: S,
        fee_amount_minor: 0,
        margin_minor: MARGIN,
      }),
    })
  })

  it('recovers the VOIDED mode from a persisted pi_ ref alone', async () => {
    q('transfer_transitions', opsTransition)
    q('transfers', held({ state: 'CANCELED', refund_payment_ref: 'pi_1' }))

    await cancelHeldTransfer(input(), log)

    expect(transition.mock.calls[0]![0]).toMatchObject({
      ledgerEntries: refundOwedVoidedLedgerEntries({
        send_amount_minor: S,
        fee_amount_minor: 0,
        margin_minor: MARGIN,
      }),
    })
  })

  it('writes nothing at all on an already-REFUNDED row', async () => {
    q('transfers', held({ state: 'REFUNDED', refund_payment_ref: 're_1' }))

    await expect(cancelHeldTransfer(input(), log)).resolves.toEqual({
      done: true,
      outcome: 'already_settled',
    })
    expect(opsCancel).not.toHaveBeenCalled()
    expect(processorRefund).not.toHaveBeenCalled()
    expect(transition).not.toHaveBeenCalled()
    // The operator still acted, so the row is written — it just says nothing moved.
    expect(recordOpsAction.mock.calls[0]![0]).toMatchObject({
      action: 'transfer_cancel',
      after: { outcome: 'already_settled' },
    })
  })

  it('rests at CANCELED when the undo needs a human to move the money, and pages', async () => {
    processorRefund.mockResolvedValue({
      provider: 'manual',
      ref: 'manualrefund_1',
      status: 'pending',
      mode: 'refunded',
    })
    q('transfers', held({ funding_processor: 'manual' }), claimWon, persistOk)

    await expect(cancelHeldTransfer(input(), log)).resolves.toEqual({
      done: true,
      outcome: 'awaiting_disbursement',
      refundRef: 'manualrefund_1',
    })
    // NOT settled: claiming REFUNDED would tell the sender their money came
    // back when nobody has sent it.
    expect(transition).not.toHaveBeenCalled()
    expect(captureMessage).toHaveBeenCalledWith(
      expect.stringContaining('resting at CANCELED'),
      'error',
    )
    expect(setFingerprint).toHaveBeenCalledWith(['ops-cancel-awaiting-disbursement', T])
    expect(recordOpsAction.mock.calls[0]![0]).toMatchObject({
      after: { state: 'CANCELED', outcome: 'awaiting_disbursement' },
    })
  })

  // A run that loses the claim must write NOTHING further — not the
  // disbursement and not the transition, which would replay harmlessly but
  // report this run as the one that paid.
  it('refuses on a live claim without settling the state', async () => {
    q('transfers', held(), claimLost, held({ state: 'CANCELED', refund_claimed_at: minutesAgo(1) }))

    await expect(cancelHeldTransfer(input(), log)).resolves.toMatchObject({
      done: false,
      reason: 'claim_taken',
    })
    expect(processorRefund).not.toHaveBeenCalled()
    expect(transition).not.toHaveBeenCalled()
  })

  it('distinguishes an ABANDONED claim, which pages rather than waits', async () => {
    q(
      'transfers',
      held(),
      claimLost,
      held({ state: 'CANCELED', refund_claimed_at: minutesAgo(30), refund_claimed_by: 'ops:x' }),
    )

    await expect(cancelHeldTransfer(input(), log)).resolves.toMatchObject({
      done: false,
      reason: 'claim_abandoned',
      claimedBy: 'ops:x',
    })
  })

  it('reports already_settled when the claim winner finished while we waited', async () => {
    q('transfers', held(), claimLost, held({ state: 'REFUNDED', refund_payment_ref: 're_1' }))

    await expect(cancelHeldTransfer(input(), log)).resolves.toEqual({
      done: true,
      outcome: 'already_settled',
    })
    expect(transition).not.toHaveBeenCalled()
  })

  it('re-classifies rather than forcing when the guarded UPDATE refuses', async () => {
    opsCancel.mockRejectedValue(new TransferRpcError('transfer_not_cancelable'))
    // The re-read: the hold was released underneath us and the sweep claimed it.
    q('transfers', held(), held({ payout_hold_reason: null, submit_attempted_at: minutesAgo(1) }))

    await expect(cancelHeldTransfer(input(), log)).resolves.toEqual({
      done: false,
      reason: 'submit_in_progress',
    })
    expect(processorRefund).not.toHaveBeenCalled()
  })

  it('falls back to changed_underneath when the re-read still looks cancelable', async () => {
    opsCancel.mockRejectedValue(new TransferRpcError('transfer_not_cancelable'))
    q('transfers', held(), held())

    await expect(cancelHeldTransfer(input(), log)).resolves.toEqual({
      done: false,
      reason: 'changed_underneath',
      state: 'FUNDED',
    })
  })

  it('refuses a corrupt row rather than disbursing against an empty payment ref', async () => {
    q('transfer_transitions', opsTransition)
    q('transfers', held({ state: 'CANCELED', funding_payment_ref: null }))

    await expect(cancelHeldTransfer(input(), log)).rejects.toThrow(/no funding_payment_ref/)
    expect(processorRefund).not.toHaveBeenCalled()
  })

  it('leaves the claim standing when the processor throws (never a retry green light)', async () => {
    processorRefund.mockRejectedValue(new Error('stripe timeout'))
    q('transfers', held(), claimWon)

    await expect(cancelHeldTransfer(input(), log)).rejects.toThrow('stripe timeout')
    // No update that clears the claim columns.
    const clears = filters.filter(
      (f) =>
        f.method === 'update' &&
        (f.args[0] as Record<string, unknown>)['refund_claimed_at'] === null,
    )
    expect(clears).toHaveLength(0)
  })

  it('records provenance with fixed keys and the operator note', async () => {
    q('transfers', held(), claimWon, persistOk)

    await cancelHeldTransfer(input(), log)

    expect(recordOpsAction).toHaveBeenCalledTimes(1)
    expect(recordOpsAction.mock.calls[0]![0]).toEqual({
      actor: ACTOR,
      action: 'transfer_cancel',
      transferId: T,
      reason: 'payability',
      note: input().note,
      before: {
        state: 'FUNDED',
        payoutHoldReason: 'payability',
        payoutHeldAt: '2026-09-09T22:11:47.807Z',
        fundingCleared: true,
      },
      after: { state: 'REFUNDED', outcome: 'canceled_and_refunded', undoMode: 'refunded' },
      requestId: null,
    })
  })

  // THE DOUBLE-BOOK THIS GUARD EXISTS FOR. A row resting at CANCELED from the
  // SENDER's cancel already posted the FUNDED-batch reversal, so refunds_payable
  // was never credited. Settling it here would debit a liability that does not
  // exist and credit cash a second time.
  it('refuses to finish a CANCELED row that the SENDER canceled', async () => {
    q('transfer_transitions', senderTransition)
    q('transfers', held({ state: 'CANCELED', refund_payment_ref: 'manualrefund_1' }))

    await expect(cancelHeldTransfer(input(), log)).resolves.toEqual({
      done: false,
      reason: 'not_our_cancel',
    })
    expect(transition).not.toHaveBeenCalled()
    expect(processorRefund).not.toHaveBeenCalled()
  })

  it('fails closed if the transition lookup breaks — never resumes on a guess', async () => {
    q('transfer_transitions', { data: null, error: { message: 'boom' } })
    q('transfers', held({ state: 'CANCELED' }))

    await expect(cancelHeldTransfer(input(), log)).rejects.toThrow(
      /ops cancel transition lookup failed/,
    )
    expect(transition).not.toHaveBeenCalled()
  })

  // A funding_disputed HOLD is caught by the interlock before the hold
  // allowlist ever runs, and that precedence is deliberate: "this funding was
  // charged back, here is the loss path" tells an operator what is true, where
  // "that hold is not in my list" only tells them what the tool declines.
  it('refuses a funding_disputed hold as a CHARGEBACK, not merely an uncancelable hold', async () => {
    q('transfers', held({ payout_hold_reason: 'funding_disputed' }))

    await expect(cancelHeldTransfer(input(), log)).resolves.toEqual({
      done: false,
      reason: 'funding_disputed',
      source: 'record',
      disputeRef: null,
      detail: "the payout is held on 'funding_disputed'",
    })
    expect(opsCancel).not.toHaveBeenCalled()
    expect(recordOpsAction).not.toHaveBeenCalled()
  })

  it('still refuses the other excluded holds on the allowlist, not the interlock', async () => {
    q('transfers', held({ payout_hold_reason: 'sender_suspended' }))

    await expect(cancelHeldTransfer(input(), log)).resolves.toEqual({
      done: false,
      reason: 'hold_not_cancelable',
      actual: 'sender_suspended',
    })
    expect(opsCancel).not.toHaveBeenCalled()
  })
})

describe('verifyFundingNotDisputed (the dispute interlock)', () => {
  const row = (over: Record<string, unknown> = {}) =>
    ({
      state: 'FUNDED',
      payout_hold_reason: 'payability',
      funding_disputed_at: null,
      funding_payment_ref: 'cs_test_1',
      funding_processor: 'stripe_checkout',
      ...over,
    }) as never

  it('consults BOTH halves and says so when neither reports a dispute', async () => {
    disputeStatus.impl = async () => ({ paymentRef: 'cs_test_1', disputed: false })

    await expect(verifyFundingNotDisputed(row())).resolves.toEqual({
      disputed: false,
      checked: 'record_and_provider',
    })
  })

  it.each([
    ['funding_disputed_at is set', { funding_disputed_at: '2026-09-10T16:06:08.000Z' }],
    ['the hold says so', { payout_hold_reason: 'funding_disputed' }],
    ['the state is FUNDING_REVERSED', { state: 'FUNDING_REVERSED' }],
  ])('catches a dispute from OUR record when %s — without calling the provider', async (_l, over) => {
    const probe = vi.fn()
    disputeStatus.impl = probe

    await expect(verifyFundingNotDisputed(row(over))).resolves.toMatchObject({
      disputed: true,
      source: 'record',
    })
    expect(probe).not.toHaveBeenCalled()
  })

  // THE STAGING CASE, 2026-09-14. Three disputes left no trace on our side —
  // the handler that writes funding_disputed_at shipped hours after they
  // arrived — so the record half passes and only the live charge knows.
  it('catches a dispute our record knows NOTHING about', async () => {
    disputeStatus.impl = async () => ({
      paymentRef: 'cs_test_1',
      disputed: true,
      disputeRef: 'du_1UEAUGIbCQghJX8LxAXiQE5S',
      status: 'needs_response',
    })

    await expect(verifyFundingNotDisputed(row())).resolves.toEqual({
      disputed: true,
      source: 'provider',
      disputeRef: 'du_1UEAUGIbCQghJX8LxAXiQE5S',
      detail: 'the funding charge is disputed at the provider (needs_response)',
    })
  })

  // Silence is not confirmation: an implemented check that cannot answer must
  // stop the operation, never wave it through.
  it('FAILS CLOSED when the provider is unreachable', async () => {
    disputeStatus.impl = async () => {
      throw new Error('stripe timeout')
    }

    await expect(verifyFundingNotDisputed(row())).rejects.toThrow('stripe timeout')
  })

  // …but an ABSENT capability is not a failure. The mock cannot be disputed and
  // `manual` collects on a rail we do not operate; refusing those would make
  // every non-Stripe rail uncancelable.
  it('proceeds on our record alone for a rail with no dispute check, and labels it', async () => {
    disputeStatus.impl = null

    await expect(verifyFundingNotDisputed(row({ funding_processor: 'mock' }))).resolves.toEqual({
      disputed: false,
      checked: 'record_only',
    })
  })

  it('does not ask about a row with no funding ref to ask about', async () => {
    const probe = vi.fn()
    disputeStatus.impl = probe

    await expect(verifyFundingNotDisputed(row({ funding_payment_ref: null }))).resolves.toEqual({
      disputed: false,
      checked: 'record_only',
    })
    expect(probe).not.toHaveBeenCalled()
  })

  // The guard that broke every fixture the moment it landed: an unselected
  // column arrives as undefined, which `!== null` reads as "disputed".
  it('treats an UNSELECTED funding_disputed_at as unknown, not as disputed', async () => {
    disputeStatus.impl = async () => ({ paymentRef: 'cs_test_1', disputed: false })

    await expect(verifyFundingNotDisputed(row({ funding_disputed_at: undefined }))).resolves.toEqual(
      { disputed: false, checked: 'record_and_provider' },
    )
  })
})

describe('cancelHeldTransfer + the interlock', () => {
  it('refuses BEFORE the cancel commits when the provider reports a chargeback', async () => {
    disputeStatus.impl = async () => ({
      paymentRef: 'cs_test_1',
      disputed: true,
      disputeRef: 'du_1',
      status: 'needs_response',
    })
    q('transfers', held())

    await expect(cancelHeldTransfer(input(), log)).resolves.toMatchObject({
      done: false,
      reason: 'funding_disputed',
      source: 'provider',
      disputeRef: 'du_1',
    })
    // The whole point: nothing moved. No CANCELED transition, no claim, no
    // processor call, no provenance row — the row is exactly as it was.
    expect(opsCancel).not.toHaveBeenCalled()
    expect(processorRefund).not.toHaveBeenCalled()
    expect(transition).not.toHaveBeenCalled()
    expect(recordOpsAction).not.toHaveBeenCalled()
  })

  it('lets an unreachable provider stop the run rather than cancel blind', async () => {
    disputeStatus.impl = async () => {
      throw new Error('stripe timeout')
    }
    q('transfers', held())

    await expect(cancelHeldTransfer(input(), log)).rejects.toThrow('stripe timeout')
    expect(opsCancel).not.toHaveBeenCalled()
  })

  // A settled transfer is done; a dispute arriving afterwards is the loss
  // path's business, so the interlock must not re-open it.
  it('skips the interlock entirely on an already-REFUNDED row', async () => {
    const probe = vi.fn()
    disputeStatus.impl = probe
    q('transfers', held({ state: 'REFUNDED', refund_payment_ref: 're_1' }))

    await expect(cancelHeldTransfer(input(), log)).resolves.toEqual({
      done: true,
      outcome: 'already_settled',
    })
    expect(probe).not.toHaveBeenCalled()
  })
})

describe('listHeldTransfers', () => {
  it('lists every held FUNDED row and marks which this tool may discharge', async () => {
    q('transfers', {
      data: [
        { ...held().data, id: 'a', payout_hold_reason: 'payability' },
        { ...held().data, id: 'b', payout_hold_reason: 'funding_disputed' },
      ],
      error: null,
    })

    const rows = await listHeldTransfers()

    expect(rows.map((r) => [r.id, r.cancelable])).toEqual([
      ['a', true],
      ['b', false],
    ])
    // Rows the submit job already claimed are out of scope, not merely unmarked.
    expect(filters).toContainEqual(
      expect.objectContaining({ method: 'is', args: ['submit_attempted_at', null] }),
    )
  })

  it('fails closed — a broken read must never look like an empty backlog', async () => {
    q('transfers', { data: null, error: { message: 'boom' } })
    await expect(listHeldTransfers()).rejects.toThrow(/held transfer query failed/)
  })
})
