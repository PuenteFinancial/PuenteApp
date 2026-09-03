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
const refundClaimStatus = vi.hoisted(() => vi.fn())
const releaseStaleRefundClaim = vi.hoisted(() => vi.fn())
vi.mock('../src/services/refunds.js', () => ({
  refundPayoutFailure: (...a: unknown[]) => refundPayoutFailure(...a),
  verifyPrincipalReturned: (...a: unknown[]) => verifyPrincipalReturned(...a),
  listRefundBacklog: (...a: unknown[]) => listRefundBacklog(...a),
  refundLedgerBatches: (...a: unknown[]) => refundLedgerBatches(...a),
  refundClaimStatus: (...a: unknown[]) => refundClaimStatus(...a),
  releaseStaleRefundClaim: (...a: unknown[]) => releaseStaleRefundClaim(...a),
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
  refundClaimStatus.mockResolvedValue({
    claimStatus: 'unclaimed',
    claimedAt: null,
    claimedBy: null,
  })
  releaseStaleRefundClaim.mockResolvedValue(true)
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
      reclaim: false,
    })
  })

  it('defaults to a dry run when --confirm is absent', () => {
    expect(parseArgs([ID, '--operator', 'jphelps'])).toMatchObject({ confirm: false })
  })

  it('parses --list', () => {
    expect(parseArgs(['--list'])).toEqual({ mode: 'list' })
  })

  it('parses --reclaim alongside --confirm', () => {
    expect(parseArgs([ID, '--operator', 'jphelps', '--confirm', '--reclaim'])).toMatchObject({
      confirm: true,
      reclaim: true,
    })
  })

  // Accepting --reclaim on a dry run would print "claim cleared" for a run that
  // wrote nothing — the operator would believe the transfer was unblocked.
  it('rejects --reclaim without --confirm', () => {
    expect(parseArgs([ID, '--operator', 'jphelps', '--reclaim'])).toMatchObject({
      mode: 'error',
      message: expect.stringContaining('--reclaim requires --confirm'),
    })
  })

  it('does not let --reclaim be smuggled in as an operator value', () => {
    expect(parseArgs([ID, '--operator', '--reclaim', '--confirm'])).toMatchObject({ mode: 'error' })
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

  // #254: a row that never reached SUBMITTED has nothing at Bridge to return.
  // The interlock's `not_submitted` used to be a refusal ("wrong runbook"),
  // which stranded exactly the rows that needed this runbook most.
  it('a never-submitted row (#254) passes the interlock and verifies only the REFUNDED batch', async () => {
    verifyPrincipalReturned.mockResolvedValue({ returned: false, reason: 'not_submitted' })
    refundLedgerBatches.mockResolvedValue([
      { transition: 'REFUNDED', idempotency_key: `${ID}:REFUNDED` },
    ])

    await expect(trigger(ID, 'jphelps', true)).resolves.toBeUndefined()

    expect(refundPayoutFailure).toHaveBeenCalledWith(
      expect.objectContaining({ transferId: ID, actor: 'ops:jphelps' }),
    )
  })

  it('a never-submitted row still fails when REFUNDED itself is missing', async () => {
    verifyPrincipalReturned.mockResolvedValue({ returned: false, reason: 'not_submitted' })
    refundLedgerBatches.mockResolvedValue([])

    await expect(trigger(ID, 'jphelps', true)).rejects.toThrow(/missing ledger batch .*:REFUNDED/)
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

// ── the refund claim (slice-7 PR6b-0) ──────────────────────────────────────
describe('trigger — the refund claim', () => {
  const abandoned = {
    done: false,
    reason: 'claim_abandoned',
    claimedAt: '2026-07-28T10:00:00.000Z',
    claimedBy: 'ops:someone',
  }

  it('a live claim refuses without alarming the operator, and says nothing was written', async () => {
    refundPayoutFailure.mockResolvedValue({
      done: false,
      reason: 'claim_taken',
      claimedAt: '2026-07-28T10:00:00.000Z',
      claimedBy: 'worker:payment-event',
    })

    // The operator must not reach for --reclaim on a healthy in-flight refund:
    // it would clear nothing (the service guards on staleness), but the attempt
    // means they misread a normal race as a stuck one.
    await expect(trigger(ID, 'jphelps', true)).rejects.toThrow(/RIGHT NOW/)
    await expect(trigger(ID, 'jphelps', true)).rejects.toThrow(/Nothing was written/)
    await expect(trigger(ID, 'jphelps', true)).rejects.not.toThrow(/--reclaim/)
  })

  it('an abandoned claim leads with the ambiguity, not the remedy', async () => {
    refundPayoutFailure.mockResolvedValue(abandoned)

    // The failure mode this copy exists to prevent: an operator who reads
    // "stuck, use --reclaim", reclaims, and pays the sender a second time.
    // Confirming in the processor comes FIRST and the did-happen branch is
    // spelled out, because it is the branch that costs money.
    const err = await trigger(ID, 'jphelps', true).then(
      () => null,
      (e: unknown) => e as Error,
    )
    expect(err).toBeInstanceOf(StepError)
    const message = err!.message
    expect(message).toMatch(/MAY ALREADY HAVE BEEN PAID/)
    expect(message).toMatch(/Confirm in the funding processor/)
    expect(message).toMatch(/do NOT reclaim/)
    expect(message.indexOf('Confirm in the funding processor')).toBeLessThan(
      message.indexOf('--reclaim'),
    )
    expect(message).toContain('ops:someone')
  })

  it('--reclaim clears the claim BEFORE re-driving the tail', async () => {
    const order: string[] = []
    releaseStaleRefundClaim.mockImplementation(() => {
      order.push('release')
      return Promise.resolve(true)
    })
    refundPayoutFailure.mockImplementation(() => {
      order.push('refund')
      return Promise.resolve({ done: true, outcome: 'refunded' })
    })

    await trigger(ID, 'jphelps', true, true)

    expect(order).toEqual(['release', 'refund'])
    expect(releaseStaleRefundClaim).toHaveBeenCalledWith(ID)
  })

  it('never runs the release when --reclaim is absent', async () => {
    await trigger(ID, 'jphelps', true)
    expect(releaseStaleRefundClaim).not.toHaveBeenCalled()
  })

  it('a --reclaim that clears nothing still refuses — it must not report success', async () => {
    releaseStaleRefundClaim.mockResolvedValue(false)
    refundPayoutFailure.mockResolvedValue(abandoned)

    await expect(trigger(ID, 'jphelps', true, true)).rejects.toThrow(/claim_abandoned/)
  })

  it('the dry run reports an abandoned claim before the operator reaches for --confirm', async () => {
    refundClaimStatus.mockResolvedValue({
      claimStatus: 'abandoned',
      claimedAt: '2026-07-28T10:00:00.000Z',
      claimedBy: 'ops:someone',
    })
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})

    await trigger(ID, 'jphelps', false)

    expect(log.mock.calls.flat().join('\n')).toContain('claim abandoned')
    expect(refundPayoutFailure).not.toHaveBeenCalled() // still a dry run
  })

  it('refuses a transfer that vanished before anything is attempted', async () => {
    refundClaimStatus.mockResolvedValue(null)
    await expect(trigger(ID, 'jphelps', true)).rejects.toThrow(/no transfer with that id/)
    expect(refundPayoutFailure).not.toHaveBeenCalled()
  })
})
