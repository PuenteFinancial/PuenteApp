import { describe, it, expect, vi } from 'vitest'

// Arg parsing for the refund CLI. This is the only user input on a path that
// disburses money, so every way a mistyped command could be silently
// reinterpreted is pinned here. The script's collaborators are mocked so that
// importing it can never touch the database or a funding processor.
vi.mock('../src/services/refunds.js', () => ({
  refundPayoutFailure: vi.fn(),
  verifyPrincipalReturned: vi.fn(),
  listRefundBacklog: vi.fn(),
  refundLedgerBatches: vi.fn(),
}))

const { parseArgs } = await import('./trigger-refund.js')

const ID = '00000000-0000-4000-8000-000000000081'

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

  it('refuses an empty invocation', () => {
    expect(parseArgs([])).toMatchObject({ mode: 'error' })
  })
})
