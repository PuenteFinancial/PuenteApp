import { describe, it, expect, vi } from 'vitest'

// Arg parsing and refusal copy only — no database, no processor. The services
// are mocked to nothing because importing them pulls in config/env.ts, which
// validates the whole environment on import.
vi.mock('../src/services/ops-cancel.js', async (importOriginal) => {
  // CANCELABLE_HOLD_REASONS is real (the parser validates against it) but the
  // module's DB-touching exports are never called here.
  const actual = await importOriginal<typeof import('../src/services/ops-cancel.js')>()
  return { ...actual, cancelHeldTransfer: vi.fn(), listHeldTransfers: vi.fn(), cancelLedgerBatches: vi.fn() }
})
vi.mock('../src/services/refunds.js', () => ({
  refundClaimStatus: vi.fn(),
  releaseStaleRefundClaim: vi.fn(),
}))
vi.mock('../src/services/payouts.js', () => ({ checkPayability: vi.fn() }))

const { parseArgs, refusalMessage } = await import('./cancel-held-transfer.js')

const T = '681c8e1a-71b0-40c1-aa20-25f78e0bcf76'
const OP = '00000000-0000-4000-8000-0000000000aa'
const NOTE = 'sandbox destination has no SPEI endorsement; Bridge will never pay it'

const ok = (...extra: string[]) => [T, '--operator', OP, '--hold', 'payability', '--note', NOTE, ...extra]

describe('parseArgs', () => {
  it('parses a dry run', () => {
    expect(parseArgs(ok())).toEqual({
      mode: 'cancel',
      transferId: T,
      operator: OP,
      holdReason: 'payability',
      note: NOTE,
      confirm: false,
      reclaim: false,
    })
  })

  it('parses --confirm and --reclaim together', () => {
    expect(parseArgs(ok('--confirm', '--reclaim'))).toMatchObject({
      confirm: true,
      reclaim: true,
    })
  })

  it('takes --list alone and refuses it beside execution flags', () => {
    expect(parseArgs(['--list'])).toEqual({ mode: 'list' })
    expect(parseArgs(['--list', '--confirm'])).toMatchObject({ mode: 'error' })
  })

  // The trigger-refund.ts lesson: a lenient parser lets a flag authorize itself.
  it('never lets --confirm slide into a value slot', () => {
    for (const flag of ['--operator', '--hold', '--note']) {
      const argv = [T, flag, '--confirm']
      const parsed = parseArgs(argv)
      expect(parsed.mode).toBe('error')
      // …and specifically not by parsing --confirm as the value.
      expect(JSON.stringify(parsed)).not.toContain('"confirm":true')
    }
  })

  it('refuses a typo rather than silently taking the safe branch', () => {
    expect(parseArgs(ok('--comfirm'))).toEqual({
      mode: 'error',
      message: 'unknown option "--comfirm"',
    })
  })

  it('refuses a repeated value flag', () => {
    expect(parseArgs([T, '--operator', OP, '--operator', OP, '--hold', 'payability', '--note', NOTE])).toEqual({
      mode: 'error',
      message: '--operator given more than once',
    })
  })

  it.each([
    ['not-a-uuid', [ 'not-a-uuid', '--operator', OP, '--hold', 'payability', '--note', NOTE ]],
    ['a missing transfer id', ['--operator', OP, '--hold', 'payability', '--note', NOTE]],
  ])('refuses %s', (_label, argv) => {
    expect(parseArgs(argv).mode).toBe('error')
  })

  it('requires a UUID operator — a defaulted actor is worthless in an audit trail', () => {
    expect(parseArgs([T, '--operator', 'jphelps', '--hold', 'payability', '--note', NOTE])).toEqual({
      mode: 'error',
      message: '--operator must be a UUID, got "jphelps"',
    })
    expect(parseArgs([T, '--hold', 'payability', '--note', NOTE]).mode).toBe('error')
  })

  it('names where the loss-path holds belong instead of just rejecting them', () => {
    const parsed = parseArgs([T, '--operator', OP, '--hold', 'funding_disputed', '--note', NOTE])
    expect(parsed.mode).toBe('error')
    const message = (parsed as { message: string }).message
    expect(message).toContain('funding_disputed')
    expect(message).toContain('funding-reversal.md')
    expect(message).toContain('sender_kyc_pending')
  })

  it('requires a note between 10 and 500 characters', () => {
    expect(parseArgs([T, '--operator', OP, '--hold', 'payability']).mode).toBe('error')
    expect(parseArgs([T, '--operator', OP, '--hold', 'payability', '--note', 'too short']).mode).toBe(
      'error',
    )
    expect(
      parseArgs([T, '--operator', OP, '--hold', 'payability', '--note', 'x'.repeat(501)]).mode,
    ).toBe('error')
  })

  // --reclaim clears an abandoned claim so the tail can be re-driven; on a dry
  // run there is nothing to re-drive, so accepting it would imply the claim had
  // been dealt with when nothing was written.
  it('refuses --reclaim without --confirm', () => {
    expect(parseArgs(ok('--reclaim'))).toEqual({
      mode: 'error',
      message: '--reclaim requires --confirm (there is nothing to reclaim on a dry run)',
    })
  })

  // The RPC builds ledger keys as `p_transfer_id::text || ':' || …` and
  // uuid::text always renders lowercase — an uppercase argument would cancel
  // and then fail the key check AFTER the sender was paid.
  it('lowercases the ids it will compare keys against', () => {
    const parsed = parseArgs([
      T.toUpperCase(),
      '--operator',
      OP.toUpperCase(),
      '--hold',
      'payability',
      '--note',
      NOTE,
    ])
    expect(parsed).toMatchObject({ transferId: T, operator: OP })
  })
})

describe('refusalMessage', () => {
  it('sends a claim_abandoned to the processor before anything else', () => {
    const message = refusalMessage({
      done: false,
      reason: 'claim_abandoned',
      claimedAt: '2026-09-14T00:00:00.000Z',
      claimedBy: 'ops:x',
    })
    expect(message).toContain('MAY ALREADY HAVE BEEN PAID')
    expect(message).toContain('manual-refund.md')
  })

  it('points a submit_in_progress row at the payout-failure tail, not here', () => {
    expect(refusalMessage({ done: false, reason: 'submit_in_progress' })).toContain(
      'trigger-refund.ts',
    )
  })

  it('sends a sender-canceled row to the disbursement it is actually waiting on', () => {
    const message = refusalMessage({ done: false, reason: 'not_our_cancel' })
    expect(message).toContain('manual-refund.md')
    expect(message).toContain('second refund batch')
  })

  it('names the chargeback and sends the row to the loss path', () => {
    const message = refusalMessage({
      done: false,
      reason: 'funding_disputed',
      source: 'provider',
      disputeRef: 'du_1UEAUGIbCQghJX8LxAXiQE5S',
      detail: 'the funding charge is disputed at the provider (needs_response)',
    })
    expect(message).toContain('du_1UEAUGIbCQghJX8LxAXiQE5S')
    expect(message).toContain('pay them twice')
    expect(message).toContain('funding-reversal.md')
    // A provider-only catch means our own records missed it, which is a second
    // problem the operator should go and look at.
    expect(message).toContain('charge.dispute.created')
  })

  it('omits the missed-webhook warning when OUR record caught it', () => {
    const message = refusalMessage({
      done: false,
      reason: 'funding_disputed',
      source: 'record',
      disputeRef: null,
      detail: "the payout is held on 'funding_disputed'",
    })
    expect(message).not.toContain('charge.dispute.created')
    expect(message).toContain('funding-reversal.md')
  })

  it('explains hold_not_cancelable as a policy, not an accident', () => {
    const message = refusalMessage({
      done: false,
      reason: 'hold_not_cancelable',
      actual: 'sender_suspended',
    })
    expect(message).toContain('sender_suspended')
    expect(message).toContain('pays them twice')
  })

  it('has copy for every refusal the service can return', () => {
    const refusals = [
      { done: false, reason: 'transfer_not_found' },
      { done: false, reason: 'not_funded', state: 'COMPLETED' },
      { done: false, reason: 'not_held' },
      { done: false, reason: 'hold_not_cancelable', actual: 'funding_disputed' },
      { done: false, reason: 'hold_reason_mismatch', actual: 'fx_drift' },
      { done: false, reason: 'submit_in_progress' },
      { done: false, reason: 'not_our_cancel' },
      { done: false, reason: 'funding_disputed', source: 'provider', disputeRef: 'du_1', detail: 'x' },
      { done: false, reason: 'funding_disputed', source: 'record', disputeRef: null, detail: 'x' },
      { done: false, reason: 'changed_underneath', state: 'CANCELED' },
      { done: false, reason: 'claim_taken', claimedAt: null, claimedBy: null },
      { done: false, reason: 'claim_abandoned', claimedAt: null, claimedBy: null },
    ] as const
    for (const refusal of refusals) {
      expect(refusalMessage(refusal)).toBeTruthy()
    }
  })
})
