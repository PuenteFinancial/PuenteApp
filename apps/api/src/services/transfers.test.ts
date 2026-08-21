import { describe, it, expect, beforeEach, vi } from 'vitest'

const rpc = vi.fn()

vi.mock('./supabase.js', () => ({
  supabaseAdmin: {
    rpc: (...args: unknown[]) => rpc(...args),
  },
}))

const {
  createTransferFromQuote,
  transitionTransfer,
  cancelTransfer,
  fundedLedgerEntries,
  canceledLedgerEntries,
  completedLedgerEntries,
  fundingClearedLedgerEntries,
  bridgeReturnLedgerEntries,
  refundedLedgerEntries,
  voidRefundLedgerEntries,
  correctionRefundLedgerEntries,
  correctionVoidLedgerEntries,
  toApiTransfer,
  TransferRpcError,
} = await import('./transfers.js')

// signed (debit − credit) per account across a set of entries
const signedNet = (entries: { account_code: string; direction: string; amount_minor: number }[]) => {
  const net: Record<string, number> = {}
  for (const e of entries) {
    net[e.account_code] = (net[e.account_code] ?? 0) + (e.direction === 'debit' ? e.amount_minor : -e.amount_minor)
  }
  return net
}
const netsToZero = (entries: { direction: string; amount_minor: number }[]) =>
  entries.reduce((s, e) => (e.direction === 'debit' ? s + e.amount_minor : s - e.amount_minor), 0)

const transferRow = {
  id: 'tr-1',
  user_id: 'user-123',
  payout_destination_id: 'dest-1',
  quote_id: 'q-1',
  state: 'PENDING_PAYMENT',
  send_amount_minor: 19801,
  send_currency: 'USD',
  receive_amount_minor: 396014,
  receive_currency: 'MXN',
  fee_amount_minor: 199,
  fee_currency: 'USD',
  margin_minor: 0,
  fx_rate: 19.9997,
  funding_source_type: 'ach',
  funding_cleared: false,
  disclosure_accepted_at: null,
  payment_at: null,
  cancelable_until: null,
  idempotency_key: 'bridge-key-1',
  funding_payment_ref: null,
  provider_transfer_ref: null,
  refund_payment_ref: null,
  refunded_at: null,
  payout_hold_reason: null,
  payout_held_at: null,
  submit_attempted_at: null,
  cancellation_requested_at: null,
  payment_claimed_at: null,
  completed_at: null,
  created_at: '2026-07-17T20:00:00.000Z',
}

beforeEach(() => rpc.mockReset())

describe('createTransferFromQuote', () => {
  it('calls the RPC with a fresh bridge idempotency key and returns both rows', async () => {
    rpc.mockResolvedValue({
      data: { transfer: transferRow, disclosure: { id: 'disc-1' } },
      error: null,
    })

    const result = await createTransferFromQuote({
      quoteId: 'q-1',
      userId: 'user-123',
      locale: 'es',
      disclosureContent: { version: 1 },
    })

    expect(result.transfer.id).toBe('tr-1')
    const [name, args] = rpc.mock.calls[0] as [string, Record<string, unknown>]
    expect(name).toBe('create_transfer_from_quote')
    expect(args['p_quote_id']).toBe('q-1')
    expect(args['p_transfer_idempotency_key']).toMatch(/[0-9a-f-]{36}/)
    expect(args['p_disclosure_locale']).toBe('es')
  })

  it.each(['quote_not_found', 'quote_consumed', 'quote_expired'] as const)(
    'maps %s raises to typed errors',
    async (code) => {
      rpc.mockResolvedValue({ data: null, error: { message: `error: ${code}` } })
      const err = await createTransferFromQuote({
        quoteId: 'q-1',
        userId: 'user-123',
        locale: 'en',
        disclosureContent: {},
      }).catch((e: unknown) => e)
      expect(err).toBeInstanceOf(TransferRpcError)
      expect((err as InstanceType<typeof TransferRpcError>).code).toBe(code)
    },
  )
})

describe('transitionTransfer', () => {
  it('maps conflict raises and passes ledger entries + timestamps through', async () => {
    rpc.mockResolvedValue({ data: transferRow, error: null })
    const paymentAt = new Date('2026-07-17T20:05:00.000Z')

    await transitionTransfer({
      transferId: 'tr-1',
      fromState: 'PENDING_PAYMENT',
      toState: 'FUNDED',
      actor: 'webhook:funding',
      ledgerEntries: fundedLedgerEntries(transferRow),
      paymentAt,
      cancelableUntil: new Date(paymentAt.getTime() + 30 * 60 * 1000),
      fundingPaymentRef: 'mockpay_1',
    })

    const [, args] = rpc.mock.calls[0] as [string, Record<string, unknown>]
    expect(args['p_from_state']).toBe('PENDING_PAYMENT')
    expect(args['p_to_state']).toBe('FUNDED')
    expect(args['p_payment_at']).toBe('2026-07-17T20:05:00.000Z')
    expect(args['p_cancelable_until']).toBe('2026-07-17T20:35:00.000Z')
    expect(args['p_funding_payment_ref']).toBe('mockpay_1')

    rpc.mockResolvedValue({ data: null, error: { message: 'error: transition_conflict' } })
    const err = await transitionTransfer({
      transferId: 'tr-1',
      fromState: 'PENDING_PAYMENT',
      toState: 'FUNDED',
      actor: 'webhook:funding',
    }).catch((e: unknown) => e)
    expect((err as InstanceType<typeof TransferRpcError>).code).toBe('transition_conflict')
  })
})

describe('fundedLedgerEntries', () => {
  it('builds the net-zero FUNDED batch', () => {
    const entries = fundedLedgerEntries({ send_amount_minor: 19801, fee_amount_minor: 199, margin_minor: 0 })
    expect(entries).toEqual([
      { account_code: 'funding_receivable', direction: 'debit', amount_minor: 20000, currency: 'USD' },
      { account_code: 'transfer_payable', direction: 'credit', amount_minor: 19801, currency: 'USD' },
      { account_code: 'fee_revenue', direction: 'credit', amount_minor: 199, currency: 'USD' },
    ])
    const debits = entries.filter((e) => e.direction === 'debit').reduce((s, e) => s + e.amount_minor, 0)
    const credits = entries.filter((e) => e.direction === 'credit').reduce((s, e) => s + e.amount_minor, 0)
    expect(debits).toBe(credits)
  })

  it('omits the fee line at zero fee (ledger rejects zero entries)', () => {
    const entries = fundedLedgerEntries({ send_amount_minor: 100, fee_amount_minor: 0, margin_minor: 0 })
    expect(entries).toHaveLength(2)
    expect(entries.map((e) => e.account_code)).not.toContain('fee_revenue')
  })
})

describe('fundingClearedLedgerEntries', () => {
  it('builds the net-zero ACH CLEARS batch — the receivable becomes cash', () => {
    const entries = fundingClearedLedgerEntries({ send_amount_minor: 19801, fee_amount_minor: 199, margin_minor: 0 })
    expect(entries).toEqual([
      { account_code: 'cash_clearing', direction: 'debit', amount_minor: 20000, currency: 'USD' },
      { account_code: 'funding_receivable', direction: 'credit', amount_minor: 20000, currency: 'USD' },
    ])
    const debits = entries.filter((e) => e.direction === 'debit').reduce((s, e) => s + e.amount_minor, 0)
    const credits = entries.filter((e) => e.direction === 'credit').reduce((s, e) => s + e.amount_minor, 0)
    expect(debits).toBe(credits)
  })

  it('relieves EXACTLY what FUNDED opened, so the receivable returns to zero', () => {
    // The bug this fixes: without this batch, funding_receivable accumulated
    // lifetime volume and the float ceiling (which reads that balance) became a
    // one-way ratchet that permanently halts payouts.
    const t = { send_amount_minor: 19801, fee_amount_minor: 199, margin_minor: 0 }
    const opened = fundedLedgerEntries(t).find((e) => e.account_code === 'funding_receivable')!
    const relieved = fundingClearedLedgerEntries(t).find((e) => e.account_code === 'funding_receivable')!
    expect(relieved.amount_minor).toBe(opened.amount_minor)
    expect(opened.direction).toBe('debit')
    expect(relieved.direction).toBe('credit')
  })

  it('includes the fee in the relief even on a zero-fee transfer', () => {
    const entries = fundingClearedLedgerEntries({ send_amount_minor: 5000, fee_amount_minor: 0, margin_minor: 0 })
    expect(entries).toHaveLength(2)
    expect(entries[0]!.amount_minor).toBe(5000)
  })
})

describe('canceledLedgerEntries', () => {
  it('builds the net-zero CANCELED batch — the exact reversal of FUNDED', () => {
    const entries = canceledLedgerEntries({ send_amount_minor: 19801, fee_amount_minor: 199, margin_minor: 0 })
    expect(entries).toEqual([
      { account_code: 'transfer_payable', direction: 'debit', amount_minor: 19801, currency: 'USD' },
      { account_code: 'fee_revenue', direction: 'debit', amount_minor: 199, currency: 'USD' },
      { account_code: 'funding_receivable', direction: 'credit', amount_minor: 20000, currency: 'USD' },
    ])
    const debits = entries.filter((e) => e.direction === 'debit').reduce((s, e) => s + e.amount_minor, 0)
    const credits = entries.filter((e) => e.direction === 'credit').reduce((s, e) => s + e.amount_minor, 0)
    expect(debits).toBe(credits)
  })

  it('is the direction-flipped mirror of fundedLedgerEntries (per account)', () => {
    const t = { send_amount_minor: 19801, fee_amount_minor: 199, margin_minor: 0 }
    const funded = fundedLedgerEntries(t)
    const canceled = canceledLedgerEntries(t)
    // same accounts + amounts, every direction inverted → the two batches sum to nothing
    for (const f of funded) {
      const c = canceled.find((e) => e.account_code === f.account_code)!
      expect(c.amount_minor).toBe(f.amount_minor)
      expect(c.direction).toBe(f.direction === 'debit' ? 'credit' : 'debit')
    }
  })

  it('omits the fee line at zero fee (ledger rejects zero entries)', () => {
    const entries = canceledLedgerEntries({ send_amount_minor: 100, fee_amount_minor: 0, margin_minor: 0 })
    expect(entries).toHaveLength(2)
    expect(entries.map((e) => e.account_code)).not.toContain('fee_revenue')
  })
})

describe('bridgeReturnLedgerEntries', () => {
  it('books the returned principal back to cash, settling due_from_bridge (nets to zero)', () => {
    const entries = bridgeReturnLedgerEntries({ send_amount_minor: 19801, fee_amount_minor: 199, margin_minor: 0 })
    expect(entries).toEqual([
      { account_code: 'cash_clearing', direction: 'debit', amount_minor: 19801, currency: 'USD' },
      { account_code: 'due_from_bridge', direction: 'credit', amount_minor: 19801, currency: 'USD' },
    ])
    expect(netsToZero(entries)).toBe(0)
  })
})

describe('refundedLedgerEntries', () => {
  it('recognizes + pays the full refund incl. fee from cash (nets to zero)', () => {
    const entries = refundedLedgerEntries({ send_amount_minor: 19801, fee_amount_minor: 199, margin_minor: 0 })
    expect(entries).toEqual([
      { account_code: 'transfer_payable', direction: 'debit', amount_minor: 19801, currency: 'USD' },
      { account_code: 'fee_revenue', direction: 'debit', amount_minor: 199, currency: 'USD' },
      { account_code: 'cash_clearing', direction: 'credit', amount_minor: 20000, currency: 'USD' },
    ])
    expect(netsToZero(entries)).toBe(0)
  })

  it('omits the fee line at zero fee (ledger rejects zero entries)', () => {
    const entries = refundedLedgerEntries({ send_amount_minor: 100, fee_amount_minor: 0, margin_minor: 0 })
    expect(entries).toHaveLength(2)
    expect(entries.map((e) => e.account_code)).not.toContain('fee_revenue')
    expect(netsToZero(entries)).toBe(0)
  })
})

describe('the two-batch refund tail (bridge_return + refunded)', () => {
  it('each batch nets to zero, and their combined deltas close the open positions leaving cash −fee', () => {
    const t = { send_amount_minor: 19801, fee_amount_minor: 199, margin_minor: 0 }
    expect(netsToZero(bridgeReturnLedgerEntries(t))).toBe(0)
    expect(netsToZero(refundedLedgerEntries(t))).toBe(0)
    // combined (debit − credit) deltas: cash +S then −(S+F) = −F (fee refunded);
    // due_from_bridge −S and transfer_payable +S / fee_revenue +F reverse the
    // SUBMITTED/FUNDED-era positions to zero when added to their opening balances.
    expect(signedNet([...bridgeReturnLedgerEntries(t), ...refundedLedgerEntries(t)])).toEqual({
      cash_clearing: -199,
      due_from_bridge: -19801,
      transfer_payable: 19801,
      fee_revenue: 199,
    })
  })
})

describe('voidRefundLedgerEntries (PR-S2 — the undo VOIDED the pull)', () => {
  it('is exactly the FUNDED reversal: the sender was never debited, so no cash line exists', () => {
    const t = { send_amount_minor: 19801, fee_amount_minor: 199, margin_minor: 0 }
    expect(voidRefundLedgerEntries(t)).toEqual(canceledLedgerEntries(t))
    expect(netsToZero(voidRefundLedgerEntries(t))).toBe(0)
    expect(voidRefundLedgerEntries(t).map((e) => e.account_code)).not.toContain('cash_clearing')
  })

  it('the voided two-batch tail: receivable and payable close, cash keeps the returned float, fee unearned', () => {
    const t = { send_amount_minor: 19801, fee_amount_minor: 199, margin_minor: 0 }
    expect(signedNet([...bridgeReturnLedgerEntries(t), ...voidRefundLedgerEntries(t)])).toEqual({
      cash_clearing: 19801, // Bridge returned the fronted principal — ours again
      due_from_bridge: -19801,
      transfer_payable: 19801, // reverses the FUNDED credit
      fee_revenue: 199, // reverses — no fee on a transfer the sender never paid
      funding_receivable: -20000, // the canceled pull closes WITHOUT ever clearing
    })
  })
})

describe('correctionVoidLedgerEntries (PR-S2 — correction payment on a voided pull)', () => {
  it('books the compliance loss against the never-collectable receivable (nets to zero, no cash line)', () => {
    const entries = correctionVoidLedgerEntries({ send_amount_minor: 19801, fee_amount_minor: 199, margin_minor: 0 })
    expect(entries).toEqual([
      {
        account_code: 'loss_cancellation_correction',
        direction: 'debit',
        amount_minor: 20000,
        currency: 'USD',
      },
      {
        account_code: 'funding_receivable',
        direction: 'credit',
        amount_minor: 20000,
        currency: 'USD',
      },
    ])
    expect(netsToZero(entries)).toBe(0)
  })

  it('same P&L as the refunded-mode correction — only the credited ASSET differs', () => {
    const t = { send_amount_minor: 19801, fee_amount_minor: 199, margin_minor: 0 }
    const voided = signedNet(correctionVoidLedgerEntries(t))
    const refunded = signedNet(correctionRefundLedgerEntries(t))
    expect(voided['loss_cancellation_correction']).toBe(refunded['loss_cancellation_correction'])
    expect(voided['funding_receivable']).toBe(-20000)
    expect(refunded['cash_clearing']).toBe(-20000)
  })
})

describe('generation equivalence (#193 — fee era vs merged-rate era)', () => {
  // The same $200.00 transfer, priced by each generation. At equal bps the
  // batches must be BYTE-IDENTICAL: the customer pays the same, the recipient
  // is owed the same principal, and the same revenue books to fee_revenue —
  // only which COLUMN carries the revenue differs.
  const feeEra = { send_amount_minor: 19801, fee_amount_minor: 199, margin_minor: 0 }
  const mergedEra = { send_amount_minor: 20000, fee_amount_minor: 0, margin_minor: 199 }

  it.each([
    ['fundedLedgerEntries', fundedLedgerEntries],
    ['canceledLedgerEntries', canceledLedgerEntries],
    ['fundingClearedLedgerEntries', fundingClearedLedgerEntries],
    ['completedLedgerEntries', completedLedgerEntries],
    ['bridgeReturnLedgerEntries', bridgeReturnLedgerEntries],
    ['refundedLedgerEntries', refundedLedgerEntries],
    ['voidRefundLedgerEntries', voidRefundLedgerEntries],
    ['correctionRefundLedgerEntries', correctionRefundLedgerEntries],
    ['correctionVoidLedgerEntries', correctionVoidLedgerEntries],
  ] as const)('%s books identical batches for both generations', (_name, build) => {
    expect(build(mergedEra)).toEqual(build(feeEra))
    expect(netsToZero(build(mergedEra))).toBe(0)
  })

  it('merged-era FUNDED books revenue from margin_minor, not fx_slippage', () => {
    // The #193 trap: fee = 0 with no margin would silently drop the revenue
    // line and the whole take would surface later as fx_slippage.
    const entries = fundedLedgerEntries(mergedEra)
    const fee = entries.find((e) => e.account_code === 'fee_revenue')!
    expect(fee.amount_minor).toBe(199)
    expect(fee.direction).toBe('credit')
    const payable = entries.find((e) => e.account_code === 'transfer_payable')!
    expect(payable.amount_minor).toBe(19801) // send − margin, the principal
  })

  it('a genuinely zero-revenue transfer still omits the fee_revenue line', () => {
    const entries = fundedLedgerEntries({
      send_amount_minor: 20000,
      fee_amount_minor: 0,
      margin_minor: 0,
    })
    expect(entries.map((e) => e.account_code)).not.toContain('fee_revenue')
    expect(netsToZero(entries)).toBe(0)
  })
})

describe('cancelTransfer', () => {
  it('calls cancel_transfer with actor/reason/ledger and returns the row', async () => {
    rpc.mockResolvedValue({ data: { ...transferRow, state: 'CANCELED' }, error: null })

    const row = await cancelTransfer({
      transferId: 'tr-1',
      actor: 'user',
      reason: 'sender canceled',
      ledgerDescription: 'transfer CANCELED',
      ledgerEntries: canceledLedgerEntries(transferRow),
    })

    expect(row.state).toBe('CANCELED')
    const [name, args] = rpc.mock.calls[0] as [string, Record<string, unknown>]
    expect(name).toBe('cancel_transfer')
    expect(args['p_transfer_id']).toBe('tr-1')
    expect(args['p_actor']).toBe('user')
    expect(args['p_reason']).toBe('sender canceled')
    expect(args['p_ledger_entries']).toEqual(canceledLedgerEntries(transferRow))
  })

  it.each(['transfer_not_cancelable', 'transfer_not_found'] as const)(
    'maps %s raises to typed errors',
    async (code) => {
      rpc.mockResolvedValue({ data: null, error: { message: code } })
      const err = await cancelTransfer({
        transferId: 'tr-1',
        actor: 'user',
        ledgerEntries: [],
      }).catch((e: unknown) => e)
      expect(err).toBeInstanceOf(TransferRpcError)
      expect((err as InstanceType<typeof TransferRpcError>).code).toBe(code)
    },
  )
})

describe('toApiTransfer', () => {
  it('serializes camelCase with derived totalAmount and 4-dp rate string', () => {
    const api = toApiTransfer(transferRow)
    expect(api).toMatchObject({
      id: 'tr-1',
      quoteId: 'q-1',
      state: 'PENDING_PAYMENT',
      totalAmount: { amountMinor: 20000, currency: 'USD' },
      sendAmount: { amountMinor: 19801, currency: 'USD' },
      feeAmount: { amountMinor: 199, currency: 'USD' },
      receiveAmount: { amountMinor: 396014, currency: 'MXN' },
      fxRate: '19.9997',
      fundingCleared: false,
    })
    expect('user_id' in api).toBe(false)
  })
})
