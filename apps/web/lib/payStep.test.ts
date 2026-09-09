import { describe, it, expect } from 'vitest'
import {
  isDepositInstructionsShape,
  classifyCheckoutConfirmError,
  classifyConfirmPaymentError,
  isFundingSessionShape,
  payAffordanceFor,
  shouldRefetchSession,
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

describe('payAffordanceFor — stripe_onramp (#213)', () => {
  const onrampSession = {
    provider: 'stripe_onramp',
    clientSecret: 'cos_1_secret_x',
    publishableKey: 'pk_test_z',
  }

  it('mounts the widget for a fresh or in-progress session regardless of canSimulate', () => {
    expect(payAffordanceFor(onrampSession, true)).toBe('onramp')
    expect(payAffordanceFor(onrampSession, false)).toBe('onramp')
    expect(payAffordanceFor({ ...onrampSession, status: 'initialized' }, false)).toBe('onramp')
    expect(payAffordanceFor({ ...onrampSession, status: 'requires_payment' }, false)).toBe('onramp')
  })

  it('a session past payment renders submitted, not the widget — the reload-after-pay case', () => {
    expect(payAffordanceFor({ ...onrampSession, status: 'fulfillment_processing' }, false)).toBe(
      'submitted',
    )
    expect(payAffordanceFor({ ...onrampSession, status: 'fulfillment_complete' }, false)).toBe(
      'submitted',
    )
  })

  it('a rejected session is an error — never remount a widget for a dead session', () => {
    expect(payAffordanceFor({ ...onrampSession, status: 'rejected' }, false)).toBe('error')
  })

  it('an unknown future status mounts the widget — it renders its own live state', () => {
    // Deliberately the OPPOSITE of the PI rail's unknown→error: this preview
    // API can grow statuses, and the widget showing the session's truth is
    // safe where a dead PI form is not.
    expect(payAffordanceFor({ ...onrampSession, status: 'some_future_status' }, false)).toBe(
      'onramp',
    )
  })

  it('a session missing either client field is an error, not a hung widget mount', () => {
    expect(payAffordanceFor({ provider: 'stripe_onramp' }, false)).toBe('error')
    expect(
      payAffordanceFor({ provider: 'stripe_onramp', clientSecret: 'cos_1_secret_x' }, false),
    ).toBe('error')
    expect(
      payAffordanceFor({ provider: 'stripe_onramp', publishableKey: 'pk_test_z' }, false),
    ).toBe('error')
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

describe('shouldRefetchSession', () => {
  const INSTRUCTIONS = {
    amountMinor: 10000,
    currency: 'USD',
    paymentRail: 'ach',
    bankName: 'Lead Bank',
    bankRoutingNumber: '101019644',
    bankAccountNumber: '215268129123',
    depositMessage: 'BRGABCD1234',
  }

  it('polls a manual session whose coordinates have not attached yet', () => {
    expect(shouldRefetchSession({ provider: 'manual' })).toBe(true)
  })

  it('polls when the attached object is malformed (renders as fallback copy)', () => {
    expect(shouldRefetchSession({ provider: 'manual', depositInstructions: { broken: true } })).toBe(
      true,
    )
  })

  it('stops once valid coordinates are attached', () => {
    expect(
      shouldRefetchSession({ provider: 'manual', depositInstructions: INSTRUCTIONS }),
    ).toBe(false)
  })

  it('never refetches stripe (a refetch risks remounting a live Payment Element)', () => {
    expect(
      shouldRefetchSession({ provider: 'stripe', clientSecret: 'cs', publishableKey: 'pk' }),
    ).toBe(false)
  })

  it('never refetches mock or a missing session', () => {
    expect(shouldRefetchSession({ provider: 'mock' })).toBe(false)
    expect(shouldRefetchSession(null)).toBe(false)
  })

  it('never refetches stripe_onramp (#213 pin — a refetch risks remounting a live widget mid-KYC)', () => {
    expect(
      shouldRefetchSession({
        provider: 'stripe_onramp',
        clientSecret: 'cos_1_secret_x',
        publishableKey: 'pk_test_z',
      }),
    ).toBe(false)
  })
})

describe('payAffordanceFor — stripe_crypto (K5 embedded rail)', () => {
  it('deferred bootstrap (publishableKey, no clientSecret, no status) → crypto', () => {
    expect(payAffordanceFor({ provider: 'stripe_crypto', publishableKey: 'pk_test_x', walletAddress: '0xabc' }, false)).toBe(
      'crypto',
    )
  })

  it('missing publishableKey → error (the SDK cannot initialize)', () => {
    expect(payAffordanceFor({ provider: 'stripe_crypto' }, false)).toBe('error')
  })

  it('paid statuses on a live session read → submitted, never a second machine', () => {
    for (const status of ['fulfillment_processing', 'fulfillment_complete']) {
      expect(
        payAffordanceFor({ provider: 'stripe_crypto', publishableKey: 'pk_test_x', walletAddress: '0xabc', status }, false),
      ).toBe('submitted')
    }
  })

  it('rejected session → error card (the reconcile poll drives PAYMENT_FAILED)', () => {
    expect(
      payAffordanceFor(
        { provider: 'stripe_crypto', publishableKey: 'pk_test_x', walletAddress: '0xabc', status: 'rejected' },
        false,
      ),
    ).toBe('error')
  })

  it('any other status starts the machine fresh — sessions are never resumed', () => {
    for (const status of ['initialized', 'requires_payment', 'something_new']) {
      expect(
        payAffordanceFor({ provider: 'stripe_crypto', publishableKey: 'pk_test_x', walletAddress: '0xabc', status }, false),
      ).toBe('crypto')
    }
  })

  it('never refetches (the machine owns its own polling)', () => {
    expect(
      shouldRefetchSession({ provider: 'stripe_crypto', publishableKey: 'pk_test_x', walletAddress: '0xabc' }),
    ).toBe(false)
  })
})

describe('payAffordanceFor — stripe_crypto missing the treasury address', () => {
  it('errors rather than starting a machine that cannot create a session', () => {
    // Stripe refuses a headless session for an unregistered wallet
    // (crypto_onramp_consumer_wallet_doesnt_exist, proven live 2026-08-29),
    // so without the address to register there is nothing the flow can do.
    expect(payAffordanceFor({ provider: 'stripe_crypto', publishableKey: 'pk_test_x' }, false)).toBe(
      'error',
    )
  })
})

describe('payAffordanceFor — stripe_checkout (C2 Checkout Sessions rail)', () => {
  const checkoutSession = {
    provider: 'stripe_checkout',
    clientSecret: 'cs_test_x_secret_y',
    publishableKey: 'pk_test_z',
  }

  it('mounts the Payment Element for an open session, regardless of canSimulate', () => {
    expect(payAffordanceFor({ ...checkoutSession, status: 'open' }, true)).toBe('checkout')
    expect(payAffordanceFor({ ...checkoutSession, status: 'open' }, false)).toBe('checkout')
  })

  it('mounts it when the route served no status at all', () => {
    expect(payAffordanceFor(checkoutSession, false)).toBe('checkout')
  })

  it('an open session with unpaid payment_status is still payable — the pre-confirm state', () => {
    expect(
      payAffordanceFor({ ...checkoutSession, status: 'open', paymentStatus: 'unpaid' }, false),
    ).toBe('checkout')
  })

  it('a complete session renders submitted, not the form — the reload-after-pay case', () => {
    expect(
      payAffordanceFor({ ...checkoutSession, status: 'complete', paymentStatus: 'unpaid' }, false),
    ).toBe('submitted')
    expect(
      payAffordanceFor({ ...checkoutSession, status: 'complete', paymentStatus: 'paid' }, false),
    ).toBe('submitted')
  })

  it('a SETTLED payment is submitted even if the session still reads open — never charge twice', () => {
    // The money check runs before the status check on purpose: `paid` is the
    // one signal that a second confirm would take the sender's money again.
    expect(
      payAffordanceFor({ ...checkoutSession, status: 'open', paymentStatus: 'paid' }, false),
    ).toBe('submitted')
    expect(
      payAffordanceFor(
        { ...checkoutSession, status: 'open', paymentStatus: 'no_payment_required' },
        false,
      ),
    ).toBe('submitted')
  })

  it('an expired session is an error — confirm can no longer succeed against it', () => {
    expect(payAffordanceFor({ ...checkoutSession, status: 'expired' }, false)).toBe('error')
  })

  it('an unrecognized status is an error — this surface can actually take money', () => {
    expect(payAffordanceFor({ ...checkoutSession, status: 'garbage' }, false)).toBe('error')
  })

  it('a session missing either client field is an error, not a dead Element mount', () => {
    expect(payAffordanceFor({ provider: 'stripe_checkout' }, false)).toBe('error')
    expect(
      payAffordanceFor({ provider: 'stripe_checkout', clientSecret: 'cs_test_x' }, false),
    ).toBe('error')
    expect(
      payAffordanceFor({ provider: 'stripe_checkout', publishableKey: 'pk_test_z' }, false),
    ).toBe('error')
  })

  it('never refetches (a refetch would remount a live Payment Element)', () => {
    expect(shouldRefetchSession({ ...checkoutSession, status: 'open' })).toBe(false)
  })

  it('paymentStatus survives the shape check, and a wrongly-typed one does not', () => {
    expect(isFundingSessionShape({ ...checkoutSession, paymentStatus: 'unpaid' })).toBe(true)
    expect(isFundingSessionShape({ ...checkoutSession, paymentStatus: 3 })).toBe(false)
  })
})

describe('classifyCheckoutConfirmError', () => {
  it('renders a Stripe-authored buyer message inline — every arm of the union is buyer-facing', () => {
    expect(
      classifyCheckoutConfirmError({
        message: 'Your card was declined.',
        code: 'paymentFailed',
      }),
    ).toBe('inline')
    // code: null is Stripe's AnyBuyerError — still written for the buyer.
    expect(classifyCheckoutConfirmError({ message: 'Enter a valid ZIP.', code: null })).toBe(
      'inline',
    )
  })

  it('falls back to Puente copy when no message actually arrived', () => {
    expect(classifyCheckoutConfirmError({ code: 'paymentFailed' })).toBe('retryable')
    expect(classifyCheckoutConfirmError({ message: '', code: null })).toBe('retryable')
    expect(classifyCheckoutConfirmError({ message: '   ', code: null })).toBe('retryable')
  })
})
