import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'

import { env } from '../config/env.js'

// At-rest encryption for sensitive payout-destination fields (the CLABE).
// Payload format: "v1.<b64url iv>.<b64url ciphertext>.<b64url tag>".
// The v1 prefix is the key-rotation hook; AAD binds each ciphertext to the
// row it belongs to (we pass the recipient id), so a ciphertext copied onto
// another row fails authentication instead of decrypting.

const VERSION = 'v1'
const IV_BYTES = 12
const TAG_BYTES = 16

export class DecryptionError extends Error {
  constructor() {
    // Deliberately detail-free: decryption failures must not leak whether the
    // payload was malformed, tampered with, or bound to a different row.
    super('Unable to decrypt payload')
    this.name = 'DecryptionError'
  }
}

export function encryptString(plaintext: string, aad: string): string {
  const iv = randomBytes(IV_BYTES)
  const cipher = createCipheriv('aes-256-gcm', env.DETAILS_ENCRYPTION_KEY, iv)
  cipher.setAAD(Buffer.from(aad, 'utf8'))
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()])
  const tag = cipher.getAuthTag()
  return [
    VERSION,
    iv.toString('base64url'),
    ciphertext.toString('base64url'),
    tag.toString('base64url'),
  ].join('.')
}

export function decryptString(payload: string, aad: string): string {
  try {
    const [version, ivSegment, ctSegment, tagSegment, ...rest] = payload.split('.')
    if (version !== VERSION || !ivSegment || !ctSegment || !tagSegment || rest.length > 0) {
      throw new Error('bad format')
    }
    const iv = Buffer.from(ivSegment, 'base64url')
    const ciphertext = Buffer.from(ctSegment, 'base64url')
    const tag = Buffer.from(tagSegment, 'base64url')
    if (iv.length !== IV_BYTES || tag.length !== TAG_BYTES) throw new Error('bad lengths')
    const decipher = createDecipheriv('aes-256-gcm', env.DETAILS_ENCRYPTION_KEY, iv)
    decipher.setAAD(Buffer.from(aad, 'utf8'))
    decipher.setAuthTag(tag)
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8')
  } catch {
    throw new DecryptionError()
  }
}

// Called at server start: proves the configured key actually encrypts and
// decrypts before any PII is written. A wrong or corrupted key otherwise
// stays invisible until the first payout decrypt (slice 5).
export function assertEncryptionKeyUsable(): void {
  const roundTrip = decryptString(encryptString('boot-self-test', 'boot'), 'boot')
  if (roundTrip !== 'boot-self-test') {
    throw new Error('DETAILS_ENCRYPTION_KEY failed the encrypt/decrypt self-test')
  }
}
