import { describe, it, expect, vi, beforeEach } from 'vitest'

const insert = vi.fn(async (..._args: unknown[]) => ({ error: null as unknown }))
const from = vi.fn((_table: string) => ({ insert }))

vi.mock('./supabase.js', () => ({
  supabaseAdmin: { from: (...args: [string]) => from(...args) },
}))

const {
  bridgeKycToVerificationStatus,
  recordKycVerification,
  stripeTierToVerificationStatus,
} = await import('./kyc-verifications.js')

const log = { error: vi.fn() }

beforeEach(() => {
  insert.mockClear()
  from.mockClear()
  log.error.mockClear()
  insert.mockResolvedValue({ error: null })
})

describe('status mapping', () => {
  it('maps Bridge kyc_status onto the log vocabulary', () => {
    expect(bridgeKycToVerificationStatus('approved')).toBe('verified')
    expect(bridgeKycToVerificationStatus('rejected')).toBe('rejected')
    expect(bridgeKycToVerificationStatus('manual_review')).toBe('review')
    expect(bridgeKycToVerificationStatus('pending')).toBe('pending')
    expect(bridgeKycToVerificationStatus('not_started')).toBe('pending')
  })

  it('maps the Stripe tier cache the way cacheKycStatus derives it', () => {
    expect(stripeTierToVerificationStatus('L1', 'verified')).toBe('verified')
    expect(stripeTierToVerificationStatus('L2', 'verified')).toBe('verified')
    expect(stripeTierToVerificationStatus(null, 'rejected')).toBe('rejected')
    expect(stripeTierToVerificationStatus(null, 'verification_failed')).toBe('rejected')
    expect(stripeTierToVerificationStatus(null, 'requires_review')).toBe('review')
    expect(stripeTierToVerificationStatus(null, 'pending')).toBe('pending')
    expect(stripeTierToVerificationStatus(null, null)).toBe('pending')
  })
})

describe('recordKycVerification', () => {
  it('inserts one append-only row with the mapped shape', async () => {
    const ok = await recordKycVerification(
      {
        userId: 'user-1',
        provider: 'bridge',
        providerRef: 'cust_1',
        status: 'pending',
        providerStatus: 'incomplete',
        source: 'relay',
      },
      log,
    )
    expect(ok).toBe(true)
    expect(from).toHaveBeenCalledWith('kyc_verifications')
    expect(insert).toHaveBeenCalledWith({
      user_id: 'user-1',
      provider: 'bridge',
      provider_ref: 'cust_1',
      status: 'pending',
      provider_status: 'incomplete',
      tier: null,
      reasons: [],
      source: 'relay',
    })
    expect(log.error).not.toHaveBeenCalled()
  })

  it('caps and sanitizes reasons — labels only, bounded', async () => {
    await recordKycVerification(
      {
        userId: 'user-1',
        provider: 'bridge',
        providerRef: 'cust_1',
        status: 'rejected',
        providerStatus: 'rejected',
        reasons: ['a'.repeat(500), '', ...Array.from({ length: 20 }, (_, i) => `r${i}`)],
        source: 'webhook',
      },
      log,
    )
    const row = insert.mock.calls[0]![0] as { reasons: string[] }
    expect(row.reasons).toHaveLength(10)
    expect(row.reasons[0]).toHaveLength(200)
    expect(row.reasons).not.toContain('')
  })

  it('is best-effort: a DB error logs the code only and returns false', async () => {
    insert.mockResolvedValueOnce({ error: { code: '23514', message: 'row contains 078-05-1120' } })
    const ok = await recordKycVerification(
      {
        userId: 'user-1',
        provider: 'stripe_crypto',
        providerRef: 'crc_1',
        status: 'verified',
        providerStatus: 'verified',
        tier: 'L1',
        source: 'poll',
      },
      log,
    )
    expect(ok).toBe(false)
    expect(log.error).toHaveBeenCalledTimes(1)
    expect(JSON.stringify(log.error.mock.calls[0])).not.toContain('078-05-1120')
    expect(log.error.mock.calls[0]![0]).toEqual({
      userId: 'user-1',
      provider: 'stripe_crypto',
      supabaseError: '23514',
    })
  })

  it('never throws, even when the client does', async () => {
    insert.mockRejectedValueOnce(new Error('socket hang up 078-05-1120'))
    const ok = await recordKycVerification(
      {
        userId: 'user-1',
        provider: 'bridge',
        providerRef: null,
        status: 'pending',
        providerStatus: null,
        source: 'relay',
      },
      log,
    )
    expect(ok).toBe(false)
    expect(JSON.stringify(log.error.mock.calls[0])).not.toContain('078-05-1120')
  })
})
