import { describe, expect, it } from 'vitest'

import { DecryptionError, decryptString, encryptString } from './encryption.js'

const AAD = 'f6f3f9a0-0000-4000-8000-000000000001'

describe('encryptString / decryptString', () => {
  it('round-trips ascii plaintext', () => {
    const payload = encryptString('646180003000000006', AAD)
    expect(decryptString(payload, AAD)).toBe('646180003000000006')
  })

  it('round-trips unicode plaintext', () => {
    const plaintext = 'María del Carmen García López — ñ ✓'
    expect(decryptString(encryptString(plaintext, AAD), AAD)).toBe(plaintext)
  })

  it('produces the v1 four-segment format', () => {
    const payload = encryptString('secret', AAD)
    const segments = payload.split('.')
    expect(segments).toHaveLength(4)
    expect(segments[0]).toBe('v1')
    // base64url alphabet only — no padding, no +, no /
    for (const segment of segments.slice(1)) {
      expect(segment).toMatch(/^[A-Za-z0-9_-]+$/)
    }
  })

  it('uses a fresh IV per call (same plaintext encrypts differently)', () => {
    const a = encryptString('secret', AAD)
    const b = encryptString('secret', AAD)
    expect(a).not.toBe(b)
    expect(a.split('.')[1]).not.toBe(b.split('.')[1])
  })
})

describe('decryptString rejection', () => {
  const tamper = (payload: string, segmentIndex: number): string => {
    const segments = payload.split('.')
    const bytes = Buffer.from(segments[segmentIndex]!, 'base64url')
    bytes[0] = bytes[0]! ^ 0xff
    segments[segmentIndex] = bytes.toString('base64url')
    return segments.join('.')
  }

  it.each([
    ['tampered iv', (p: string) => tamper(p, 1)],
    ['tampered ciphertext', (p: string) => tamper(p, 2)],
    ['tampered auth tag', (p: string) => tamper(p, 3)],
    ['truncated payload', (p: string) => p.slice(0, -2)],
    ['missing segment', (p: string) => p.split('.').slice(0, 3).join('.')],
    ['extra segment', (p: string) => `${p}.extra`],
    ['unknown version', (p: string) => p.replace(/^v1/, 'v2')],
    ['garbage', () => 'not.a.valid.payload'],
    ['empty string', () => ''],
  ])('throws DecryptionError on %s', (_name, mutate) => {
    const payload = encryptString('secret', AAD)
    expect(() => decryptString(mutate(payload), AAD)).toThrow(DecryptionError)
  })

  it('throws DecryptionError on wrong AAD (ciphertext bound to its recipient)', () => {
    const payload = encryptString('secret', AAD)
    expect(() => decryptString(payload, 'other-recipient-id')).toThrow(DecryptionError)
  })

  it('never returns partial plaintext on failure', () => {
    const payload = encryptString('secret', AAD)
    let result: string | undefined
    try {
      result = decryptString(tamper(payload, 2), AAD)
    } catch {
      // expected
    }
    expect(result).toBeUndefined()
  })
})
