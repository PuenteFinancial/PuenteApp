'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { useRouter } from 'next/navigation'
import posthog from 'posthog-js'
import type { Stripe } from '@stripe/stripe-js'
import { Elements, PaymentElement, useElements, useStripe } from '@stripe/react-stripe-js'
import { useLanguage } from '@/components/LanguageProvider'
import { parseApiError, errorMessage } from '@/lib/apiError'
import { formatUsd } from '@/lib/sendFormat'
import {
  classifyConfirmPaymentError,
  isFundingSessionShape,
  payAffordanceFor,
  type FundingSession,
} from '@/lib/payStep'
import { getStripe } from '@/lib/stripe'

// The whole PENDING_PAYMENT affordance: fetches the funding session once, then
// renders the Payment Element (stripe), the dev simulate button (mock, non-prod),
// or nothing (mock in prod — the inert lock, today's behavior).
//
// Poll interplay (TransferTracker's 5 s refresh): FUNDED only lands via the
// payment_intent.processing webhook, which cannot arrive before confirmPayment
// resolves — so the poll can't unmount the Element mid-confirmation. The
// session is fetched once into state and getStripe() memoizes the loader, so
// poll-driven re-renders never remount the Element. The one real race — the
// 30-min reconcile-pending auto-fail flipping the transfer to PAYMENT_FAILED
// with the form open — resolves correctly: the tracker swaps in the existing
// paymentFailed outcome banner.
export default function PayStep({
  transferId,
  totalAmountMinor,
  canSimulate,
  onAdvanced,
}: {
  transferId: string
  /** USD minor units — the pay button restates the total (Money convention: integer minor). */
  totalAmountMinor: number
  /** Non-production only — same prop the simulate button always keyed on. */
  canSimulate: boolean
  /** The tracker's refresh — called after any action that may advance state. */
  onAdvanced: () => void
}) {
  const { t, lang } = useLanguage()
  const s = t.send.track
  const router = useRouter()

  const [session, setSession] = useState<FundingSession | null>(null)
  const [sessionError, setSessionError] = useState(false)
  const [stripe, setStripe] = useState<Stripe | null>(null)
  const [submitted, setSubmitted] = useState(false)
  const [simulating, setSimulating] = useState(false)
  const [simulateError, setSimulateError] = useState('')

  const fetching = useRef(false)

  const loadSession = useCallback(async () => {
    if (fetching.current) return
    fetching.current = true
    setSessionError(false)
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
        setSessionError(true)
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
      setSession(body)
    } catch {
      setSessionError(true)
    } finally {
      fetching.current = false
    }
  }, [transferId, router])

  useEffect(() => {
    void loadSession()
  }, [loadSession])

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
      onAdvanced()
    } catch {
      setSimulateError(t.send.errors.generic)
    } finally {
      setSimulating(false)
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

  if (submitted) {
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

  const affordance = payAffordanceFor(session, canSimulate)

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
            onAdvanced()
          }}
        />
      </Elements>
    </div>
  )
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
