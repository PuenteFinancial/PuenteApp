import { describe, it, expect } from 'vitest'
import {
  isDepositInstructionsShape,
  classifyConfirmPaymentError,
  isFundingSessionShape,
  payAffordanceFor,
} from './payStep'

describe('isFundingSessionShape', () => {
  it('accepts provider-only (mock) and full stripe sessions', () => {
    expect(isFundingSessionShape({ provider: 'mock' })).toBe(true)
    expect(
      isFundingSessionShape({
        provider: 'stripe',
        clientSecret: 'pi_x_secret_y',
        publishableKey: 'pk_test_z',
      }),
    ).toBe(true)
  })

  it('rejects non-objects, missing provider, and wrongly-typed fields', () => {
    expect(isFundingSessionShape(null)).toBe(false)
    expect(isFundingSessionShape(undefined)).toBe(false)
    expect(isFundingSessionShape('stripe')).toBe(false)
    expect(isFundingSessionShape({})).toBe(false)
    expect(isFundingSessionShape({ provider: 42 })).toBe(false)
    expect(isFundingSessionShape({ provider: 'stripe', clientSecret: 7 })).toBe(false)
    expect(isFundingSessionShape({ provider: 'stripe', publishableKey: {} })).toBe(false)
    expect(isFundingSessionShape({ provider: 'stripe', status: 9 })).toBe(false)
  })
})

describe('payAffordanceFor', () => {
  const stripeSession = {
    provider: 'stripe',
    clientSecret: 'pi_x_secret_y',
    publishableKey: 'pk_test_z',
  }

  it('renders the Element for a complete stripe session regardless of canSimulate', () => {
    expect(payAffordanceFor(stripeSession, true)).toBe('stripe')
    expect(payAffordanceFor(stripeSession, false)).toBe('stripe')
  })

  it('renders the Element for every still-payable PI status', () => {
    for (const status of ['requires_payment_method', 'requires_confirmation', 'requires_action']) {
      expect(payAffordanceFor({ ...stripeSession, status }, false)).toBe('stripe')
    }
  })

  it('a PI past confirmation renders submitted, not the pay form — the reload-after-pay case', () => {
    expect(payAffordanceFor({ ...stripeSession, status: 'processing' }, false)).toBe('submitted')
    expect(payAffordanceFor({ ...stripeSession, status: 'succeeded' }, false)).toBe('submitted')
  })

  it('a canceled or unknown PI status is an error — never a payable form for a dead PI', () => {
    expect(payAffordanceFor({ ...stripeSession, status: 'canceled' }, false)).toBe('error')
    expect(payAffordanceFor({ ...stripeSession, status: 'garbage' }, false)).toBe('error')
  })

  it('renders simulate for mock only where the dev button is allowed', () => {
    expect(payAffordanceFor({ provider: 'mock' }, true)).toBe('simulate')
  })

  it('renders nothing for mock in production — the prod mock lock stays inert', () => {
    expect(payAffordanceFor({ provider: 'mock' }, false)).toBe('none')
  })

  it('a stripe session missing either field is an error, not a broken Element mount', () => {
    expect(payAffordanceFor({ provider: 'stripe' }, false)).toBe('error')
    expect(
      payAffordanceFor({ provider: 'stripe', clientSecret: 'pi_x_secret_y' }, false),
    ).toBe('error')
    expect(
      payAffordanceFor({ provider: 'stripe', publishableKey: 'pk_test_z' }, false),
    ).toBe('error')
  })

  it('an unknown provider is an error — never silently nothing on a real send', () => {
    expect(payAffordanceFor({ provider: 'braintree' }, true)).toBe('error')
  })

  it('renders the offline waiting state for manual funding', () => {
    // Not 'none': the sender pays out of band, and a blank panel would read as
    // a broken page on a transfer they are actively trying to pay for.
    expect(payAffordanceFor({ provider: 'manual' }, false)).toBe('offline')
  })

  it('offline never depends on the dev simulate flag', () => {
    // The dev endpoint is off in every environment that uses this processor —
    // if canSimulate ever leaked true, manual must not gain a fake-fund button.
    expect(payAffordanceFor({ provider: 'manual' }, true)).toBe('offline')
  })
})

describe('classifyConfirmPaymentError', () => {
  it('keeps Stripe-authored user errors inline — the Element stays mounted', () => {
    expect(classifyConfirmPaymentError({ type: 'card_error', message: 'Bank refused' })).toBe(
      'inline',
    )
    expect(classifyConfirmPaymentError({ type: 'validation_error' })).toBe('inline')
  })

  it('treats everything else as retryable with Puente generic copy', () => {
    expect(classifyConfirmPaymentError({ type: 'api_error' })).toBe('retryable')
    expect(classifyConfirmPaymentError({ type: 'api_connection_error' })).toBe('retryable')
    expect(classifyConfirmPaymentError({})).toBe('retryable')
    expect(classifyConfirmPaymentError({ type: undefined })).toBe('retryable')
  })
})

describe('isDepositInstructionsShape', () => {
  const FULL = {
    amountMinor: 10000,
    currency: 'USD',
    paymentRail: 'ach',
    bankName: 'Lead Bank',
    bankRoutingNumber: '101019644',
    bankAccountNumber: '215268129123',
    bankBeneficiaryName: 'Bridge Ventures Inc',
    depositMessage: 'BRGABCD1234',
  }

  it('accepts the full set, and without the optional beneficiary', () => {
    expect(isDepositInstructionsShape(FULL)).toBe(true)
    const rest: Partial<typeof FULL> = { ...FULL }
    delete rest.bankBeneficiaryName
    expect(isDepositInstructionsShape(rest)).toBe(true)
  })

  it('rejects a partial or malformed set — a sender must never wire against it', () => {
    expect(isDepositInstructionsShape(undefined)).toBe(false)
    expect(isDepositInstructionsShape({})).toBe(false)
    expect(isDepositInstructionsShape({ ...FULL, depositMessage: '' })).toBe(false)
    expect(isDepositInstructionsShape({ ...FULL, amountMinor: 100.5 })).toBe(false)
    expect(isDepositInstructionsShape({ ...FULL, amountMinor: 0 })).toBe(false)
    const missing: Partial<typeof FULL> = { ...FULL }
    delete missing.bankAccountNumber
    expect(isDepositInstructionsShape(missing)).toBe(false)
  })

  it('a malformed depositInstructions does NOT fail the whole session — render-time fallback', () => {
    expect(
      isFundingSessionShape({ provider: 'manual', depositInstructions: { broken: true } }),
    ).toBe(true)
  })
})
