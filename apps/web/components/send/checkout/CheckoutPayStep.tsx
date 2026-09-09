'use client'

import { useMemo, useState } from 'react'
import posthog from 'posthog-js'
import type { Stripe } from '@stripe/stripe-js'
import {
  CheckoutElementsProvider,
  PaymentElement,
  useCheckoutElements,
} from '@stripe/react-stripe-js/checkout'
import { useLanguage } from '@/components/LanguageProvider'
import { formatUsd } from '@/lib/sendFormat'
import { classifyCheckoutConfirmError } from '@/lib/payStep'

// The Checkout Sessions pay surface (C2 — docs/prds/checkout-sessions-rail.md).
//
// Same shape as the Payment Intents arm inside PayStep, a different SDK in
// front of it: our Payment Element is driven by a Checkout Session instead of
// a PaymentIntent, which is what moves payment-method availability out of
// `payment_method_types` in our code and into the Stripe Dashboard.
//
// Three differences from the PI arm are worth knowing before editing:
//
//   1. THE PROVIDER LOADS ASYNCHRONOUSLY. <Elements> is ready the moment it
//      renders; CheckoutElementsProvider has to call loadActions() first, so
//      useCheckoutElements() reports loading / success / error and this file
//      renders all three. There is no "just mount it" path.
//   2. CONFIRM RETURNS A UNION, not a `{ error? }` bag —
//      { type: 'success', session } | { type: 'error', error } — and the error
//      has no `type` discriminator, so classifyCheckoutConfirmError (not
//      classifyConfirmPaymentError) makes the inline-vs-generic call.
//   3. LOCALE IS FIXED AT loadStripe(), not per mount. PayStep resolves the
//      Stripe object with the sender's language; see lib/stripe.ts.
//
// Mount discipline, same as every other live surface here: the tracker's 5 s
// poll re-renders PayStep, and this subtree is preserved by position and type.
// `options` is memoized and the provider is keyed so a half-filled card form
// is never wiped by a background refresh.
export default function CheckoutPayStep({
  stripe,
  clientSecret,
  transferId,
  totalAmountMinor,
  onSubmitted,
  onReload,
}: {
  /** Already resolved by PayStep — a failed js.stripe.com load never gets here. */
  stripe: Stripe
  clientSecret: string
  transferId: string
  /** USD minor units — the pay button restates the total (Money convention). */
  totalAmountMinor: number
  /** confirm() resolved: the payment was SUBMITTED. The webhook drives FUNDED. */
  onSubmitted: () => void
  /** Re-read the funding session — a dead session must re-resolve, not re-mount. */
  onReload: () => void
}) {
  const { t } = useLanguage()
  const s = t.send.track

  // Bumped by the retry affordance. It is part of the provider's key because
  // CheckoutElementsProvider initializes exactly once per instance (an
  // internal initCalledRef): without a remount a provider that failed
  // loadActions() would sit in its error state forever and "retry" would be a
  // button that does nothing.
  const [attempt, setAttempt] = useState(0)

  // A fresh object every render would re-run the provider's init effect on
  // every tracker poll. Harmless today (the init is ref-guarded) but this is a
  // live payment surface, so it does not get to depend on that.
  const options = useMemo(() => ({ clientSecret }), [clientSecret])

  const handleRetry = () => {
    // Both halves matter. The remount re-runs the SDK handshake in case the
    // failure was transient; the refetch re-reads the session, so one that is
    // genuinely complete or expired comes back as the submitted panel or the
    // error card instead of a form that can never be confirmed.
    setAttempt((n) => n + 1)
    onReload()
  }

  return (
    <div style={{ marginBottom: 14, paddingTop: 14, borderTop: '1px dashed var(--line)' }}>
      <p style={{ fontSize: 14.5, fontWeight: 600, color: 'var(--ink)', margin: '0 0 4px' }}>
        {s.pay.checkout.title}
      </p>
      <p style={{ fontSize: 13, color: 'var(--muted)', margin: '0 0 10px', lineHeight: 1.5 }}>
        {s.pay.checkout.body}
      </p>
      <CheckoutElementsProvider key={`${clientSecret}:${attempt}`} stripe={stripe} options={options}>
        <CheckoutForm
          transferId={transferId}
          totalAmountMinor={totalAmountMinor}
          onSubmitted={onSubmitted}
          onRetry={handleRetry}
        />
      </CheckoutElementsProvider>
    </div>
  )
}

function CheckoutForm({
  transferId,
  totalAmountMinor,
  onSubmitted,
  onRetry,
}: {
  transferId: string
  totalAmountMinor: number
  onSubmitted: () => void
  onRetry: () => void
}) {
  const { t } = useLanguage()
  const s = t.send.track
  const checkoutState = useCheckoutElements()

  const [paying, setPaying] = useState(false)
  // Stripe-authored buyer message (decline, incomplete field) vs Puente
  // generic — see classifyCheckoutConfirmError.
  const [payError, setPayError] = useState('')

  // Hooks are done; branching is safe from here.

  if (checkoutState.type === 'loading') {
    return (
      <p style={{ fontSize: 13, color: 'var(--muted)', margin: 0, lineHeight: 1.5 }}>
        {s.pay.checkout.loading}
      </p>
    )
  }

  if (checkoutState.type === 'error') {
    // The SDK could not load the session's actions — a bad or expired client
    // secret, or a network failure. Never render a Payment Element on top of
    // this: it would collect a card that cannot be confirmed.
    return (
      <div>
        <p role="alert" style={{ color: 'var(--color-error)', fontSize: 13, margin: '0 0 8px' }}>
          {s.pay.sessionError}
        </p>
        <button type="button" className="btn btn--ghost btn--sm" onClick={onRetry}>
          {s.retry}
        </button>
      </div>
    )
  }

  const { checkout } = checkoutState

  const handlePay = async () => {
    setPaying(true)
    setPayError('')
    posthog.capture('send_payment_submitted', { transfer_id: transferId })
    try {
      // 'if_required' keeps the flow on our page for bank debit and most
      // cards; the Session's server-side return_url catches the methods that
      // genuinely have to leave (3DS step-up, redirect wallets), and those
      // never resolve this promise at all.
      const result = await checkout.confirm({ redirect: 'if_required' })
      if (result.type === 'error') {
        // Code only, never the message — a decline message can name the
        // sender's bank or card.
        posthog.capture('send_payment_failed', {
          transfer_id: transferId,
          code: result.error.code ?? 'unknown',
        })
        setPayError(
          classifyCheckoutConfirmError(result.error) === 'inline'
            ? result.error.message
            : s.pay.paymentError,
        )
        return
      }
      // The charge is away. Bank debit is now processing and a card has
      // already settled, but either way OUR transfer advances on
      // checkout.session.completed — so this says "submitted", never "paid".
      onSubmitted()
    } catch {
      posthog.capture('send_payment_failed', { transfer_id: transferId, code: 'network' })
      setPayError(s.pay.paymentError)
    } finally {
      setPaying(false)
    }
  }

  return (
    <div>
      <PaymentElement />
      {/* Instant-only bank verification (locked decision 3): no microdeposit
          fallback, so an unconnectable bank cannot fund a transfer — but on
          this rail cards are enabled, so it is not the end of the road. */}
      <p style={{ fontSize: 12.5, color: 'var(--muted)', margin: '10px 0 0', lineHeight: 1.5 }}>
        {s.pay.checkout.bankNote}
      </p>
      {payError && (
        <p role="alert" style={{ color: 'var(--color-error)', fontSize: 13, margin: '10px 0 0' }}>
          {payError}
        </p>
      )}
      <button
        type="button"
        className="btn btn--accent"
        style={{ marginTop: 12 }}
        disabled={paying}
        onClick={handlePay}
      >
        {paying ? s.pay.paying : s.pay.payNow.replace('{amount}', formatUsd(totalAmountMinor))}
      </button>
    </div>
  )
}
