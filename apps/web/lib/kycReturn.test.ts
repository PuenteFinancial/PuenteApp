import { describe, it, expect } from 'vitest'
import { resolveKycReturnPath, validKycLocale, validKycNext } from './kycReturn'

const TRANSFER_PATH = '/dashboard/send/aaaaaaaa-1111-4222-8333-444444444444'

describe('resolveKycReturnPath', () => {
  it('lands back on the transfer page for approved and pending alike', () => {
    expect(resolveKycReturnPath(TRANSFER_PATH, 'approved')).toBe(TRANSFER_PATH)
    expect(resolveKycReturnPath(TRANSFER_PATH, 'pending')).toBe(TRANSFER_PATH)
    expect(resolveKycReturnPath(TRANSFER_PATH, 'under_review')).toBe(TRANSFER_PATH)
    expect(resolveKycReturnPath(TRANSFER_PATH, 'not_started')).toBe(TRANSFER_PATH)
  })

  it('a valid next wins even for rejected — the pay-step machine owns the rejection branch (K6)', () => {
    // K5 diverted rejected senders to /onboarding/rejected, whose retry leads
    // back into onboarding rather than the transfer. The machine's
    // bridge_rejection → Persona offer is the send-flow answer.
    expect(resolveKycReturnPath(TRANSFER_PATH, 'rejected')).toBe(TRANSFER_PATH)
  })

  it('no cookie → the pre-K5 onboarding routing', () => {
    expect(resolveKycReturnPath(undefined, 'approved')).toBe('/dashboard')
    expect(resolveKycReturnPath(undefined, 'rejected')).toBe('/onboarding/rejected')
    expect(resolveKycReturnPath(undefined, 'pending')).toBe('/onboarding/pending')
  })

  it('open-redirect guard: anything but a strict transfer path is ignored', () => {
    for (const evil of [
      'https://evil.example/phish',
      '//evil.example',
      '/dashboard/send/../../admin',
      '/dashboard/send/not-a-uuid',
      '/dashboard/send/aaaaaaaa-1111-4222-8333-444444444444/receipt',
      '/dashboard/ops',
      '',
    ]) {
      expect(resolveKycReturnPath(evil, 'approved')).toBe('/dashboard')
      expect(validKycNext(evil)).toBeNull()
    }
    expect(validKycNext(TRANSFER_PATH)).toBe(TRANSFER_PATH)
  })
})

describe('validKycLocale', () => {
  it('accepts exactly the two UI languages and defaults to en', () => {
    expect(validKycLocale('es')).toBe('es')
    expect(validKycLocale('en')).toBe('en')
    expect(validKycLocale('fr')).toBe('en')
    expect(validKycLocale('')).toBe('en')
    expect(validKycLocale(undefined)).toBe('en')
  })
})
