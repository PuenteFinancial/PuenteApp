'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import posthog from 'posthog-js'
import { useLanguage } from '@/components/LanguageProvider'
import { parseApiError, errorMessage } from '@/lib/apiError'
import { useIdempotencyKey } from '@/lib/idempotency'
import { formatUsd, formatMxn, mmss, secondsUntil } from '@/lib/sendFormat'
import { SUPPORT_EMAIL } from '@/lib/support'
import {
  canRequestCancel,
  classifyCancelResponse,
  isOnHappyPath,
  isSettled,
  isTransferShape,
  outcomeFor,
  timelineFor,
  type TrackedTransfer,
} from '@/lib/transferState'

// Faster than the 30 s onboarding poll (PendingPoller): this screen is watched
// while money is moving, and the payout jobs advance the state in seconds.
const POLL_INTERVAL_MS = 5_000

export default function TransferTracker({
  initialTransfer,
  canSimulate,
}: {
  initialTransfer: TrackedTransfer
  /** Non-production only. The API 404s the dev endpoint regardless; this just hides a button that could never work. */
  canSimulate: boolean
}) {
  const { t, lang } = useLanguage()
  const s = t.send.track
  const router = useRouter()

  const [transfer, setTransfer] = useState(initialTransfer)
  const [armed, setArmed] = useState(false)
  const [canceling, setCanceling] = useState(false)
  const [cancelError, setCancelError] = useState('')
  const [supportMessage, setSupportMessage] = useState<{ en: string; es: string } | null>(null)
  const [supportFallback, setSupportFallback] = useState(false)
  const [simulating, setSimulating] = useState(false)
  const [simulateError, setSimulateError] = useState('')
  // Set when the poll can't reach the server. The screen keeps showing the last
  // known state, but says so — a silently stale tracker is the worst outcome
  // here, since the user reads it as "my money is still on its way".
  const [stale, setStale] = useState(false)

  // null until mounted: Date.now() differs between the server render and the
  // client's, so seeding it during render would be a hydration mismatch. The
  // countdown and the cancel affordance simply don't render until it's set.
  const [nowMs, setNowMs] = useState<number | null>(null)

  // One cancel per mounted transfer, so the mint-once holder is exactly right:
  // a retry after a failure reuses the key (same logical action), and any
  // ACCEPTED response clears it.
  const cancelKey = useIdempotencyKey()

  const transferId = transfer.id
  const inFlight = useRef(false)

  const refresh = useCallback(async () => {
    if (inFlight.current) return
    inFlight.current = true
    try {
      const res = await fetch(`/api/transfers/${transferId}`, { cache: 'no-store' })
      // An expired session 401s every poll from here on. Hand off to /continue
      // (the single routing brain) so the silent-refresh hop can rotate the
      // token — exactly what PendingPoller does. Without this the tracker polls
      // forever against a dead session, showing a frozen state as if it were
      // live: the user believes money is in flight that may have already failed.
      if (res.status === 401) {
        router.replace('/continue')
        return
      }
      if (!res.ok) {
        setStale(true)
        return
      }
      const body = await res.json()
      // A 2xx that isn't a transfer (gateway HTML past the proxy) must not
      // replace good state with garbage — keep what we have and flag it.
      if (!isTransferShape(body)) {
        setStale(true)
        return
      }
      setStale(false)
      setTransfer(body)
    } catch {
      setStale(true)
    } finally {
      inFlight.current = false
    }
  }, [transferId, router])

  // Poll until the state can no longer change on its own. Same interval +
  // visibilitychange pairing as PendingPoller: coming back to the tab is the
  // common case, and it should feel instant rather than wait out a tick.
  useEffect(() => {
    if (isSettled(transfer.state)) return
    const interval = setInterval(refresh, POLL_INTERVAL_MS)
    const onVisible = () => {
      if (document.visibilityState === 'visible') void refresh()
    }
    document.addEventListener('visibilitychange', onVisible)
    return () => {
      clearInterval(interval)
      document.removeEventListener('visibilitychange', onVisible)
    }
  }, [refresh, transfer.state])

  // Second-resolution clock, only while a cancellation window is actually
  // counting down. Stops once the window closes so a transfer parked in FUNDED
  // on a payout hold doesn't re-render every second for hours.
  const cancelableUntil = transfer.cancelableUntil
  useEffect(() => {
    if (transfer.state !== 'FUNDED' || !cancelableUntil) return
    const endsAt = new Date(cancelableUntil).getTime()
    if (Date.now() >= endsAt) {
      setNowMs(Date.now())
      return
    }
    setNowMs(Date.now())
    const tick = setInterval(() => {
      const now = Date.now()
      setNowMs(now)
      if (now >= endsAt) clearInterval(tick)
    }, 1000)
    return () => clearInterval(tick)
  }, [transfer.state, cancelableUntil])

  const handleCancel = async () => {
    // Two-tap confirm (the RecipientsManager ArchiveButton idiom) — canceling a
    // transfer is not something to do on a stray click.
    if (!armed) {
      setArmed(true)
      setCancelError('')
      return
    }
    setCanceling(true)
    setCancelError('')
    try {
      const res = await fetch(`/api/transfers/${transferId}/cancel`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'idempotency-key': cancelKey.take() },
        // transferId in the BODY is required: the API's idempotency identity
        // excludes the :id path param, so without it a reused key could replay
        // a different transfer's cancel result.
        body: JSON.stringify({ transferId }),
      })

      // The proxy answers an expired session with a bare {error:'Unauthorized'},
      // not the API error envelope, so the mapping layer would render it as the
      // generic "something went wrong" — leaving the sender re-tapping a dead
      // button until the Reg E window closes. Route to re-auth instead.
      if (res.status === 401) {
        router.replace('/continue')
        return
      }

      const body = await res.json().catch(() => ({}))
      const outcome = classifyCancelResponse(res.status, body)

      // Clear on ANY accepted (2xx) response, not just ones we could render:
      // the API stores the response under the key and replays it for 24 h, so
      // holding the key after an unparseable 2xx would replay that same answer
      // on every retry, locking the sender out of a right that may since have
      // become exercisable again.
      if (outcome.accepted) cancelKey.clear()

      if (outcome.kind === 'refunded') {
        setTransfer(outcome.transfer)
        posthog.capture('send_transfer_canceled', { transfer_id: transferId, outcome: 'refunded' })
      } else if (outcome.kind === 'support') {
        // Reg E: the request was ACCEPTED for out-of-band handling, not denied.
        // Show the server's own copy in the sender's language when we have it;
        // otherwise our mapped string — but in the same neutral surface either
        // way, never the red error channel.
        setSupportMessage(outcome.messages)
        setSupportFallback(outcome.messages === null)
        posthog.capture('send_transfer_canceled', { transfer_id: transferId, outcome: 'support' })
        void refresh()
      } else {
        // Keep the key on a genuine failure: a retry is the same logical action.
        setCancelError(errorMessage(outcome.code, t.send.errors))
        posthog.capture('send_transfer_cancel_failed', {
          transfer_id: transferId,
          code: outcome.code,
          accepted: outcome.accepted,
        })
        // The state has usually moved on (that's why it was refused) — re-read
        // so the screen shows the truth behind the message.
        void refresh()
      }
    } catch {
      setCancelError(t.send.errors.generic)
      posthog.capture('send_transfer_cancel_failed', { transfer_id: transferId, code: 'network' })
    } finally {
      setCanceling(false)
      setArmed(false)
    }
  }

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
      await refresh()
    } catch {
      setSimulateError(t.send.errors.generic)
    } finally {
      setSimulating(false)
    }
  }

  const outcome = outcomeFor(transfer.state)
  const steps = timelineFor(transfer.state)

  // Outcomes whose copy tells the sender to contact us. Each must render a real
  // route to do so — telling someone to exercise a statutory right without
  // giving them an address is the gap this closes.
  const outcomeNeedsSupport =
    outcome === 'payoutFailed' || outcome === 'fundingReversed' || outcome === 'underReview'

  const supportLink = (
    <a
      href={`mailto:${SUPPORT_EMAIL}`}
      style={{ color: 'var(--hero)', fontSize: 13.5, fontWeight: 600, textDecoration: 'underline' }}
    >
      {s.supportCta}
    </a>
  )
  const showCancel = nowMs !== null && canRequestCancel(transfer, nowMs)
  const supportText = supportMessage
    ? supportMessage[lang]
    : supportFallback
      ? t.send.errors.cancellation_requires_support
      : null

  return (
    <div className="wl-card">
      <h1 style={{ fontFamily: 'var(--font)', fontSize: 24, fontWeight: 700, margin: '0 0 14px', color: 'var(--ink)' }}>
        {s.title}
      </h1>

      <ul
        style={{
          listStyle: 'none',
          margin: '0 0 18px',
          padding: '13px 15px',
          borderRadius: 'var(--r-sm)',
          background: 'var(--surface-2)',
          border: '1px solid var(--line-2)',
          display: 'flex',
          flexDirection: 'column',
          gap: 6,
        }}
      >
        <li style={{ display: 'flex', justifyContent: 'space-between', fontSize: 14, color: 'var(--ink)' }}>
          <span style={{ color: 'var(--muted)' }}>{s.youSend}</span>
          <b style={{ fontFamily: 'var(--mono)' }}>{formatUsd(transfer.totalAmount.amountMinor)}</b>
        </li>
        <li style={{ display: 'flex', justifyContent: 'space-between', fontSize: 14, color: 'var(--ink)' }}>
          <span style={{ color: 'var(--muted)' }}>{s.theyReceive}</span>
          <b style={{ fontFamily: 'var(--mono)' }}>{formatMxn(transfer.receiveAmount.amountMinor)}</b>
        </li>
      </ul>

      {/* Outcome banner. role="status" so a state change that lands while the
          user is watching is announced, not just repainted. */}
      {outcome && (
        <div role="status" style={{ margin: '0 0 16px' }}>
          <h2 style={{ fontFamily: 'var(--font)', fontSize: 17, fontWeight: 700, margin: '0 0 4px', color: 'var(--ink)' }}>
            {s.outcomes[outcome].title}
          </h2>
          <p style={{ fontSize: 14, color: 'var(--muted)', margin: 0, lineHeight: 1.6 }}>
            {s.outcomes[outcome].body}
          </p>
          {outcomeNeedsSupport && <p style={{ margin: '8px 0 0' }}>{supportLink}</p>}
        </div>
      )}

      {/* The forward path. Rendered only for states still on it — a canceled or
          refunded transfer gets the outcome above instead of a guessed timeline. */}
      {isOnHappyPath(transfer.state) && (
        <ol style={{ listStyle: 'none', margin: '0 0 16px', padding: 0, display: 'flex', flexDirection: 'column', gap: 10 }}>
          {steps.map(({ step, status }) => (
            <li key={step} style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
              <span
                aria-hidden="true"
                style={{
                  width: 10,
                  height: 10,
                  flex: 'none',
                  borderRadius: '50%',
                  background:
                    status === 'done'
                      ? 'var(--hero)'
                      : status === 'current'
                        ? 'var(--accent-2)'
                        : 'var(--line)',
                  boxShadow: status === 'current' ? '0 0 0 4px var(--accent-soft)' : 'none',
                }}
              />
              <span
                style={{
                  fontSize: 14,
                  color: status === 'upcoming' ? 'var(--muted)' : 'var(--ink)',
                  fontWeight: status === 'current' ? 700 : 400,
                }}
              >
                {s.steps[step]}
              </span>
            </li>
          ))}
        </ol>
      )}

      {/* Says the screen may be out of date rather than letting a frozen
          timeline read as live. Retry is manual; the poll also keeps trying. */}
      {stale && (
        <div style={{ marginBottom: 14 }}>
          <p role="status" style={{ fontSize: 13.5, color: 'var(--muted)', margin: '0 0 8px' }}>
            {s.loadError}
          </p>
          <button type="button" className="btn btn--ghost btn--sm" onClick={() => void refresh()}>
            {s.retry}
          </button>
        </div>
      )}

      {/* Server-authored Reg E copy for the 202 — shown verbatim in the sender's
          language, exactly as the disclosure is. Kept outside the cancel block
          so it survives the state change that produced it. */}
      {supportText && (
        <div
          role="alert"
          style={{
            margin: '0 0 14px',
            padding: '11px 13px',
            borderRadius: 'var(--r-sm)',
            background: 'var(--surface-2)',
            border: '1px solid var(--line-2)',
          }}
        >
          <p style={{ fontSize: 13.5, color: 'var(--ink)', lineHeight: 1.55, margin: 0 }}>
            {supportText}
          </p>
          {/* The message says "contact support" — this is that route. */}
          <p style={{ margin: '8px 0 0' }}>{supportLink}</p>
        </div>
      )}

      {showCancel && cancelableUntil && (
        <div style={{ marginBottom: 14 }}>
          <p style={{ fontSize: 13.5, color: 'var(--muted)', margin: '0 0 4px' }}>
            {s.cancelWindow.replace('{time}', mmss(secondsUntil(cancelableUntil, nowMs)))}
          </p>
          {/* The countdown states the RIGHT; this states the mechanism. Without
              it the timer implies 30 minutes of self-service cancellation, when
              in practice the payout job claims the transfer seconds after
              funding and every later request routes to support. */}
          <p style={{ fontSize: 12.5, color: 'var(--muted)', margin: '0 0 8px', lineHeight: 1.5 }}>
            {s.cancelWindowNote}
          </p>
          <button
            type="button"
            className="btn btn--ghost btn--sm"
            disabled={canceling}
            onClick={handleCancel}
            onBlur={() => setArmed(false)}
          >
            {canceling ? s.canceling : armed ? s.cancelConfirm : s.cancel}
          </button>
        </div>
      )}

      {/* Outside the cancel block on purpose: a 409 refusal moves the transfer
          out of the cancelable state, and the reason must not vanish with it.
          Suppressed once the transfer reaches an outcome, so a refunded transfer
          never shows "Refunded" above a stale red failure. */}
      {cancelError && !outcome && (
        <p role="alert" style={{ color: 'var(--color-error)', fontSize: 13, margin: '0 0 14px' }}>
          {cancelError}
        </p>
      )}

      {/* Stands in for the Stripe pay step until keys land. Never rendered in
          production, and the API 404s the endpoint there regardless. */}
      {canSimulate && transfer.state === 'PENDING_PAYMENT' && (
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
      )}

      <Link href="/dashboard" className="btn btn--ghost btn--sm">
        {s.done}
      </Link>
    </div>
  )
}
