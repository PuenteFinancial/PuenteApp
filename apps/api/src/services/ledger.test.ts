import { describe, it, expect, vi, beforeEach } from 'vitest'
import { moneyFromMinorUnits } from '@puente/shared'

const rpc = vi.fn()

vi.mock('./supabase.js', () => ({
  supabaseAdmin: {
    rpc: (...args: unknown[]) => rpc(...args),
  },
  supabaseAuth: {},
}))

const { postLedgerTransaction, getAccountBalance, LedgerValidationError } = await import(
  './ledger.js'
)

const usd = (amountMinor: number) => moneyFromMinorUnits(amountMinor, 'USD')
const mxn = (amountMinor: number) => moneyFromMinorUnits(amountMinor, 'MXN')

const TRANSFER_ID = '7f0e6b1a-5c3d-4e2f-9a8b-0c1d2e3f4a5b'

const postedRow = {
  id: 'a1b2c3d4-0000-0000-0000-000000000001',
  transfer_id: TRANSFER_ID,
  transition: 'FUNDED',
  idempotency_key: `${TRANSFER_ID}:FUNDED`,
  description: 'transfer funded',
  posted_at: '2026-07-14T12:00:00.000Z',
  created_at: '2026-07-14T12:00:00.000Z',
}

/** The FUNDED posting from ledger-rules.md: $100 in = $98 payable + $2 fee. */
const balancedEntries = [
  { accountCode: 'funding_receivable', direction: 'debit' as const, money: usd(10000) },
  { accountCode: 'transfer_payable', direction: 'credit' as const, money: usd(9800) },
  { accountCode: 'fee_revenue', direction: 'credit' as const, money: usd(200) },
]

beforeEach(() => {
  rpc.mockReset()
  rpc.mockResolvedValue({ data: postedRow, error: null })
})

describe('postLedgerTransaction validation (rpc must never be called)', () => {
  it('rejects fewer than 2 entries', async () => {
    await expect(
      postLedgerTransaction({
        transferId: TRANSFER_ID,
        transition: 'FUNDED',
        description: 'transfer funded',
        entries: [balancedEntries[0]!],
      }),
    ).rejects.toBeInstanceOf(LedgerValidationError)
    expect(rpc).not.toHaveBeenCalled()
  })

  it('rejects an unbalanced batch', async () => {
    await expect(
      postLedgerTransaction({
        transferId: TRANSFER_ID,
        transition: 'FUNDED',
        description: 'transfer funded',
        entries: [
          { accountCode: 'funding_receivable', direction: 'debit', money: usd(10000) },
          { accountCode: 'transfer_payable', direction: 'credit', money: usd(9900) },
        ],
      }),
    ).rejects.toBeInstanceOf(LedgerValidationError)
    expect(rpc).not.toHaveBeenCalled()
  })

  it('rejects a batch that only nets to zero across currencies', async () => {
    await expect(
      postLedgerTransaction({
        transferId: TRANSFER_ID,
        transition: 'FUNDED',
        description: 'cross-currency net',
        entries: [
          { accountCode: 'funding_receivable', direction: 'debit', money: usd(10000) },
          { accountCode: 'transfer_payable', direction: 'credit', money: mxn(10000) },
        ],
      }),
    ).rejects.toBeInstanceOf(LedgerValidationError)
    expect(rpc).not.toHaveBeenCalled()
  })

  it('accepts a batch where each currency group independently nets to zero', async () => {
    await postLedgerTransaction({
      transferId: TRANSFER_ID,
      transition: 'FUNDED',
      description: 'two independent currency groups',
      entries: [
        { accountCode: 'funding_receivable', direction: 'debit', money: usd(10000) },
        { accountCode: 'transfer_payable', direction: 'credit', money: usd(10000) },
        { accountCode: 'funding_receivable', direction: 'debit', money: mxn(500) },
        { accountCode: 'transfer_payable', direction: 'credit', money: mxn(500) },
      ],
    })
    expect(rpc).toHaveBeenCalledTimes(1)
  })

  it.each([
    ['zero', 0],
    ['negative', -100],
    ['non-integer', 10.5],
  ])('rejects a %s amount', async (_label, amountMinor) => {
    await expect(
      postLedgerTransaction({
        transferId: TRANSFER_ID,
        transition: 'FUNDED',
        description: 'bad amount',
        entries: [
          { accountCode: 'funding_receivable', direction: 'debit', money: { amountMinor, currency: 'USD' } },
          { accountCode: 'transfer_payable', direction: 'credit', money: { amountMinor, currency: 'USD' } },
        ],
      }),
    ).rejects.toBeInstanceOf(LedgerValidationError)
    expect(rpc).not.toHaveBeenCalled()
  })

  it('rejects an invalid direction at runtime', async () => {
    await expect(
      postLedgerTransaction({
        transferId: TRANSFER_ID,
        transition: 'FUNDED',
        description: 'bad direction',
        entries: [
          // @ts-expect-error — runtime guard for non-TS callers
          { accountCode: 'funding_receivable', direction: 'DEBIT', money: usd(100) },
          { accountCode: 'transfer_payable', direction: 'credit', money: usd(100) },
        ],
      }),
    ).rejects.toBeInstanceOf(LedgerValidationError)
    expect(rpc).not.toHaveBeenCalled()
  })

  it('rejects a blank description', async () => {
    await expect(
      postLedgerTransaction({
        transferId: TRANSFER_ID,
        transition: 'FUNDED',
        description: '  ',
        entries: balancedEntries,
      }),
    ).rejects.toBeInstanceOf(LedgerValidationError)
    expect(rpc).not.toHaveBeenCalled()
  })
})

describe('idempotency key resolution', () => {
  it('derives {transferId}:{transition} when both are present', async () => {
    await postLedgerTransaction({
      transferId: TRANSFER_ID,
      transition: 'FUNDED',
      description: 'transfer funded',
      entries: balancedEntries,
    })
    expect(rpc).toHaveBeenCalledWith(
      'post_ledger_transaction',
      expect.objectContaining({ p_idempotency_key: `${TRANSFER_ID}:FUNDED` }),
    )
  })

  it('uses the explicit key for non-transfer batches (e.g. wallet replenishment)', async () => {
    await postLedgerTransaction({
      idempotencyKey: 'replenishment:2026-07-14:1',
      description: 'treasury wallet top-up',
      entries: [
        { accountCode: 'bridge_wallet_float', direction: 'debit', money: usd(50000) },
        { accountCode: 'cash_clearing', direction: 'credit', money: usd(50000) },
      ],
    })
    expect(rpc).toHaveBeenCalledWith(
      'post_ledger_transaction',
      expect.objectContaining({
        p_idempotency_key: 'replenishment:2026-07-14:1',
        p_transfer_id: null,
        p_transition: null,
      }),
    )
  })

  it('prefers the explicit key over derivation when both are given', async () => {
    await postLedgerTransaction({
      transferId: TRANSFER_ID,
      transition: 'FUNDED',
      idempotencyKey: 'explicit-key',
      description: 'transfer funded',
      entries: balancedEntries,
    })
    expect(rpc).toHaveBeenCalledWith(
      'post_ledger_transaction',
      expect.objectContaining({ p_idempotency_key: 'explicit-key' }),
    )
  })

  it('rejects when no key can be resolved', async () => {
    await expect(
      postLedgerTransaction({
        transferId: TRANSFER_ID, // transition missing
        description: 'no key possible',
        entries: balancedEntries,
      }),
    ).rejects.toBeInstanceOf(LedgerValidationError)
    expect(rpc).not.toHaveBeenCalled()
  })
})

describe('rpc payload and response mapping', () => {
  it('sends the exact p_entries shape the Postgres function expects', async () => {
    await postLedgerTransaction({
      transferId: TRANSFER_ID,
      transition: 'FUNDED',
      description: 'transfer funded',
      entries: balancedEntries,
    })
    expect(rpc).toHaveBeenCalledWith('post_ledger_transaction', {
      p_idempotency_key: `${TRANSFER_ID}:FUNDED`,
      p_description: 'transfer funded',
      p_transfer_id: TRANSFER_ID,
      p_transition: 'FUNDED',
      p_entries: [
        { account_code: 'funding_receivable', direction: 'debit', amount_minor: 10000, currency: 'USD' },
        { account_code: 'transfer_payable', direction: 'credit', amount_minor: 9800, currency: 'USD' },
        { account_code: 'fee_revenue', direction: 'credit', amount_minor: 200, currency: 'USD' },
      ],
    })
  })

  it('maps the returned row to camelCase', async () => {
    const record = await postLedgerTransaction({
      transferId: TRANSFER_ID,
      transition: 'FUNDED',
      description: 'transfer funded',
      entries: balancedEntries,
    })
    expect(record).toEqual({
      id: postedRow.id,
      transferId: TRANSFER_ID,
      transition: 'FUNDED',
      idempotencyKey: `${TRANSFER_ID}:FUNDED`,
      description: 'transfer funded',
      postedAt: postedRow.posted_at,
    })
  })

  it('propagates rpc errors', async () => {
    rpc.mockResolvedValue({ data: null, error: { message: 'unknown ledger account code: nope' } })
    await expect(
      postLedgerTransaction({
        transferId: TRANSFER_ID,
        transition: 'FUNDED',
        description: 'transfer funded',
        entries: balancedEntries,
      }),
    ).rejects.toThrow(/unknown ledger account code/)
  })
})

describe('getAccountBalance', () => {
  it('returns the signed balance as Money', async () => {
    rpc.mockResolvedValue({ data: [{ amount_minor: 150, currency: 'USD' }], error: null })
    const balance = await getAccountBalance('cash_clearing')
    expect(rpc).toHaveBeenCalledWith('ledger_account_balance', { p_account_code: 'cash_clearing' })
    expect(balance).toEqual({ amountMinor: 150, currency: 'USD' })
  })

  it('handles a scalar row response shape', async () => {
    rpc.mockResolvedValue({ data: { amount_minor: -40000, currency: 'USD' }, error: null })
    const balance = await getAccountBalance('cash_clearing')
    expect(balance).toEqual({ amountMinor: -40000, currency: 'USD' })
  })

  it('propagates rpc errors', async () => {
    rpc.mockResolvedValue({ data: null, error: { message: 'unknown ledger account code: nope' } })
    await expect(getAccountBalance('nope')).rejects.toThrow(/unknown ledger account code/)
  })
})
