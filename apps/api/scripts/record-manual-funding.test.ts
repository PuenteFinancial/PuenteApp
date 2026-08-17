import { describe, it, expect } from 'vitest'
import { parseArgs } from './record-manual-funding.js'

// The arg parsing is the only user input on a path that releases an
// irreversible MXN payout, so every way a mistyped command could be silently
// reinterpreted is a test. The service refusals themselves are pinned in
// src/services/funding-apply.test.ts.

const TRANSFER = 'cccccccc-1111-4222-8333-444444444444'
const OPERATOR = 'aaaaaaaa-1111-4222-8333-444444444444'

const ok = [TRANSFER, '--kind', 'funded', '--ref', 'brg_1', '--amount', '20.00', '--operator', OPERATOR]

describe('parseArgs', () => {
  it('parses a complete command', () => {
    expect(parseArgs(ok)).toEqual({
      transferId: TRANSFER,
      kind: 'funded',
      ref: 'brg_1',
      amountMinor: 2000,
      operator: OPERATOR,
      confirm: false,
    })
  })

  it('defaults to a dry run — recording requires --confirm', () => {
    expect(parseArgs(ok).confirm).toBe(false)
    expect(parseArgs([...ok, '--confirm']).confirm).toBe(true)
  })

  it('accepts cleared as the other kind', () => {
    expect(parseArgs([TRANSFER, '--kind', 'cleared', '--ref', 'b', '--amount', '1', '--operator', OPERATOR]).kind).toBe(
      'cleared',
    )
  })

  it.each([['--kind'], ['--ref'], ['--amount'], ['--operator']])('requires %s', (flag) => {
    const without = ok.filter((a, i) => a !== flag && ok[i - 1] !== flag)
    expect(() => parseArgs(without)).toThrow()
  })

  it('requires a transfer id', () => {
    expect(() => parseArgs(ok.slice(1))).toThrow(/transfer id/)
  })

  it('rejects a non-uuid transfer id rather than passing it through', () => {
    expect(() => parseArgs(['not-a-uuid', ...ok.slice(1)])).toThrow(/transfer id/)
  })

  it('rejects a non-uuid operator — the actor record must be a real user', () => {
    expect(() => parseArgs([...ok.slice(0, -1), 'joshua'])).toThrow(/operator/)
  })

  it('rejects an unknown kind rather than defaulting', () => {
    expect(() => parseArgs([TRANSFER, '--kind', 'settled', '--ref', 'b', '--amount', '1', '--operator', OPERATOR]))
      .toThrow(/--kind/)
  })

  it('rejects an unknown flag rather than silently ignoring it', () => {
    expect(() => parseArgs([...ok, '--force'])).toThrow(/unknown flag/)
  })

  it.each([
    ['--kind', ['--ref', 'b']],
    ['--ref', ['--amount', '1']],
    ['--amount', ['--operator', OPERATOR]],
    ['--operator', ['--confirm']],
  ])('refuses when %s swallows the next flag as its value', (flag, tail) => {
    // `--ref --confirm` must not silently record a deposit with ref "--confirm".
    expect(() => parseArgs([TRANSFER, flag, ...tail])).toThrow()
  })

  it('rejects a malformed amount rather than guessing', () => {
    const bad = [TRANSFER, '--kind', 'funded', '--ref', 'b', '--amount', '20.001', '--operator', OPERATOR]
    expect(() => parseArgs(bad)).toThrow()
  })

  it('parses cents exactly — no float arithmetic on an amount', () => {
    const cmd = (amt: string) => parseArgs([TRANSFER, '--kind', 'funded', '--ref', 'b', '--amount', amt, '--operator', OPERATOR])
    expect(cmd('20').amountMinor).toBe(2000)
    expect(cmd('20.5').amountMinor).toBe(2050)
    expect(cmd('0.01').amountMinor).toBe(1)
  })
})
