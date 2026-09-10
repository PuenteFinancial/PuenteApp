'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
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
import { getStripe } from '@/lib/stripe'
import CheckoutIdentityStep from './CheckoutIdentityStep'

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
// IDENTITY COMES FIRST (C3). Bridge makes the payout, so Bridge must hold an
// APPROVED customer before this surface will take a payment — otherwise we
// charge a sender for a payout Bridge may refuse to make, and the undo is a
// refund that costs us the ACH return window. On the crypto rail Stripe
// verified the sender as a side effect of its onramp; here nothing does, so
// CheckoutIdentityStep runs the Bridge leg (terms, DOB + tax ID, its verdict)
// and the Payment Element does not mount until it reports ready.
//
// Mount discipline, same as every other live surface here: the tracker's 5 s
// poll re-renders PayStep, and this subtree is preserved by position and type.
// `options` is memoized and the provider is keyed so a half-filled card form
// is never wiped by a background refresh.
export default function CheckoutPayStep({
  publishableKey,
  clientSecret,
  transferId,
  totalAmountMinor,
  onSubmitted,
  onReload,
}: {
  /** Resolved into a Stripe object HERE, not by PayStep — see the note on the
   *  identity gate below for why the load waits. */
  publishableKey: string
  clientSecret: string
  transferId: string
  /** USD minor units — the pay button restates the total (Money convention). */
  totalAmountMinor: number
  /** confirm() resolved: the payment was SUBMITTED. The webhook drives FUNDED. */
  onSubmitted: () => void
  /** Re-read the funding session — a dead session must re-resolve, not re-mount. */
  onReload: () => void
}) {
  const { t, lang } = useLanguage()
  const s = t.send.track

  // Bumped by the retry affordance. It is part of the provider's key because
  // CheckoutElementsProvider initializes exactly once per instance (an
  // internal initCalledRef): without a remount a provider that failed
  // loadActions() would sit in its error state forever and "retry" would be a
  // button that does nothing.
  const [attempt, setAttempt] = useState(0)

  // Flipped once, by the identity machine, when Bridge holds an approved
  // customer. One-way on purpose: a background /users/me blip must never pull
  // a mounted Payment Element out from under a sender mid-payment, and the
  // machine only reaches `ready` from an approved status in the first place.
  const [identityReady, setIdentityReady] = useState(false)
  const handleReady = useCallback(() => setIdentityReady(true), [])

  // js.stripe.com is fetched only once Bridge has approved the sender: before
  // that they may still be minutes from paying, or about to be rejected and
  // never pay at all. `null` = not resolved yet, and the load is kept
  // loader-first — the provider never renders without a real Stripe object,
  // so a blocked script is the retryable card and never a form that hangs.
  const [stripe, setStripe] = useState<Stripe | null>(null)
  const [stripeFailed, setStripeFailed] = useState(false)

  useEffect(() => {
    if (!identityReady) return
    let cancelled = false
    void (async () => {
      let loaded: Stripe | null = null
      try {
        // Locale rides on the loader: the Checkout SDK options carry no
        // locale field, so this is the only place to set it.
        loaded = await getStripe(publishableKey, lang)
      } catch {
        loaded = null
      }
      if (cancelled) return
      if (!loaded) {
        setStripeFailed(true)
        return
      }
      setStripe(loaded)
    })()
    return () => {
      cancelled = true
    }
    // `lang` is deliberately absent: the locale is fixed at load time, so a
    // mid-payment language switch has nothing to re-do — and re-running this
    // would swap the Stripe object under a mounted Payment Element.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [identityReady, publishableKey, attempt])

  // A fresh object every render would re-run the provider's init effect on
  // every tracker poll. Harmless today (the init is ref-guarded) but this is a
  // live payment surface, so it does not get to depend on that.
  const options = useMemo(() => ({ clientSecret }), [clientSecret])

  const handleRetry = () => {
    setStripeFailed(false)
    // Both halves matter. The remount re-runs the SDK handshake in case the
    // failure was transient; the refetch re-reads the session, so one that is
    // genuinely complete or expired comes back as the submitted panel or the
    // error card instead of a form that can never be confirmed.
    setAttempt((n) => n + 1)
    onReload()
  }

  // The identity leg owns the whole panel until Bridge approves. It renders
  // its own frame and its own error/retry affordances, so there is no pay
  // chrome above it promising a payment that cannot happen yet.
  if (!identityReady) {
    return <CheckoutIdentityStep transferId={transferId} onReady={handleReady} />
  }

  const frame = (children: React.ReactNode) => (
    <div style={{ marginBottom: 14, paddingTop: 14, borderTop: '1px dashed var(--line)' }}>
      {children}
    </div>
  )

  if (stripeFailed) {
    return frame(
      <>
        <p role="alert" style={{ color: 'var(--color-error)', fontSize: 13, margin: '0 0 8px' }}>
          {s.pay.sessionError}
        </p>
        <button type="button" className="btn btn--ghost btn--sm" onClick={handleRetry}>
          {s.retry}
        </button>
      </>,
    )
  }

  if (!stripe) {
    return frame(
      <p style={{ fontSize: 13, color: 'var(--muted)', margin: 0 }}>{s.pay.checkout.loading}</p>,
    )
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
      {/* Link OFF, deliberately (2026-09-10). Left to its default the Element
          renders Link's "save my info" opt-in PRE-CHECKED, which renders a
          phone field, and an empty one makes checkout.confirm refuse with
          "Your phone number is incomplete" — the first thing a real sender
          hit in C5, and a step nobody chose. Nothing about a card or a bank
          debit needs it. Link was also the surface the Checkout PRD exists
          to take off the sender's path. Account-level Link stays whatever
          the Dashboard says; this only stops the Element offering it. */}
      <PaymentElement options={{ wallets: { link: 'never' } }} />
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
