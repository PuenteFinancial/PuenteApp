import { describe, it, expect, vi } from 'vitest'

// Parser-only: main() is gated on direct invocation, and the attach rules are
// pinned in services/deposit-instructions.test.ts. Env access happens at
// import time via the service chain, so stub the pieces the import touches.
vi.mock('../src/services/supabase.js', () => ({ supabaseAdmin: {} }))
vi.mock('../src/services/deposit-instructions.js', () => ({
  attachDepositInstructions: vi.fn(),
}))
vi.mock('../src/services/bridge.js', () => ({
  getBridgeDepositInstructions: vi.fn(),
  BridgeApiError: class extends Error {},
}))

const { parseArgs } = await import('./attach-deposit-instructions.js')

const TRANSFER = '22222222-2222-4222-8222-222222222222'
const ONRAMP = '33333333-3333-4333-8333-333333333333'
const OPERATOR = '44444444-4444-4444-8444-444444444444'

describe('parseArgs', () => {
  it('parses the full invocation', () => {
    expect(
      parseArgs([TRANSFER, '--bridge-transfer', ONRAMP, '--operator', OPERATOR, '--confirm']),
    ).toEqual({
      transferId: TRANSFER,
      bridgeTransferId: ONRAMP,
      operator: OPERATOR,
      confirm: true,
    })
  })

  it('defaults to dry run without --confirm', () => {
    expect(parseArgs([TRANSFER, '--bridge-transfer', ONRAMP, '--operator', OPERATOR]).confirm).toBe(
      false,
    )
  })

  it.each([
    [['not-a-uuid', '--bridge-transfer', ONRAMP, '--operator', OPERATOR]],
    [[TRANSFER, '--bridge-transfer', 'onramp-1', '--operator', OPERATOR]],
    [[TRANSFER, '--bridge-transfer', ONRAMP, '--operator', 'me']],
    [[TRANSFER, '--bridge-transfer', ONRAMP, '--operator', OPERATOR, '--force']],
    [[TRANSFER, '--operator', OPERATOR]],
  ])('rejects %j', (argv) => {
    expect(() => parseArgs(argv as string[])).toThrow()
  })
})
