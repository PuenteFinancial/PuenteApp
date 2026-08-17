import { describe, it, expect } from 'vitest'
import { env } from '../../config/env.js'
import { undoModeForRef } from './index.js'
import { ManualFundingProcessor } from './manual.js'

// Instantiated directly rather than through getFundingProcessor(): the factory
// memoizes on FUNDING_PROCESSOR, which the suite pins to 'mock'.
const processor = new ManualFundingProcessor()

function withAllowlist<T>(ids: string[], fn: () => T): T {
  const saved = env.OPS_ADMIN_USER_IDS
  env.OPS_ADMIN_USER_IDS = new Set(ids)
  try {
    return fn()
  } finally {
    env.OPS_ADMIN_USER_IDS = saved
  }
}

describe('manual processor identity', () => {
  it('declares the manual provider', () => {
    expect(processor.provider).toBe('manual')
  })
})

describe('manual isConfigured — the ops allowlist IS the gate', () => {
  it('is not configured while the ops allowlist is empty', () => {
    withAllowlist([], () => {
      expect(processor.isConfigured()).toBe(false)
    })
  })

  it('is configured once at least one operator is allowlisted', () => {
    withAllowlist(['11111111-1111-4111-8111-111111111111'], () => {
      expect(processor.isConfigured()).toBe(true)
    })
  })
})

describe('manual funding never arrives by webhook', () => {
  // The load-bearing claim: with no shared secret, the ONLY route to FUNDED is
  // the allowlisted ops action. If verifySignature ever returned true, an
  // unauthenticated public endpoint would become a funding path.
  it('refuses every signature', () => {
    expect(processor.verifySignature()).toBe(false)
  })

  it('classifies any payload as malformed rather than throwing', () => {
    expect(processor.parseEvent()).toEqual({ outcome: 'malformed' })
  })
})

describe('manual initiateFunding', () => {
  it('mints a manualpay_ ref with no client fields and no network call', async () => {
    const initiation = await processor.initiateFunding()
    expect(initiation.provider).toBe('manual')
    expect(initiation.method).toBe('ach')
    expect(initiation.paymentRef).toMatch(/^manualpay_[0-9a-f-]{36}$/)
    expect(initiation.clientFields).toEqual({})
  })

  it('returns no fields for the pay-step client session', async () => {
    expect(await processor.getClientSession()).toEqual({ provider: 'manual', fields: {} })
  })
})

describe('manual undo ops never claim the money moved', () => {
  // Manual funds are COLLECTED before the transfer is marked funded, so there is
  // no uncleared pull to cancel. Reporting 'succeeded' here would book a
  // disbursement that never happened and tell the sender they were made whole.
  it.each(['voidFunding', 'refund'] as const)('%s resolves pending, not succeeded', async (op) => {
    const undo = await processor[op]()
    expect(undo.status).toBe('pending')
    expect(undo.status).not.toBe('succeeded')
  })

  it.each(['voidFunding', 'refund'] as const)('%s books the refunded arm', async (op) => {
    const undo = await processor[op]()
    expect(undo.mode).toBe('refunded')
    expect(undo.ref).toMatch(/^manualrefund_[0-9a-f-]{36}$/)
  })

  it('mints a distinct ref per call', async () => {
    const [a, b] = await Promise.all([processor.refund(), processor.refund()])
    expect(a.ref).not.toBe(b.ref)
  })

  it('agrees with undoModeForRef, which the crash-recovery paths read instead', async () => {
    // The ref namespace is the durable encoding of `mode` — the replay paths
    // reach REFUNDED holding nothing but transfers.refund_payment_ref, and the
    // ledger batch they post depends on getting this right.
    const undo = await processor.refund()
    expect(undoModeForRef(undo.ref)).toBe(undo.mode)
  })
})
