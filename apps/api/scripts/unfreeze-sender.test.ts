import { describe, it, expect } from 'vitest'
import { parseArgs, unfreezeRefusal } from './unfreeze-sender.js'

const USER = 'dddddddd-1111-4222-8333-444444444444'
const OPERATOR = 'aaaaaaaa-1111-4222-8333-444444444444'
const NOTE = 'sender repaid the returned debit; bank confirmed'

const argv = (...extra: string[]) => ['--user', USER, '--operator', OPERATOR, '--note', NOTE, ...extra]

describe('parseArgs', () => {
  it('parses the full invocation and defaults to a dry run', () => {
    // Dry-run-by-default is the whole safety posture of these tools: the
    // dangerous form has to be typed on purpose.
    expect(parseArgs(argv())).toEqual({ userId: USER, operator: OPERATOR, note: NOTE, confirm: false })
    expect(parseArgs(argv('--confirm')).confirm).toBe(true)
  })

  it('requires --operator, because a defaulted actor is worthless in an audit trail', () => {
    expect(() => parseArgs(['--user', USER, '--note', NOTE])).toThrow(/--operator/)
  })

  it('requires a note, and one long enough to be a sentence', () => {
    // An unfreeze with no stated reason is exactly the row an examiner asks
    // about, so the note is not optional and "ok" is not a note.
    expect(() => parseArgs(['--user', USER, '--operator', OPERATOR])).toThrow(/--note/)
    expect(() => parseArgs(['--user', USER, '--operator', OPERATOR, '--note', 'ok'])).toThrow(/10-500/)
    expect(() =>
      parseArgs(['--user', USER, '--operator', OPERATOR, '--note', 'x'.repeat(501)]),
    ).toThrow(/10-500/)
  })

  it('rejects a note that is only whitespace', () => {
    expect(() => parseArgs(['--user', USER, '--operator', OPERATOR, '--note', '           '])).toThrow(/--note/)
  })

  it('rejects a non-UUID id rather than querying for it', () => {
    expect(() => parseArgs(['--user', 'nope', '--operator', OPERATOR, '--note', NOTE])).toThrow(/must be a UUID/)
    expect(() => parseArgs(['--user', USER, '--operator', 'nope', '--note', NOTE])).toThrow(/must be a UUID/)
  })

  it('rejects an unknown flag instead of silently ignoring it', () => {
    // A typo'd --confrim that quietly meant "dry run" would be a tool that
    // lies, and a typo'd --forse that quietly meant nothing is worse.
    expect(() => parseArgs(argv('--force'))).toThrow(/unknown flag --force/)
  })

  it('treats a flag as a missing value, not as the value', () => {
    expect(() => parseArgs(['--user', '--confirm', '--operator', OPERATOR, '--note', NOTE])).toThrow(/--user/)
  })

  it('lowercases both ids so the audit row is comparable', () => {
    const upper = parseArgs(['--user', USER.toUpperCase(), '--operator', OPERATOR.toUpperCase(), '--note', NOTE])
    expect(upper.userId).toBe(USER)
    expect(upper.operator).toBe(OPERATOR)
  })
})

describe('unfreezeRefusal', () => {
  it('accepts only a suspended account', () => {
    expect(unfreezeRefusal({ status: 'suspended' })).toBeNull()
  })

  it('refuses a typo that lands on nobody', () => {
    expect(unfreezeRefusal(null)).toMatch(/no such user/)
  })

  it.each(['active', 'waitlist'])('refuses %s — this lifts a freeze, it never grants access', (status) => {
    // The dangerous misuse is pointing this at a waitlist account and promoting
    // it to active. The service's compare-and-swap refuses too; this is the
    // message that explains why.
    expect(unfreezeRefusal({ status })).toMatch(/never grants access/)
  })
})
