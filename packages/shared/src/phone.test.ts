import { describe, it, expect } from 'vitest'
import { normalizePhone, toE164Nanp } from './phone.js'

describe('toE164Nanp', () => {
  it('prefixes + to the bare GoTrue shape (the common stored form)', () => {
    expect(toE164Nanp('12025550193')).toBe('+12025550193')
  })

  it('leaves an already-E.164 number alone', () => {
    expect(toE164Nanp('+12025550193')).toBe('+12025550193')
  })

  it('assumes NANP for a bare ten-digit number', () => {
    expect(toE164Nanp('2025550193')).toBe('+12025550193')
  })

  it('strips formatting', () => {
    expect(toE164Nanp('(202) 555-0193')).toBe('+12025550193')
  })

  it('refuses anything outside NANP rather than guessing', () => {
    // Callers pass the result to a provider; a wrong guess is worse than none.
    expect(toE164Nanp('+525512345678')).toBeNull()
    expect(toE164Nanp('')).toBeNull()
    expect(toE164Nanp('123')).toBeNull()
  })

  it('round-trips the wire format normalizePhone emits', () => {
    // The route allowlist guarantees this shape reaches the database.
    expect(toE164Nanp(normalizePhone('202-555-0193'))).toBe('+12025550193')
  })
})
