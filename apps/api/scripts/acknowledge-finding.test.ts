import { describe, it, expect, vi } from 'vitest'

// The CLI's argument contract. main() is not exercised here (it drives services); these pin the
// refusals that must happen BEFORE anything reaches staging — every one of them is a way to
// silence an alarm by accident.

vi.mock('../src/services/supabase.js', () => ({ supabaseAdmin: { from: vi.fn() } }))
vi.mock('../src/services/reconciliation.js', () => ({ buildChecks: () => [] }))

const { parseArgs } = await import('./acknowledge-finding.js')

const OPERATOR = '4f1a2b3c-1111-4222-8333-abcdefabcdef'
const base = [
  '--check',
  'stripe_disputes',
  '--key',
  'stripe-dispute-unrecorded:du_1ABC',
  '--operator',
  OPERATOR,
  '--note',
  'investigated — predates the loss path',
  '--days',
  '60',
]

describe('parseArgs', () => {
  it('parses a full acknowledgement, dry run by default', () => {
    expect(parseArgs(base)).toEqual({
      mode: 'ack',
      checkName: 'stripe_disputes',
      findingKey: 'stripe-dispute-unrecorded:du_1ABC',
      operator: OPERATOR,
      note: 'investigated — predates the loss path',
      days: 60,
      confirm: false,
    })
  })

  it('--confirm is what makes it write', () => {
    expect(parseArgs([...base, '--confirm'])).toMatchObject({ confirm: true })
  })

  it('--list needs nothing else', () => {
    expect(parseArgs(['--list'])).toEqual({ mode: 'list' })
  })

  it('rejects an unknown flag rather than ignoring it', () => {
    // A silently-ignored --forever is the worst possible failure for this tool.
    expect(() => parseArgs([...base, '--forever'])).toThrow(/unknown flag --forever/)
  })

  it('requires an operator, and requires it to be a uuid', () => {
    const noOperator = base.filter((a, i) => a !== '--operator' && base[i - 1] !== '--operator')
    expect(() => parseArgs(noOperator)).toThrow(/--operator <uuid> is required/)
    expect(() => parseArgs([...base.slice(0, 5), 'not-a-uuid', ...base.slice(6)])).toThrow(
      /--operator must be a UUID/,
    )
  })

  it('requires a note long enough to be a sentence', () => {
    const short = [...base.slice(0, 7), 'nope', ...base.slice(8)]
    expect(() => parseArgs(short)).toThrow(/--note must be 10-500 characters/)
  })

  it('requires --days, and refuses anything outside 1-90', () => {
    const noDays = base.slice(0, 8)
    expect(() => parseArgs(noDays)).toThrow(/--days <n> is required/)
    for (const bad of ['0', '91', '7.5', 'forever']) {
      expect(() => parseArgs([...base.slice(0, 9), bad])).toThrow(/--days must be a whole number/)
    }
  })

  it('a flag whose value is another flag counts as missing, not as that flag', () => {
    // '--note --confirm' must not parse the literal '--confirm' as the note.
    expect(() => parseArgs(['--check', 'a', '--key', 'k', '--operator', OPERATOR, '--note', '--confirm'])).toThrow(
      /--note "<why>" is required/,
    )
  })

  it('parses a revocation', () => {
    const id = '9a8b7c6d-2222-4333-8444-fedcbafedcba'
    expect(
      parseArgs(['--revoke', id, '--operator', OPERATOR, '--note', 'this was the wrong call']),
    ).toEqual({ mode: 'revoke', id, operator: OPERATOR, note: 'this was the wrong call', confirm: false })
  })

  it('a revocation still needs an operator and a note', () => {
    const id = '9a8b7c6d-2222-4333-8444-fedcbafedcba'
    expect(() => parseArgs(['--revoke', id, '--operator', OPERATOR])).toThrow(/--note/)
  })
})
