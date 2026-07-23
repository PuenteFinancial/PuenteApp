import { describe, it, expect } from 'vitest'
import { resolveSendMoneyFlag } from './flags'

describe('resolveSendMoneyFlag', () => {
  it('honors PostHog’s explicit boolean regardless of environment', () => {
    expect(resolveSendMoneyFlag(true, true)).toBe(true)
    expect(resolveSendMoneyFlag(true, false)).toBe(true)
    expect(resolveSendMoneyFlag(false, false)).toBe(false)
    expect(resolveSendMoneyFlag(false, true)).toBe(false)
  })

  it('fails safe when PostHog can’t answer: hidden in production, visible elsewhere', () => {
    expect(resolveSendMoneyFlag(undefined, true)).toBe(false) // production → hidden
    expect(resolveSendMoneyFlag(undefined, false)).toBe(true) // dev/preview/staging → visible
  })
})
