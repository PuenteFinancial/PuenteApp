import { describe, it, expect } from 'vitest'
import { assertNever } from './assert-never.js'

// The COMPILE-time behaviour is the point of this helper and cannot be asserted
// from a test — it is exercised by every switch that ends in it, and verified by
// adding a synthetic union arm and watching tsc fail (see the PR that added it).
// What is worth pinning here is the runtime shape, because the throw is what an
// operator and on-call actually read.
describe('assertNever', () => {
  it('names the context and the discriminant', () => {
    expect(() => assertNever({ reason: 'sudden_new_arm' } as never, 'ops/transfers/refund refusal')).toThrow(
      "ops/transfers/refund refusal: unhandled variant 'sudden_new_arm'",
    )
  })

  it('reads `outcome` when that is the discriminant instead', () => {
    expect(() => assertNever({ outcome: 'stale' } as never, 'funding apply')).toThrow(
      "funding apply: unhandled variant 'stale'",
    )
  })

  it('carries the discriminant ONLY — never the rest of the outcome object', () => {
    // Deliberate, and the reason the tag is extracted rather than the value
    // stringified: outcome objects carry transfer ids and provider detail
    // strings, and this message lands in logs verbatim. A helper that exists to
    // make failures loud must not make them loud in the wrong way.
    const leaky = {
      reason: 'funding_disputed',
      transferId: 'cccccccc-1111-4222-8333-444444444444',
      detail: 'funding_disputed_at is set (2026-09-14T22:20:00.000Z)',
    } as never

    expect(() => assertNever(leaky, 'ops/transfers/refund refusal')).toThrow(/funding_disputed/)
    try {
      assertNever(leaky, 'ops/transfers/refund refusal')
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      expect(message).not.toContain('cccccccc')
      expect(message).not.toContain('2026-09-14')
    }
  })

  it('falls back to the value itself when there is no discriminant to name', () => {
    expect(() => assertNever('bare' as never, 'somewhere')).toThrow("somewhere: unhandled variant 'bare'")
    expect(() => assertNever(null as never, 'somewhere')).toThrow("somewhere: unhandled variant 'null'")
  })
})
