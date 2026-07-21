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
  fundedLedgerEntries,
  toApiTransfer,
  TransferRpcError,
} = await import('./transfers.js')

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
  fx_rate: 19.9997,
  funding_source_type: 'ach',
  funding_cleared: false,
  disclosure_accepted_at: null,
  payment_at: null,
  cancelable_until: null,
  funding_payment_ref: null,
  provider_transfer_ref: null,
  payout_hold_reason: null,
  payout_held_at: null,
  submit_attempted_at: null,
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
    const entries = fundedLedgerEntries({ send_amount_minor: 19801, fee_amount_minor: 199 })
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
    const entries = fundedLedgerEntries({ send_amount_minor: 100, fee_amount_minor: 0 })
    expect(entries).toHaveLength(2)
    expect(entries.map((e) => e.account_code)).not.toContain('fee_revenue')
  })
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
