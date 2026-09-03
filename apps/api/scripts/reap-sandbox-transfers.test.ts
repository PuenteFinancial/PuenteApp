import { describe, it, expect } from 'vitest'
import { sandboxRailRefusal, parseArgs } from './reap-sandbox-transfers.js'

// The gate is the whole safety story for this script: it fails and refunds
// transfers, which on the live rail is real customer money.
describe('sandboxRailRefusal', () => {
  it('allows exactly the Bridge sandbox host', () => {
    expect(sandboxRailRefusal('https://api.sandbox.bridge.xyz')).toBeNull()
    expect(sandboxRailRefusal('https://api.sandbox.bridge.xyz/')).toBeNull()
  })

  it('refuses the live rail — which is also the env default', () => {
    // config/env.ts defaults BRIDGE_API_BASE to https://api.bridge.xyz, so an
    // unset value is production. That must refuse, not pass.
    const refusal = sandboxRailRefusal('https://api.bridge.xyz')
    expect(refusal).toContain('refusing to run')
    expect(refusal).toContain('api.bridge.xyz')
  })

  it('is not fooled by the word "sandbox" appearing off-host', () => {
    // A substring check would pass all three of these.
    expect(sandboxRailRefusal('https://api.bridge.xyz/?x=sandbox')).toContain('refusing')
    expect(sandboxRailRefusal('https://api.bridge.xyz#sandbox')).toContain('refusing')
    expect(sandboxRailRefusal('https://sandbox.example.com')).toContain('refusing')
    expect(sandboxRailRefusal('https://api.sandbox.bridge.xyz.evil.com')).toContain('refusing')
  })

  it('refuses an unparseable base rather than falling through', () => {
    expect(sandboxRailRefusal('')).toContain('not a valid URL')
    expect(sandboxRailRefusal('api.sandbox.bridge.xyz')).toContain('not a valid URL')
  })
})

describe('parseArgs', () => {
  it('defaults to a 3-day age and dry run', () => {
    expect(parseArgs([])).toEqual({ olderThanDays: 3, confirm: false })
  })

  it('reads an explicit age and the confirm flag', () => {
    expect(parseArgs(['--older-than-days', '7', '--confirm'])).toEqual({
      olderThanDays: 7,
      confirm: true,
    })
  })

  it('rejects unknown flags instead of ignoring them', () => {
    expect(() => parseArgs(['--force'])).toThrow(/unknown flag/)
  })

  it('will not let --confirm be swallowed as the age value', () => {
    // A lenient parser reads olderThanDays="--confirm", drops the confirm, and
    // silently turns an intended reap into a dry run — or worse, the reverse.
    expect(() => parseArgs(['--older-than-days', '--confirm'])).toThrow(/needs a value/)
  })

  it('rejects a missing or non-numeric age rather than defaulting', () => {
    expect(() => parseArgs(['--older-than-days'])).toThrow(/needs a value/)
    expect(() => parseArgs(['--older-than-days', '3.5'])).toThrow(/whole number/)
    expect(() => parseArgs(['--older-than-days', 'lots'])).toThrow(/whole number/)
    expect(() => parseArgs(['--older-than-days', '0'])).toThrow(/at least 1/)
  })
})
