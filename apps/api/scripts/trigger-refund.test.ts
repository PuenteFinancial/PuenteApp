import { describe, it, expect, beforeEach, vi } from 'vitest'

// The refund CLI. Two classes of guarantee are pinned here: the arg parsing
// (the only user input on a path that disburses money, so every way a mistyped
// command could be silently reinterpreted is a test), and the two guards that
// actually stop a refund — the dry-run default and the principal interlock.
// The service is mocked, so importing this can never touch the database or a
// funding processor.
const refundPayoutFailure = vi.hoisted(() => vi.fn())
const verifyPrincipalReturned = vi.hoisted(() => vi.fn())
const listRefundBacklog = vi.hoisted(() => vi.fn())
const refundLedgerBatches = vi.hoisted(() => vi.fn())
vi.mock('../src/services/refunds.js', () => ({
  refundPayoutFailure: (...a: unknown[]) => refundPayoutFailure(...a),
  verifyPrincipalReturned: (...a: unknown[]) => verifyPrincipalReturned(...a),
  listRefundBacklog: (...a: unknown[]) => listRefundBacklog(...a),
  refundLedgerBatches: (...a: unknown[]) => refundLedgerBatches(...a),
}))

const { parseArgs, trigger, StepError } = await import('./trigger-refund.js')

const ID = '00000000-0000-4000-8000-000000000081'

beforeEach(() => {
  vi.clearAllMocks()
  vi.spyOn(console, 'log').mockImplementation(() => {})
  verifyPrincipalReturned.mockResolvedValue({
    returned: true,
    bridgeState: 'returned',
    eventType: 'refunded',
  })
  refundPayoutFailure.mockResolvedValue({ done: true, outcome: 'refunded' })
  refundLedgerBatches.mockResolvedValue([
    { transition: 'bridge_return', idempotency_key: `${ID}:bridge_return` },
    { transition: 'REFUNDED', idempotency_key: `${ID}:REFUNDED` },
  ])
})

describe('parseArgs', () => {
  it('parses the execute form', () => {
    expect(parseArgs([ID, '--operator', 'jphelps', '--confirm'])).toEqual({
      mode: 'trigger',
      transferId: ID,
      operator: 'jphelps',
      confirm: true,
    })
  })

  it('defaults to a dry run when --confirm is absent', () => {
    expect(parseArgs([ID, '--operator', 'jphelps'])).toMatchObject({ confirm: false })
  })

  it('parses --list', () => {
    expect(parseArgs(['--list'])).toEqual({ mode: 'list' })
  })

  // The bug this test exists for: `--confirm` matches the operator charset, so
  // a lenient parser reads it as BOTH the operator name and the confirmation —
  // disbursing money under the actor `ops:--confirm`, which destroys the only
  // durable record of who triggered the refund.
  it('refuses a flag as the --operator value instead of disbursing under it', () => {
    const parsed = parseArgs([ID, '--operator', '--confirm'])
    expect(parsed.mode).toBe('error')
    expect(parsed).toMatchObject({ message: expect.stringContaining('--operator') })
  })

  it('refuses a missing --operator', () => {
    expect(parseArgs([ID])).toMatchObject({ mode: 'error' })
  })

  it('refuses an operator outside the charset', () => {
    expect(parseArgs([ID, '--operator', 'Bad Op!'])).toMatchObject({ mode: 'error' })
    expect(parseArgs([ID, '--operator', 'x'])).toMatchObject({ mode: 'error' }) // too short
  })

  // A typo'd confirm flag must NOT degrade to a dry run that exits 0 — the
  // operator typed intent to disburse and would be told everything passed.
  it.each(['--comfirm', '-confirm', '--confirm=true'])('refuses the unknown option %s', (flag) => {
    expect(parseArgs([ID, '--operator', 'jphelps', flag])).toMatchObject({ mode: 'error' })
  })

  it('refuses --list combined with execution flags', () => {
    expect(parseArgs(['--list', '--confirm'])).toMatchObject({ mode: 'error' })
    expect(parseArgs([ID, '--operator', 'jphelps', '--list'])).toMatchObject({ mode: 'error' })
  })

  it('refuses a transfer id that is not a UUID', () => {
    // the id is interpolated into a PostgREST `or` FILTER STRING downstream,
    // which takes no bound parameters
    expect(parseArgs(['x),or(1.eq.1', '--operator', 'jphelps'])).toMatchObject({ mode: 'error' })
    expect(parseArgs(['not-a-uuid', '--operator', 'jphelps'])).toMatchObject({ mode: 'error' })
  })

  // Postgres accepts an uppercase uuid, so the refund would run — but ledger
  // keys come from `uuid::text`, which is always lowercase, so the step-3 key
  // check would miss and report FAIL after the sender was already paid.
  it('lowercases the transfer id so the ledger-key check cannot miss', () => {
    expect(parseArgs([ID.toUpperCase(), '--operator', 'jphelps'])).toMatchObject({
      transferId: ID,
    })
  })

  it('refuses an empty invocation', () => {
    expect(parseArgs([])).toMatchObject({ mode: 'error' })
  })

  // A repeated flag would otherwise let its value both name the operator and
  // authorize the disbursement (`--operator me --operator --confirm`).
  it('refuses a repeated --operator', () => {
    expect(parseArgs([ID, '--operator', 'jphelps', '--operator', '--confirm'])).toMatchObject({
      mode: 'error',
    })
  })
})

// The two guards that actually stop money moving. Both are one deleted line
// away from a CLI that disburses while printing "Nothing was written".
describe('trigger', () => {
  it('a dry run never calls the refund service', async () => {
    await trigger(ID, 'jphelps', false)

    expect(verifyPrincipalReturned).toHaveBeenCalledWith(ID)
    expect(refundPayoutFailure).not.toHaveBeenCalled()
  })

  it('refuses to refund when the principal is not confirmed returned', async () => {
    verifyPrincipalReturned.mockResolvedValue({ returned: false, reason: 'no_return_event' })

    await expect(trigger(ID, 'jphelps', true)).rejects.toThrow(StepError)
    // refundPayoutFailure has NO interlock of its own — this is the only thing
    // standing between an unconfirmed return and a bridge_return post
    expect(refundPayoutFailure).not.toHaveBeenCalled()
  })

  it('names the escalation, not a retry, when the principal is stuck at Bridge', async () => {
    verifyPrincipalReturned.mockResolvedValue({
      returned: false,
      reason: 'bridge_disagrees',
      bridgeState: 'refund_failed',
      eventType: 'refunded',
    })

    await expect(trigger(ID, 'jphelps', true)).rejects.toThrow(/STUCK AT BRIDGE/)
    expect(refundPayoutFailure).not.toHaveBeenCalled()
  })

  it('on --confirm passes the ops actor through to the service', async () => {
    await trigger(ID, 'jphelps', true)

    expect(refundPayoutFailure).toHaveBeenCalledWith({
      transferId: ID,
      actor: 'ops:jphelps',
      reason: 'operator-triggered refund — AUTO_REFUND off',
    })
  })

  it('fails when the service refuses', async () => {
    refundPayoutFailure.mockResolvedValue({
      done: false,
      reason: 'not_payout_failed',
      state: 'COMPLETED',
    })

    await expect(trigger(ID, 'jphelps', true)).rejects.toThrow(/not_payout_failed/)
  })

  it('fails when a ledger batch is missing', async () => {
    refundLedgerBatches.mockResolvedValue([
      { transition: 'bridge_return', idempotency_key: `${ID}:bridge_return` },
    ])

    await expect(trigger(ID, 'jphelps', true)).rejects.toThrow(/missing ledger batch/)
  })

  it('does not claim credit for a run that wrote nothing', async () => {
    refundPayoutFailure.mockResolvedValue({ done: true, outcome: 'already_settled' })
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})

    await trigger(ID, 'someone-else', true)

    const printed = log.mock.calls.flat().join('\n')
    expect(printed).toContain('already REFUNDED')
    expect(printed).not.toContain('refunded by ops:someone-else')
  })
})
