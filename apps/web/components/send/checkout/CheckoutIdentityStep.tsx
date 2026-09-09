'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { useRouter } from 'next/navigation'
import posthog from 'posthog-js'
import { useLanguage } from '@/components/LanguageProvider'
import {
  BRIDGE_POLL_MS,
  buildRelayBody,
  type IdentityFormValues,
} from '@/lib/bridgeIdentity'
import {
  initialCheckoutIdentityState,
  initialEffects,
  transition,
  type CheckoutIdentityEffect,
  type CheckoutIdentityEvent,
  type CheckoutIdentityState,
} from '@/lib/checkoutIdentity'
import { KYC_LOCALE_COOKIE, KYC_NEXT_COOKIE } from '@/lib/kycReturn'
import BridgeKycCard from '@/components/send/bridge/BridgeKycCard'
import CheckoutIdentityForm from './CheckoutIdentityForm'

// Thin host for the Checkout rail's Bridge identity machine
// (lib/checkoutIdentity.ts): dispatches events, executes the reducer's
// declarative effects, fires its captures. Every decision lives in the
// reducer — this file is I/O and rendering only, the same split CryptoPayStep
// uses.
//
// PII: the only effect that touches the identity values is `relay`, and it
// reads them out of the reducer's context at execution time rather than
// carrying them through an event payload. Nothing here logs, stores, or
// captures them.

function readUsersMe(body: unknown): {
  bridgeCustomerId: string | null
  kycStatus: string
  tosAccepted: boolean
} | null {
  if (typeof body !== 'object' || body === null) return null
  const b = body as Record<string, unknown>
  if (typeof b.kycStatus !== 'string') return null
  return {
    bridgeCustomerId: typeof b.bridgeCustomerId === 'string' ? b.bridgeCustomerId : null,
    kycStatus: b.kycStatus,
    tosAccepted: b.bridgeTosAccepted === true,
  }
}

function readUrl(body: unknown): string | null {
  if (typeof body !== 'object' || body === null) return null
  const url = (body as { url?: unknown }).url
  return typeof url === 'string' && url ? url : null
}

async function readFailure(res: Response): Promise<{
  status: number
  code: string | null
  path: string | null
}> {
  const body: unknown = await res.json().catch(() => null)
  const error = (
    typeof body === 'object' && body !== null ? (body as { error?: unknown }).error : null
  ) as { code?: unknown; details?: unknown } | null
  const detail = Array.isArray(error?.details)
    ? (error.details[0] as { path?: unknown } | undefined)
    : undefined
  return {
    status: res.status,
    code: typeof error?.code === 'string' ? error.code : null,
    path: typeof detail?.path === 'string' ? detail.path : null,
  }
}

export default function CheckoutIdentityStep({
  transferId,
  onReady,
}: {
  transferId: string
  /** Bridge holds an approved customer — the host may render the pay form. */
  onReady: () => void
}) {
  const { t, lang } = useLanguage()
  const s = t.send.track
  const router = useRouter()

  // useState + an explicit dispatch, NOT useReducer — the CryptoPayStep
  // pattern, and for a concrete reason: effects and captures have to be
  // executed exactly once per transition. A useReducer whose reducer queued
  // them would fire twice under StrictMode's double invocation, which on this
  // machine means POSTing a tax ID to Bridge twice.
  const [state, setState] = useState<CheckoutIdentityState>(() =>
    initialCheckoutIdentityState(transferId),
  )
  const stateRef = useRef(state)

  const mountedRef = useRef(true)
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const dispatchRef = useRef<(event: CheckoutIdentityEvent) => void>(() => {})

  const runEffect = useCallback(
    async (effect: CheckoutIdentityEffect) => {
      const dispatch = (event: CheckoutIdentityEvent) => {
        if (mountedRef.current) dispatchRef.current(event)
      }

      /** Stash the way home before any hosted-flow redirect. The return pages
       *  read these; the Bridge/Persona chain cannot carry a query param
       *  (origin-built URLs). Path-validated on read. */
      const setReturnCookies = () => {
        const attrs = 'path=/; max-age=3600; SameSite=Lax'
        document.cookie = `${KYC_NEXT_COOKIE}=/dashboard/send/${transferId}; ${attrs}`
        document.cookie = `${KYC_LOCALE_COOKIE}=${lang}; ${attrs}`
      }

      switch (effect.kind) {
        case 'fetch_users_me':
        case 'poll_users_me': {
          const read = async () => {
            try {
              const res = await fetch('/api/users/me', { cache: 'no-store' })
              if (res.status === 401) {
                router.replace('/continue')
                return
              }
              const me = res.ok ? readUsersMe(await res.json().catch(() => null)) : null
              if (!me) {
                dispatch(
                  effect.kind === 'fetch_users_me'
                    ? { type: 'BOOT_FAILED' }
                    : { type: 'USERS_ME_FAILED' },
                )
                return
              }
              dispatch(
                effect.kind === 'fetch_users_me'
                  ? { type: 'BOOT_OK', ...me }
                  : {
                      type: 'USERS_ME_RESULT',
                      bridgeCustomerId: me.bridgeCustomerId,
                      kycStatus: me.kycStatus,
                    },
              )
            } catch {
              dispatch(
                effect.kind === 'fetch_users_me'
                  ? { type: 'BOOT_FAILED' }
                  : { type: 'USERS_ME_FAILED' },
              )
            }
          }
          if (effect.kind === 'fetch_users_me') return read()
          timerRef.current = setTimeout(() => void read(), BRIDGE_POLL_MS)
          return
        }

        case 'tos_redirect': {
          try {
            setReturnCookies()
            const res = await fetch('/api/users/me/tos-link', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ origin: window.location.origin, platform: 'web' }),
            })
            const url = readUrl(await res.json().catch(() => null))
            if (!res.ok || !url) {
              dispatch({ type: 'REDIRECT_FAILED' })
              return
            }
            window.location.assign(url)
          } catch {
            dispatch({ type: 'REDIRECT_FAILED' })
          }
          return
        }

        case 'relay': {
          // THE sanctioned PII carrier. Values are read from the reducer's
          // context here and are gone from it the moment this dispatches.
          const values = stateRef.current.ctx.relayValues
          if (!values) {
            dispatch({ type: 'RELAY_ERROR', failure: { status: 0, code: null, path: null } })
            return
          }
          try {
            const res = await fetch('/api/users/me/bridge-customer', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify(buildRelayBody(values)),
            })
            if (res.status === 401) {
              router.replace('/continue')
              return
            }
            if (!res.ok) {
              dispatch({ type: 'RELAY_ERROR', failure: await readFailure(res) })
              return
            }
            const body: unknown = await res.json().catch(() => null)
            const b = (typeof body === 'object' && body !== null ? body : {}) as {
              bridgeCustomerId?: unknown
              status?: unknown
            }
            if (typeof b.bridgeCustomerId !== 'string') {
              dispatch({ type: 'RELAY_ERROR', failure: { status: res.status, code: null, path: null } })
              return
            }
            dispatch({
              type: 'RELAY_OK',
              bridgeCustomerId: b.bridgeCustomerId,
              status: typeof b.status === 'string' ? b.status : 'pending',
            })
          } catch {
            // Network/timeout. Code only — the error may wrap the request.
            dispatch({ type: 'RELAY_ERROR', failure: { status: 0, code: null, path: null } })
          }
          return
        }

        case 'fetch_rejection': {
          try {
            const res = await fetch('/api/users/me/kyc-rejection', { cache: 'no-store' })
            const body: unknown = await res.json().catch(() => null)
            const b = (typeof body === 'object' && body !== null ? body : {}) as {
              retriesRemaining?: unknown
            }
            // Unreadable detail is `null`, NOT zero: the reducer still offers
            // the document fallback, because the server bounds retries anyway.
            dispatch({
              type: 'REJECTION_RESULT',
              retriesRemaining:
                res.ok && typeof b.retriesRemaining === 'number' ? b.retriesRemaining : null,
            })
          } catch {
            dispatch({ type: 'REJECTION_RESULT', retriesRemaining: null })
          }
          return
        }

        case 'persona_redirect': {
          try {
            setReturnCookies()
            const res = await fetch('/api/users/me/kyc-link/retry', { method: 'POST' })
            if (res.status === 401) {
              router.replace('/continue')
              return
            }
            const url = readUrl(await res.json().catch(() => null))
            if (!res.ok || !url) {
              dispatch({ type: 'REDIRECT_FAILED' })
              return
            }
            window.location.assign(url)
          } catch {
            dispatch({ type: 'REDIRECT_FAILED' })
          }
          return
        }
      }
    },
    [transferId, lang, router],
  )

  const dispatch = useCallback(
    (event: CheckoutIdentityEvent) => {
      const result = transition(stateRef.current, event)
      stateRef.current = result.state
      setState(result.state)
      for (const capture of result.captures) posthog.capture(capture.event, capture.props)
      for (const effect of result.effects) void runEffect(effect)
    },
    [runEffect],
  )
  useEffect(() => {
    dispatchRef.current = dispatch
  }, [dispatch])

  useEffect(() => {
    mountedRef.current = true
    for (const effect of initialEffects) void runEffect(effect)
    return () => {
      mountedRef.current = false
      if (timerRef.current) clearTimeout(timerRef.current)
    }
    // Boot exactly once per mount — the machine owns everything after.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // `ready` is the machine's terminal success. Tell the parent once.
  const readyFired = useRef(false)
  useEffect(() => {
    if (state.view.step === 'ready' && !readyFired.current) {
      readyFired.current = true
      onReady()
    }
  }, [state.view.step, onReady])

  const view = state.view
  const frame = (children: React.ReactNode) => (
    <div style={{ marginBottom: 14, paddingTop: 14, borderTop: '1px dashed var(--line)' }}>
      {children}
    </div>
  )
  const retryCard = (message: string) =>
    frame(
      <>
        <p role="alert" style={{ color: 'var(--color-error)', fontSize: 13, margin: '0 0 8px' }}>
          {message}
        </p>
        <button
          type="button"
          className="btn btn--ghost btn--sm"
          onClick={() => dispatch({ type: 'RETRY' })}
        >
          {s.retry}
        </button>
      </>,
    )

  switch (view.step) {
    case 'loading':
      return frame(
        <p style={{ fontSize: 13, color: 'var(--muted)', margin: 0 }}>{s.pay.checkout.loading}</p>,
      )

    case 'boot_error':
      return retryCard(s.pay.sessionError)

    case 'bridge_tos':
      return frame(
        <BridgeKycCard
          variant="tos"
          busy={false}
          onContinue={() => dispatch({ type: 'TOS_CONTINUE' })}
        />,
      )

    case 'identity_form':
      return frame(
        <CheckoutIdentityForm
          reason={view.reason}
          invalid={view.invalid}
          busy={false}
          onSubmit={(values: IdentityFormValues) =>
            dispatch({ type: 'IDENTITY_SUBMIT', values })
          }
        />,
      )

    case 'relaying':
      return frame(<BridgeKycCard variant="waiting" busy />)

    case 'bridge_polling':
      return frame(<BridgeKycCard variant="waiting" busy />)

    case 'bridge_wait':
      return frame(
        <BridgeKycCard
          variant="wait"
          busy={false}
          onContinue={() => dispatch({ type: 'RECHECK' })}
        />,
      )

    case 'bridge_rejection':
      return frame(<BridgeKycCard variant="waiting" busy />)

    case 'bridge_persona':
      return frame(
        <BridgeKycCard
          variant="persona"
          busy={false}
          onContinue={() => dispatch({ type: 'PERSONA_CONTINUE' })}
        />,
      )

    case 'failed':
      if (view.kind === 'duplicate_identity') {
        return frame(<BridgeKycCard variant="duplicate" busy={false} />)
      }
      if (view.kind === 'kyc_rejected') {
        return frame(
          <>
            <p style={{ fontSize: 14.5, fontWeight: 600, color: 'var(--ink)', margin: '0 0 4px' }}>
              {s.crypto.kyc.rejectedTitle}
            </p>
            <p style={{ fontSize: 13, color: 'var(--muted)', margin: 0, lineHeight: 1.5 }}>
              {s.crypto.kyc.rejectedBody}
            </p>
          </>,
        )
      }
      return retryCard(s.pay.paymentError)

    case 'ready':
      // The parent swaps in the Payment Element; nothing to draw here.
      return null
  }
}
