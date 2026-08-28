'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { useRouter } from 'next/navigation'
import posthog from 'posthog-js'
import type { Stripe } from '@stripe/stripe-js'
import type { OnrampCoordinator, StripeOnramp } from '@stripe/crypto'
import { Elements, PaymentElement, useElements, useStripe } from '@stripe/react-stripe-js'
import { useLanguage } from '@/components/LanguageProvider'
import { parseApiError, errorMessage } from '@/lib/apiError'
import { formatUsd } from '@/lib/sendFormat'
import {
  classifyConfirmPaymentError,
  isDepositInstructionsShape,
  isFundingSessionShape,
  payAffordanceFor,
  shouldRefetchSession,
  type FundingSession,
} from '@/lib/payStep'
import { getStripe } from '@/lib/stripe'
import { getStripeOnramp } from '@/lib/stripeOnramp'
import { getCryptoOnramp } from '@/lib/cryptoOnramp'
import CryptoPayStep from '@/components/send/crypto/CryptoPayStep'

// The whole PENDING_PAYMENT affordance: fetches the funding session once, then
// renders the Payment Element (stripe), the dev simulate button (mock, non-prod),
// or nothing (mock in prod — the inert lock, today's behavior).
//
// Poll interplay (TransferTracker's 5 s refresh): FUNDED only lands via the
// payment_intent.processing webhook, which in practice arrives after
// confirmPayment resolves — and even if the poll won that race, unmounting the
// Element for a payment that already succeeded is self-consistent. The
// session is fetched once into state and getStripe() memoizes the loader, so
// poll-driven re-renders never remount the Element. The one real race — the
// 30-min reconcile-pending auto-fail flipping the transfer to PAYMENT_FAILED
// with the form open — resolves correctly: the tracker swaps in the existing
// paymentFailed outcome banner.
export default function PayStep({
  transferId,
  totalAmountMinor,
  canSimulate,
  paymentClaimedAt,
  onAdvanced,
}: {
  transferId: string
  /** USD minor units — the pay button restates the total (Money convention: integer minor). */
  totalAmountMinor: number
  /** Non-production only — same prop the simulate button always keyed on. */
  canSimulate: boolean
  /** Set once the sender claimed they paid (slice 4) — swaps the claim button for the claimed copy. */
  paymentClaimedAt: string | null
  /** The tracker's refresh — called after any action that may advance state. */
  onAdvanced: () => Promise<void>
}) {
  const { t, lang } = useLanguage()
  const s = t.send.track
  const router = useRouter()

  const [session, setSession] = useState<FundingSession | null>(null)
  const [sessionError, setSessionError] = useState(false)
  const [stripe, setStripe] = useState<Stripe | null>(null)
  const [onramp, setOnramp] = useState<StripeOnramp | null>(null)
  // Embedded rail (K5): the coordinator is created once per publishable key
  // and handed to CryptoPayStep — same memoized-loader discipline as the
  // other two SDKs.
  const [cryptoCoordinator, setCryptoCoordinator] = useState<OnrampCoordinator | null>(null)
  // The onramp widget reported `rejected` (#213): the session is dead and the
  // webhook is driving PAYMENT_FAILED — hold an error line until the
  // tracker's banner takes over. Local for the same reason `submitted` is.
  const [onrampRejected, setOnrampRejected] = useState(false)
  const [submitted, setSubmitted] = useState(false)
  const [simulating, setSimulating] = useState(false)
  const [simulateError, setSimulateError] = useState('')
  const [claiming, setClaiming] = useState(false)
  // Local mirror of the prop: the claimed copy must swap in the instant the
  // POST lands, not a poll later — same reason `submitted` exists.
  const [claimed, setClaimed] = useState(false)
  const [claimError, setClaimError] = useState('')

  const fetching = useRef(false)

  // `quiet` = a background refetch (the pending-instructions poll below): a
  // transient failure must leave the current panel alone — flipping visible
  // content to the error card because one poll blipped would read as a crash.
  const loadSession = useCallback(async (quiet = false) => {
    if (fetching.current) return
    fetching.current = true
    if (!quiet) setSessionError(false)
    try {
      const res = await fetch(`/api/transfers/${transferId}/funding-session`, {
        cache: 'no-store',
      })
      if (res.status === 401) {
        router.replace('/continue')
        return
      }
      const body: unknown = await res.json().catch(() => null)
      if (!res.ok || !isFundingSessionShape(body)) {
        if (!quiet) setSessionError(true)
        return
      }
      if (body.provider === 'stripe' && body.clientSecret && body.publishableKey) {
        // Resolve the loader BEFORE rendering <Elements> — a blocked/failed
        // js.stripe.com load surfaces as the retryable error card, not a
        // permanently-pending form.
        let loaded: Stripe | null = null
        try {
          loaded = await getStripe(body.publishableKey)
        } catch {
          loaded = null
        }
        if (!loaded) {
          setSessionError(true)
          return
        }
        setStripe(loaded)
        posthog.capture('send_payment_opened', { transfer_id: transferId })
      }
      if (body.provider === 'stripe_onramp' && body.clientSecret && body.publishableKey) {
        // Same loader-first contract for the onramp SDK: a blocked
        // crypto-js.stripe.com load is the retryable error card, never a
        // widget container that hangs empty.
        let loaded: StripeOnramp | null = null
        try {
          loaded = await getStripeOnramp(body.publishableKey)
        } catch {
          loaded = null
        }
        if (!loaded) {
          setSessionError(true)
          return
        }
        setOnramp(loaded)
        posthog.capture('send_payment_opened', { transfer_id: transferId })
      }
      if (body.provider === 'stripe_crypto' && body.publishableKey) {
        // Loader-first contract, embedded-components edition: a blocked
        // js.stripe.com load is the retryable error card, never a machine
        // that hangs on its first SDK call.
        let loaded: OnrampCoordinator | null = null
        try {
          loaded = await getCryptoOnramp(body.publishableKey)
        } catch {
          loaded = null
        }
        if (!loaded) {
          setSessionError(true)
          return
        }
        setCryptoCoordinator(loaded)
        // Both names on purpose: send_payment_opened keeps the cross-rail
        // dashboards whole; send_crypto_pay_opened opens the K5 funnel.
        posthog.capture('send_payment_opened', { transfer_id: transferId })
        posthog.capture('send_crypto_pay_opened', { transfer_id: transferId })
      }
      setSession(body)
    } catch {
      if (!quiet) setSessionError(true)
    } finally {
      fetching.current = false
    }
  }, [transferId, router])

  useEffect(() => {
    void loadSession()
  }, [loadSession])

  // Manual rail: the auto-onramp attaches coordinates seconds AFTER confirm,
  // so the mount-time fetch races the worker and can lose — without this the
  // sender never sees the coordinates short of a full reload (found live
  // 2026-08-21). Poll quietly until they attach; shouldRefetchSession is
  // false for stripe, so a live Payment Element is never refetched.
  useEffect(() => {
    if (!shouldRefetchSession(session)) return
    const timer = setInterval(() => void loadSession(true), 5000)
    return () => clearInterval(timer)
  }, [session, loadSession])

  // Moved verbatim from TransferTracker (PR-S3) — the dev-only mock advance.
  const handleSimulate = async () => {
    setSimulating(true)
    setSimulateError('')
    try {
      const res = await fetch(`/api/dev/transfers/${transferId}/simulate-funding`, {
        method: 'POST',
      })
      if (!res.ok) {
        const body = await res.json().catch(() => ({}))
        setSimulateError(errorMessage(parseApiError(body)?.code, t.send.errors))
        return
      }
      posthog.capture('send_funding_simulated', { transfer_id: transferId })
      // Await so the button stays "Simulating…" until the tracker adopts the
      // new state — else it re-enables on an already-FUNDED transfer and a
      // second click paints an error under a send that succeeded.
      await onAdvanced()
    } catch {
      setSimulateError(t.send.errors.generic)
    } finally {
      setSimulating(false)
    }
  }

  // Sender payment claim (funding-ops slice 4) — simulate-arm mechanics: busy
  // state, POST, capture, then hold on the tracker's refresh. A set-once
  // signal; the API replays the original timestamp on a double tap.
  const handleClaim = async () => {
    setClaiming(true)
    setClaimError('')
    try {
      const res = await fetch(`/api/transfers/${transferId}/payment-claim`, {
        method: 'POST',
      })
      if (!res.ok) {
        // A 409 means the transfer moved on — the tracker's refresh replaces
        // this panel anyway; every failure renders the same retryable line.
        setClaimError(s.pay.claim.error)
        void onAdvanced()
        return
      }
      posthog.capture('send_payment_claimed', { transfer_id: transferId })
      setClaimed(true)
      // Await so the button stays busy until the tracker adopts the claimed
      // transfer — mirrors handleSimulate's reasoning.
      await onAdvanced()
    } catch {
      setClaimError(s.pay.claim.error)
    } finally {
      setClaiming(false)
    }
  }

  if (sessionError) {
    return (
      <div style={{ marginBottom: 14, paddingTop: 14, borderTop: '1px dashed var(--line)' }}>
        <p role="alert" style={{ color: 'var(--color-error)', fontSize: 13, margin: '0 0 8px' }}>
          {s.pay.sessionError}
        </p>
        <button type="button" className="btn btn--ghost btn--sm" onClick={() => void loadSession()}>
          {s.retry}
        </button>
      </div>
    )
  }

  if (!session) return null // first fetch in flight — the tracker renders around it

  const affordance = payAffordanceFor(session, canSimulate)

  // Local `submitted` covers the moment after confirmPayment in THIS mount;
  // affordance 'submitted' covers a reload/second tab after paying (live PI
  // status is processing/succeeded while the transfer waits on the webhook).
  if (submitted || affordance === 'submitted') {
    return (
      <div style={{ marginBottom: 14, paddingTop: 14, borderTop: '1px dashed var(--line)' }}>
        <p style={{ fontSize: 14.5, fontWeight: 600, color: 'var(--ink)', margin: '0 0 4px' }}>
          {s.pay.submittedTitle}
        </p>
        <p style={{ fontSize: 13, color: 'var(--muted)', margin: 0, lineHeight: 1.5 }}>
          {s.pay.submittedBody}
        </p>
      </div>
    )
  }

  // Out-of-band funding: nothing to click, but the sender must see that we are
  // waiting on their deposit rather than a blank panel that reads as a broken
  // page. With attached coordinates (#199) the panel renders them verbatim —
  // the reference code is what ties the deposit to this transfer at our
  // partner. Without them (or with a malformed object), the fallback copy
  // points at the out-of-band hand-off, same as before.
  if (affordance === 'offline') {
    const instructions = isDepositInstructionsShape(session.depositInstructions)
      ? session.depositInstructions
      : null
    const rowStyle = {
      display: 'flex',
      justifyContent: 'space-between',
      gap: 12,
      fontSize: 13.5,
    } as const
    const valStyle = { fontFamily: 'var(--mono)', color: 'var(--ink)', textAlign: 'right' } as const
    return (
      <div style={{ marginBottom: 14, paddingTop: 14, borderTop: '1px dashed var(--line)' }}>
        <p style={{ fontSize: 14.5, fontWeight: 600, color: 'var(--ink)', margin: '0 0 4px' }}>
          {s.pay.offlineTitle}
        </p>
        {instructions ? (
          <>
            <p style={{ fontSize: 13, color: 'var(--muted)', margin: '0 0 10px', lineHeight: 1.5 }}>
              {s.pay.offlineInstructions.lead}
            </p>
            <div
              style={{
                display: 'flex',
                flexDirection: 'column',
                gap: 6,
                padding: '11px 13px',
                borderRadius: 'var(--r-sm)',
                background: 'var(--surface-2)',
                border: '1px solid var(--line-2)',
                marginBottom: 10,
              }}
            >
              <div style={rowStyle}>
                <span style={{ color: 'var(--muted)' }}>{s.pay.offlineInstructions.amount}</span>
                <b style={valStyle}>{formatUsd(instructions.amountMinor)}</b>
              </div>
              <div style={rowStyle}>
                <span style={{ color: 'var(--muted)' }}>{s.pay.offlineInstructions.bank}</span>
                <b style={valStyle}>{instructions.bankName}</b>
              </div>
              {instructions.bankBeneficiaryName && (
                <div style={rowStyle}>
                  <span style={{ color: 'var(--muted)' }}>{s.pay.offlineInstructions.beneficiary}</span>
                  <b style={valStyle}>{instructions.bankBeneficiaryName}</b>
                </div>
              )}
              <div style={rowStyle}>
                <span style={{ color: 'var(--muted)' }}>{s.pay.offlineInstructions.routing}</span>
                <b style={valStyle}>{instructions.bankRoutingNumber}</b>
              </div>
              <div style={rowStyle}>
                <span style={{ color: 'var(--muted)' }}>{s.pay.offlineInstructions.account}</span>
                <b style={valStyle}>{instructions.bankAccountNumber}</b>
              </div>
              <div style={rowStyle}>
                <span style={{ color: 'var(--muted)' }}>{s.pay.offlineInstructions.reference}</span>
                <b style={valStyle}>{instructions.depositMessage}</b>
              </div>
            </div>
            <p style={{ fontSize: 12.5, color: 'var(--ink)', margin: 0, lineHeight: 1.5 }}>
              {s.pay.offlineInstructions.referenceWarning}
            </p>
          </>
        ) : (
          <p style={{ fontSize: 13, color: 'var(--muted)', margin: 0, lineHeight: 1.5 }}>
            {s.pay.offlineBody}
          </p>
        )}
        {/* Sender payment claim (slice 4): once claimed — this mount or any
            prior one — the confirmation copy replaces the button. The copy
            deliberately promises verification, never release timing. */}
        {claimed || paymentClaimedAt != null ? (
          <div style={{ marginTop: 12 }}>
            <p style={{ fontSize: 14, fontWeight: 600, color: 'var(--ink)', margin: '0 0 4px' }}>
              {s.pay.claim.claimedTitle}
            </p>
            <p style={{ fontSize: 13, color: 'var(--muted)', margin: 0, lineHeight: 1.5 }}>
              {s.pay.claim.claimedBody}
            </p>
          </div>
        ) : (
          <div style={{ marginTop: 12 }}>
            <button
              type="button"
              className="btn btn--accent btn--sm"
              disabled={claiming}
              onClick={handleClaim}
            >
              {claiming ? s.pay.claim.claiming : s.pay.claim.button}
            </button>
            {claimError && (
              <p role="alert" style={{ color: 'var(--color-error)', fontSize: 13, margin: '8px 0 0' }}>
                {claimError}
              </p>
            )}
          </div>
        )}
      </div>
    )
  }

  // Embedded rail (K5): the machine owns everything from Link auth to
  // checkout; this component only guarantees the coordinator exists. The
  // subtree is preserved across the tracker's 5s poll re-renders (same type,
  // same position, no key), so live SDK surfaces never remount.
  if (affordance === 'crypto') {
    if (!cryptoCoordinator) {
      return (
        <div style={{ marginBottom: 14, paddingTop: 14, borderTop: '1px dashed var(--line)' }}>
          <p role="alert" style={{ color: 'var(--color-error)', fontSize: 13, margin: '0 0 8px' }}>
            {s.pay.sessionError}
          </p>
          <button type="button" className="btn btn--ghost btn--sm" onClick={() => void loadSession()}>
            {s.retry}
          </button>
        </div>
      )
    }
    return (
      <CryptoPayStep
        coordinator={cryptoCoordinator}
        transferId={transferId}
        onAdvanced={onAdvanced}
      />
    )
  }

  if (affordance === 'none') return null

  if (affordance === 'error') {
    // A stripe session missing its fields (or an unknown provider) must not
    // silently render nothing — the sender would have no way to pay.
    return (
      <div style={{ marginBottom: 14, paddingTop: 14, borderTop: '1px dashed var(--line)' }}>
        <p role="alert" style={{ color: 'var(--color-error)', fontSize: 13, margin: '0 0 8px' }}>
          {s.pay.sessionError}
        </p>
        <button type="button" className="btn btn--ghost btn--sm" onClick={() => void loadSession()}>
          {s.retry}
        </button>
      </div>
    )
  }

  // Onramp widget (#213): Stripe's embedded UI owns identity + payment; our
  // chrome is just the heading and expectation-setting copy (fees + ID check).
  // The widget mounts once per (onramp, clientSecret) — the tracker's 5 s
  // poll re-renders this component and must never remount a live widget
  // mid-KYC, so OnrampWidget keeps its handlers in a ref instead of effect
  // deps. A rejected session renders the error line until the tracker's
  // PAYMENT_FAILED banner takes over (the webhook is already driving it).
  if (affordance === 'onramp') {
    return (
      <div style={{ marginBottom: 14, paddingTop: 14, borderTop: '1px dashed var(--line)' }}>
        <p style={{ fontSize: 14.5, fontWeight: 600, color: 'var(--ink)', margin: '0 0 4px' }}>
          {s.pay.onrampTitle}
        </p>
        <p style={{ fontSize: 13, color: 'var(--muted)', margin: '0 0 10px', lineHeight: 1.5 }}>
          {s.pay.onrampBody}
        </p>
        {onrampRejected ? (
          <p role="alert" style={{ color: 'var(--color-error)', fontSize: 13, margin: 0 }}>
            {s.pay.paymentError}
          </p>
        ) : (
          onramp && (
            <OnrampWidget
              onramp={onramp}
              clientSecret={session.clientSecret!}
              onPaid={() => {
                // ≥ fulfillment_processing: the sender completed payment in
                // the widget. Same contract as confirmPayment resolving —
                // "submitted", never "paid"; the webhook drives FUNDED.
                posthog.capture('send_payment_submitted', { transfer_id: transferId })
                setSubmitted(true)
                void onAdvanced()
              }}
              onRejected={() => {
                // Code only, never a message — rejection detail stays with
                // Stripe (KYC/sanctions), and our transfer is headed to
                // PAYMENT_FAILED via the webhook.
                posthog.capture('send_payment_failed', {
                  transfer_id: transferId,
                  code: 'onramp_rejected',
                })
                setOnrampRejected(true)
                void onAdvanced()
              }}
            />
          )
        )}
      </div>
    )
  }

  if (affordance === 'simulate') {
    return (
      <div style={{ marginBottom: 14, paddingTop: 14, borderTop: '1px dashed var(--line)' }}>
        <button
          type="button"
          className="btn btn--accent btn--sm"
          disabled={simulating}
          onClick={handleSimulate}
        >
          {simulating ? s.simulating : s.simulate}
        </button>
        <p style={{ fontSize: 12.5, color: 'var(--muted)', margin: '8px 0 0' }}>{s.simulateNote}</p>
        {simulateError && (
          <p role="alert" style={{ color: 'var(--color-error)', fontSize: 13, margin: '8px 0 0' }}>
            {simulateError}
          </p>
        )}
      </div>
    )
  }

  // affordance === 'stripe': loader already resolved in loadSession.
  return (
    <div style={{ marginBottom: 14, paddingTop: 14, borderTop: '1px dashed var(--line)' }}>
      <p style={{ fontSize: 14.5, fontWeight: 600, color: 'var(--ink)', margin: '0 0 10px' }}>
        {s.pay.payTitle}
      </p>
      <Elements stripe={stripe} options={{ clientSecret: session.clientSecret!, locale: lang }}>
        <PayForm
          transferId={transferId}
          totalAmountMinor={totalAmountMinor}
          onSubmitted={() => {
            setSubmitted(true)
            void onAdvanced() // banner already swapped in — no need to hold on the poll
          }}
        />
      </Elements>
    </div>
  )
}

// Mounts Stripe's onramp widget exactly once per (onramp, clientSecret) and
// translates its session-updated events into the parent's two outcomes. The
// handlers live in a ref, NOT effect deps: the parent re-renders on every
// tracker poll with fresh closures, and remounting would wipe the sender's
// in-widget progress (identity form, half-entered card). `settled` gates the
// callbacks — a session emits fulfillment_processing then _complete, and the
// parent must hear exactly one outcome.
function OnrampWidget({
  onramp,
  clientSecret,
  onPaid,
  onRejected,
}: {
  onramp: StripeOnramp
  clientSecret: string
  onPaid: () => void
  onRejected: () => void
}) {
  const containerRef = useRef<HTMLDivElement | null>(null)
  const handlersRef = useRef({ onPaid, onRejected })
  handlersRef.current = { onPaid, onRejected }

  useEffect(() => {
    const container = containerRef.current
    if (!container) return
    let settled = false
    container.innerHTML = ''
    onramp
      .createSession({ clientSecret })
      .addEventListener('onramp_session_updated', (event) => {
        if (settled) return
        // The event envelope moved between SDK typings (0.0.2: payload IS the
        // session; 1.1.3: payload.session nests it) and the widget script is
        // evergreen from Stripe's CDN — read both shapes so a server-side
        // envelope change can't silently kill the listener.
        const payload = event.payload as { status?: string; session?: { status?: string } }
        const status = payload.session?.status ?? payload.status
        if (status === 'fulfillment_processing' || status === 'fulfillment_complete') {
          settled = true
          handlersRef.current.onPaid()
        } else if (status === 'rejected') {
          settled = true
          handlersRef.current.onRejected()
        }
        // initialized / requires_payment / front-end 'error': the widget
        // renders its own state — nothing for the parent to do.
      })
      .mount(container)
    return () => {
      // Clearing the container tears down the widget iframe; the session
      // object and its listener go with it.
      container.innerHTML = ''
    }
  }, [onramp, clientSecret])

  return <div ref={containerRef} />
}

function PayForm({
  transferId,
  totalAmountMinor,
  onSubmitted,
}: {
  transferId: string
  totalAmountMinor: number
  onSubmitted: () => void
}) {
  const { t } = useLanguage()
  const s = t.send.track
  const stripe = useStripe()
  const elements = useElements()

  const [paying, setPaying] = useState(false)
  // Stripe-authored inline message (bank refusal, incomplete form) vs Puente
  // generic — see classifyConfirmPaymentError.
  const [payError, setPayError] = useState('')

  const handlePay = async () => {
    if (!stripe || !elements) return
    setPaying(true)
    setPayError('')
    posthog.capture('send_payment_submitted', { transfer_id: transferId })
    try {
      // us_bank_account never redirects; 'if_required' keeps the flow on-page.
      const result = await stripe.confirmPayment({ elements, redirect: 'if_required' })
      if (result.error) {
        const kind = classifyConfirmPaymentError(result.error)
        // Code only, never the message — messages can carry bank/account detail.
        posthog.capture('send_payment_failed', {
          transfer_id: transferId,
          code: result.error.code ?? result.error.type ?? 'unknown',
        })
        setPayError(
          kind === 'inline' && result.error.message ? result.error.message : s.pay.paymentError,
        )
        return
      }
      // PI is now processing → the webhook drives FUNDED; the tracker's poll
      // picks it up. We show "submitted", never "paid".
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
      {/* Instant-only verification (locked decision 3): no microdeposit
          fallback, so an unconnectable bank means we cannot take the payment. */}
      <p style={{ fontSize: 12.5, color: 'var(--muted)', margin: '10px 0 0', lineHeight: 1.5 }}>
        {s.pay.bankNote}
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
        disabled={paying || !stripe || !elements}
        onClick={handlePay}
      >
        {paying ? s.pay.paying : s.pay.payNow.replace('{amount}', formatUsd(totalAmountMinor))}
      </button>
    </div>
  )
}
