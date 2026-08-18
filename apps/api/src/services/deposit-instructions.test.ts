import { describe, it, expect, vi, beforeEach } from 'vitest'

const from = vi.fn()
vi.mock('./supabase.js', () => ({ supabaseAdmin: { from: (...a: unknown[]) => from(...a) } }))

const getBridgeDepositInstructions = vi.fn()
vi.mock('./bridge.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./bridge.js')>()
  return {
    ...actual,
    getBridgeDepositInstructions: (...a: unknown[]) => getBridgeDepositInstructions(...a),
  }
})

const { attachDepositInstructions, getDepositInstructions } = await import(
  './deposit-instructions.js'
)
const { BridgeApiError } = await import('./bridge.js')

const TRANSFER_ID = '22222222-2222-4222-8222-222222222222'
const ONRAMP_ID = '33333333-3333-4333-8333-333333333333'
const OPERATOR = '44444444-4444-4444-8444-444444444444'

const INSTRUCTIONS = {
  paymentRail: 'ach',
  currency: 'usd',
  amount: '100.00',
  bankName: 'Lead Bank',
  bankRoutingNumber: '101019644',
  bankAccountNumber: '215268129123',
  bankBeneficiaryName: 'Bridge Ventures Inc',
  depositMessage: 'BRGABCD1234',
}

// Merged-rate era row: full total in send, fee 0 (#193). The pre-merge shape
// (send 9900 / fee 100) appears in one test to pin generation independence.
function mockTransfer(row: Record<string, unknown> | null) {
  const single = vi.fn().mockResolvedValue({ data: row })
  const eq = vi.fn().mockReturnValue({ single })
  const select = vi.fn().mockReturnValue({ eq })
  return { select, eq, single }
}

function mockUpsert(result: Record<string, unknown> | null, error: { message: string } | null = null) {
  const single = vi.fn().mockResolvedValue({ data: result, error })
  const select = vi.fn().mockReturnValue({ single })
  const upsert = vi.fn().mockReturnValue({ select })
  return { upsert, select, single }
}

beforeEach(() => {
  from.mockReset()
  getBridgeDepositInstructions.mockReset()
})

describe('attachDepositInstructions', () => {
  it('fetches from Bridge, verifies the amount, and upserts keyed on transfer_id', async () => {
    const transfers = mockTransfer({
      id: TRANSFER_ID,
      state: 'PENDING_PAYMENT',
      send_amount_minor: 10000,
      fee_amount_minor: 0,
    })
    const savedRow = { transfer_id: TRANSFER_ID, deposit_message: 'BRGABCD1234' }
    const instructions = mockUpsert(savedRow)
    from.mockImplementation((table: string) =>
      table === 'transfers' ? transfers : instructions,
    )
    getBridgeDepositInstructions.mockResolvedValue(INSTRUCTIONS)

    const result = await attachDepositInstructions({
      transferId: TRANSFER_ID,
      bridgeTransferId: ONRAMP_ID,
      operator: OPERATOR,
    })

    expect(result.outcome).toBe('attached')
    expect(getBridgeDepositInstructions).toHaveBeenCalledWith(ONRAMP_ID)
    expect(instructions.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        transfer_id: TRANSFER_ID,
        bridge_transfer_ref: ONRAMP_ID,
        amount_minor: 10000,
        bank_routing_number: '101019644',
        deposit_message: 'BRGABCD1234',
        attached_by: OPERATOR,
      }),
      { onConflict: 'transfer_id' },
    )
  })

  it('sums send + fee for a pre-merge-era transfer (generation independence)', async () => {
    const transfers = mockTransfer({
      id: TRANSFER_ID,
      state: 'PENDING_PAYMENT',
      send_amount_minor: 9900,
      fee_amount_minor: 100,
    })
    const instructions = mockUpsert({ transfer_id: TRANSFER_ID })
    from.mockImplementation((table: string) =>
      table === 'transfers' ? transfers : instructions,
    )
    getBridgeDepositInstructions.mockResolvedValue(INSTRUCTIONS)

    const result = await attachDepositInstructions({
      transferId: TRANSFER_ID,
      bridgeTransferId: ONRAMP_ID,
      operator: OPERATOR,
    })
    expect(result.outcome).toBe('attached')
    expect(instructions.upsert).toHaveBeenCalledWith(
      expect.objectContaining({ amount_minor: 10000 }),
      { onConflict: 'transfer_id' },
    )
  })

  it('refuses an unknown transfer without calling Bridge', async () => {
    from.mockReturnValue(mockTransfer(null))
    const result = await attachDepositInstructions({
      transferId: TRANSFER_ID,
      bridgeTransferId: ONRAMP_ID,
      operator: OPERATOR,
    })
    expect(result).toEqual({ outcome: 'unknown_transfer' })
    expect(getBridgeDepositInstructions).not.toHaveBeenCalled()
  })

  it('refuses a transfer past PENDING_PAYMENT — instructions would never render', async () => {
    from.mockReturnValue(
      mockTransfer({ id: TRANSFER_ID, state: 'FUNDED', send_amount_minor: 10000, fee_amount_minor: 0 }),
    )
    const result = await attachDepositInstructions({
      transferId: TRANSFER_ID,
      bridgeTransferId: ONRAMP_ID,
      operator: OPERATOR,
    })
    expect(result).toEqual({ outcome: 'not_pending_payment', state: 'FUNDED' })
  })

  it('refuses when the onramp amount differs — wrong onramp id', async () => {
    from.mockReturnValue(
      mockTransfer({ id: TRANSFER_ID, state: 'PENDING_PAYMENT', send_amount_minor: 10000, fee_amount_minor: 0 }),
    )
    getBridgeDepositInstructions.mockResolvedValue({ ...INSTRUCTIONS, amount: '250.00' })
    const result = await attachDepositInstructions({
      transferId: TRANSFER_ID,
      bridgeTransferId: ONRAMP_ID,
      operator: OPERATOR,
    })
    expect(result).toEqual({ outcome: 'amount_mismatch', expectedMinor: 10000, bridgeMinor: 25000 })
  })

  it('refuses an unparseable onramp amount rather than guessing', async () => {
    from.mockReturnValue(
      mockTransfer({ id: TRANSFER_ID, state: 'PENDING_PAYMENT', send_amount_minor: 10000, fee_amount_minor: 0 }),
    )
    getBridgeDepositInstructions.mockResolvedValue({ ...INSTRUCTIONS, amount: '100.001' })
    const result = await attachDepositInstructions({
      transferId: TRANSFER_ID,
      bridgeTransferId: ONRAMP_ID,
      operator: OPERATOR,
    })
    expect(result).toEqual({ outcome: 'amount_mismatch', expectedMinor: 10000, bridgeMinor: null })
  })

  it('attaches when Bridge states no amount (older onramps omit it)', async () => {
    const transfers = mockTransfer({
      id: TRANSFER_ID,
      state: 'PENDING_PAYMENT',
      send_amount_minor: 10000,
      fee_amount_minor: 0,
    })
    const instructions = mockUpsert({ transfer_id: TRANSFER_ID })
    from.mockImplementation((table: string) =>
      table === 'transfers' ? transfers : instructions,
    )
    getBridgeDepositInstructions.mockResolvedValue({ ...INSTRUCTIONS, amount: null })
    const result = await attachDepositInstructions({
      transferId: TRANSFER_ID,
      bridgeTransferId: ONRAMP_ID,
      operator: OPERATOR,
    })
    expect(result.outcome).toBe('attached')
  })

  it('refuses non-USD instructions', async () => {
    from.mockReturnValue(
      mockTransfer({ id: TRANSFER_ID, state: 'PENDING_PAYMENT', send_amount_minor: 10000, fee_amount_minor: 0 }),
    )
    getBridgeDepositInstructions.mockResolvedValue({ ...INSTRUCTIONS, currency: 'eur' })
    const result = await attachDepositInstructions({
      transferId: TRANSFER_ID,
      bridgeTransferId: ONRAMP_ID,
      operator: OPERATOR,
    })
    expect(result).toEqual({ outcome: 'instructions_unavailable' })
  })

  it('maps Bridge 502/404 to instructions_unavailable and rethrows the rest', async () => {
    from.mockReturnValue(
      mockTransfer({ id: TRANSFER_ID, state: 'PENDING_PAYMENT', send_amount_minor: 10000, fee_amount_minor: 0 }),
    )
    getBridgeDepositInstructions.mockRejectedValueOnce(new BridgeApiError(502, {}))
    expect(
      (
        await attachDepositInstructions({
          transferId: TRANSFER_ID,
          bridgeTransferId: ONRAMP_ID,
          operator: OPERATOR,
        })
      ).outcome,
    ).toBe('instructions_unavailable')

    getBridgeDepositInstructions.mockRejectedValueOnce(new BridgeApiError(500, {}))
    await expect(
      attachDepositInstructions({
        transferId: TRANSFER_ID,
        bridgeTransferId: ONRAMP_ID,
        operator: OPERATOR,
      }),
    ).rejects.toMatchObject({ statusCode: 500 })
  })
})

describe('getDepositInstructions', () => {
  it('returns the row, or null when nothing is attached', async () => {
    const row = { transfer_id: TRANSFER_ID, deposit_message: 'BRGABCD1234' }
    const maybeSingle = vi.fn().mockResolvedValue({ data: row })
    const eq = vi.fn().mockReturnValue({ maybeSingle })
    const select = vi.fn().mockReturnValue({ eq })
    from.mockReturnValue({ select, eq, maybeSingle })

    expect(await getDepositInstructions(TRANSFER_ID)).toEqual(row)

    maybeSingle.mockResolvedValue({ data: null })
    expect(await getDepositInstructions(TRANSFER_ID)).toBeNull()
  })
})
