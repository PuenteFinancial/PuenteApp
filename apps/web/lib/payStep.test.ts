import { describe, it, expect } from 'vitest'
import {
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
