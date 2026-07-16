import { describe, expect, it } from 'vitest'

import { isValidClabe } from './clabe.js'

describe('isValidClabe', () => {
  it('accepts the sandbox-verified dummy CLABE', () => {
    expect(isValidClabe('646180003000000006')).toBe(true)
  })

  it('accepts known-valid published CLABEs', () => {
    // Independently computed with the standard 3-7-1 weighted mod-10 algorithm.
    expect(isValidClabe('002010077777777771')).toBe(true)
    expect(isValidClabe('032180000118359719')).toBe(true)
  })

  it('rejects a mutated check digit', () => {
    expect(isValidClabe('646180003000000007')).toBe(false)
    expect(isValidClabe('646180003000000005')).toBe(false)
  })

  it('rejects a transposition in the body', () => {
    expect(isValidClabe('646180030000000006')).toBe(false)
  })

  it.each([
    ['17 digits', '64618000300000000'],
    ['19 digits', '6461800030000000060'],
    ['letters', '64618000300000000a'],
    ['internal whitespace', '646180 03000000006'],
    ['leading whitespace', ' 46180003000000006'],
    ['unicode digits', '٦46180003000000006'],
    ['empty', ''],
    ['dashes', '646-180-030-000-000'],
  ])('rejects %s', (_name, value) => {
    expect(isValidClabe(value)).toBe(false)
  })

  it('validates all-zeros only per the algorithm (bank existence is Bridge’s job)', () => {
    // 17 zeros → weighted sum 0 → check digit (10 - 0) % 10 = 0
    expect(isValidClabe('000000000000000000')).toBe(true)
    expect(isValidClabe('000000000000000001')).toBe(false)
  })
})
