import { describe, it, expect, vi, beforeEach } from 'vitest'

// Audit 2026-09-02 corner 1: the row says which rail funded it; the process
// value is only the fallback for rows stamped before the column existed.

const envMock = vi.hoisted(() => ({
  FUNDING_PROCESSOR: 'mock' as string,
  STRIPE_SECRET_KEY: undefined as string | undefined,
  STRIPE_WEBHOOK_SECRET: undefined as string | undefined,
  STRIPE_PUBLISHABLE_KEY: undefined as string | undefined,
  MOCK_FUNDING_WEBHOOK_SECRET: 'x',
  // Read by pendingFundingWindowMs for every interactive pay step (C4).
  ONRAMP_PENDING_MAX_AGE_HOURS: 4,
  MANUAL_PENDING_MAX_AGE_DAYS: 7,
}))
vi.mock('../../config/env.js', () => ({ env: envMock }))

const captureMessage = vi.hoisted(() => vi.fn())
const setFingerprint = vi.hoisted(() => vi.fn())
vi.mock('@sentry/node', () => ({
  withScope: (fn: (scope: unknown) => void) => fn({ setFingerprint, setContext: vi.fn() }),
  captureMessage: (...args: unknown[]) => captureMessage(...args),
  captureException: vi.fn(),
}))

const {
  currentIdentityFlow,
  getFundingProcessor,
  identityFlowFor,
  pendingFundingWindowMs,
  pendingReaperDeadAfterMs,
  processorFor,
  processorNameFor,
} = await import('./index.js')

beforeEach(() => {
  envMock.FUNDING_PROCESSOR = 'mock'
})

describe('processorNameFor', () => {
  it('prefers the row, falls back to the process for a null or missing stamp', () => {
    expect(processorNameFor({ funding_processor: 'manual' })).toBe('manual')
    expect(processorNameFor({ funding_processor: null })).toBe('mock')
    expect(processorNameFor({})).toBe('mock')
    envMock.FUNDING_PROCESSOR = 'stripe_crypto'
    expect(processorNameFor({ funding_processor: null })).toBe('stripe_crypto')
  })
})

describe('processorFor', () => {
  it('returns the memoized process instance when the row matches the process rail', () => {
    const viaProcess = getFundingProcessor()
    expect(processorFor({ funding_processor: 'mock' })).toBe(viaProcess)
    expect(processorFor({ funding_processor: null })).toBe(viaProcess)
  })

  it('builds (and memoizes) a different rail for a row stamped under it', () => {
    const manual = processorFor({ funding_processor: 'manual' })
    expect(manual.provider).toBe('manual')
    expect(manual).not.toBe(getFundingProcessor())
    expect(processorFor({ funding_processor: 'manual' })).toBe(manual)
  })

  it('never throws on an unknown stamp — the column has no CHECK — falls back, and pages', () => {
    expect(processorFor({ funding_processor: 'not_a_rail' })).toBe(getFundingProcessor())
    expect(setFingerprint).toHaveBeenCalledWith(['funding-processor-unknown', 'not_a_rail'])
    expect(captureMessage).toHaveBeenCalledTimes(1)
  })

  it('does not page for a known rail or a null stamp', () => {
    captureMessage.mockClear()
    processorFor({ funding_processor: 'manual' })
    processorFor({ funding_processor: null })
    expect(captureMessage).not.toHaveBeenCalled()
  })
})

// ── C4: who verifies the sender, and when ──────────────────────────────────

describe('identityFlow', () => {
  it('every real processor DECLARES the same flow the rail map reports', async () => {
    // The two exist for different reasons — the instance answers for the
    // SELECTED rail, the map answers for a persisted row whose rail may no
    // longer be selected — so they have to agree, or a row silently changes
    // meaning when FUNDING_PROCESSOR flips.
    //
    // Constructed directly rather than through getFundingProcessor, which
    // memoizes one instance for the life of the process and so cannot be
    // walked across rails in a loop.
    // The Stripe constructors refuse to build without a key (they guard direct
    // construction); only the flag is under test, so a fake key is enough.
    envMock.STRIPE_SECRET_KEY = 'sk_test_x'
    envMock.STRIPE_WEBHOOK_SECRET = 'whsec_x'
    envMock.STRIPE_PUBLISHABLE_KEY = 'pk_test_x'
    const [mock, stripe, manual, onramp, crypto, checkout] = await Promise.all([
      import('./mock.js'),
      import('./stripe.js'),
      import('./manual.js'),
      import('./stripe-onramp.js'),
      import('./stripe-crypto.js'),
      import('./stripe-checkout.js'),
    ])
    const built = {
      mock: new mock.MockFundingProcessor(),
      stripe: new stripe.StripeFundingProcessor(),
      manual: new manual.ManualFundingProcessor(),
      stripe_onramp: new onramp.StripeOnrampFundingProcessor(),
      stripe_crypto: new crypto.StripeCryptoFundingProcessor(),
      stripe_checkout: new checkout.StripeCheckoutFundingProcessor(),
    }
    for (const [rail, processor] of Object.entries(built)) {
      expect(processor.provider, rail).toBe(rail)
      expect(processor.identityFlow, rail).toBe(identityFlowFor(rail))
    }
  })

  it('only the two K-lane rails verify inside the send; everything else needs a pre-approved sender', () => {
    expect(identityFlowFor('stripe_crypto')).toBe('provider_then_bridge')
    expect(identityFlowFor('stripe_checkout')).toBe('bridge_only')
    for (const rail of ['mock', 'manual', 'stripe', 'stripe_onramp']) {
      expect(identityFlowFor(rail), rail).toBe('none')
    }
  })

  it('an unknown rail is none — the STRICT answer, never the open one', () => {
    // The direction of this fallback is the safety property: 'none' refuses
    // a sender who is not already approved; any other value lets them start
    // a send on the promise that something downstream will verify them.
    expect(identityFlowFor('some_future_rail')).toBe('none')
    expect(identityFlowFor('')).toBe('none')
  })

  it('currentIdentityFlow falls back to none when a processor omits the field', () => {
    // A test double or a hand-rolled adapter must not get the permissive send
    // gate by omission — this is how the C4 test failures surfaced.
    envMock.FUNDING_PROCESSOR = 'mock'
    expect(currentIdentityFlow()).toBe('none')
  })
})

describe('the abandonment clock covers the Checkout rail (C4)', () => {
  const row = (rail: string) => ({ funding_processor: rail })

  it('gives it hours, not the 30-minute webhook rule', () => {
    // C3 put a Bridge identity leg in front of payment — hosted terms, DOB and
    // tax ID, then a verdict that can go to manual review and tell the sender
    // to come back later. At 31 minutes that sender is mid-flow, not gone, and
    // reaping them kills a transfer for doing what the page asked.
    expect(pendingFundingWindowMs(row('stripe_checkout'))).toBeGreaterThan(
      pendingFundingWindowMs(row('stripe')),
    )
    expect(pendingFundingWindowMs(row('stripe_checkout'))).toBe(
      pendingFundingWindowMs(row('stripe_crypto')),
    )
  })

  it('and the reaper-dead alert moves with it — the #242 drift, which was this exact pair', () => {
    expect(pendingReaperDeadAfterMs(row('stripe_checkout'))).toBe(
      pendingReaperDeadAfterMs(row('stripe_crypto')),
    )
  })
})
