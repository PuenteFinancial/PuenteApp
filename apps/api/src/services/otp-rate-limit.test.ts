import { describe, it, expect, beforeEach, vi } from 'vitest'

const rpc = vi.fn()

vi.mock('./supabase.js', () => ({
  supabaseAdmin: {
    rpc: (...args: unknown[]) => rpc(...args) as unknown,
  },
}))

const { admitOtpSend, phoneBucketKey } = await import('./otp-rate-limit.js')

const PHONE = '15555555555'

beforeEach(() => {
  rpc.mockReset()
})

describe('phoneBucketKey', () => {
  it('is a 64-char hex digest', () => {
    expect(phoneBucketKey(PHONE)).toMatch(/^[0-9a-f]{64}$/)
  })

  it('is stable for the same number', () => {
    // The bucket only works if a number always lands in the same one. The NANP
    // allowlist on the route is what guarantees the input is already canonical
    // by the time it gets here, so no normalisation happens in this function.
    expect(phoneBucketKey(PHONE)).toBe(phoneBucketKey(PHONE))
  })

  it('separates different numbers', () => {
    expect(phoneBucketKey(PHONE)).not.toBe(phoneBucketKey('12125550123'))
  })

  it('does not contain the number it hashed', () => {
    expect(phoneBucketKey(PHONE)).not.toContain('5555555555')
  })

  it('is not a bare SHA-256 of the number', async () => {
    // The whole point of the pepper. NANP numbers are a ~10^10 space, so an
    // unkeyed digest is reversed by enumeration in seconds — which would make
    // the stored column PII in all but name. If this ever equals the plain
    // digest, the pepper has been dropped.
    const { createHash } = await import('node:crypto')
    const bare = createHash('sha256').update(PHONE, 'utf8').digest('hex')
    expect(phoneBucketKey(PHONE)).not.toBe(bare)
  })
})

describe('admitOtpSend', () => {
  it('passes the hash, never the number, to the database', async () => {
    rpc.mockResolvedValue({ data: [{ allowed: true, retry_after_seconds: 0 }], error: null })

    await admitOtpSend(PHONE)

    const [fn, args] = rpc.mock.calls[0] as [string, Record<string, unknown>]
    expect(fn).toBe('otp_attempt_admit')
    expect(args.p_phone_hash).toBe(phoneBucketKey(PHONE))
    expect(JSON.stringify(args)).not.toContain(PHONE)
  })

  it('admits when the function says so', async () => {
    rpc.mockResolvedValue({ data: [{ allowed: true, retry_after_seconds: 0 }], error: null })
    await expect(admitOtpSend(PHONE)).resolves.toEqual({ allowed: true, retryAfterSeconds: 0 })
  })

  it('denies with the retry hint the function returned', async () => {
    rpc.mockResolvedValue({ data: [{ allowed: false, retry_after_seconds: 42 }], error: null })
    await expect(admitOtpSend(PHONE)).resolves.toEqual({ allowed: false, retryAfterSeconds: 42 })
  })

  it.each([
    ['an rpc error', { data: null, error: { message: 'connection refused' } }],
    ['an empty result', { data: [], error: null }],
    ['a null result', { data: null, error: null }],
    ['a row without a verdict', { data: [{ retry_after_seconds: 0 }], error: null }],
  ])('fails closed on %s', async (_case, result) => {
    // A limiter that opens under load is not a limiter. This is the opposite of
    // the usual login-path advice to fail open, and deliberate: the downside
    // here is a bill, not an inconvenience.
    rpc.mockResolvedValue(result)
    const verdict = await admitOtpSend(PHONE)
    expect(verdict.allowed).toBe(false)
    expect(verdict.retryAfterSeconds).toBeGreaterThan(0)
  })
})
