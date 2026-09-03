'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { useRouter } from 'next/navigation'
import posthog from 'posthog-js'
import type { OnrampCoordinator } from '@stripe/crypto'
import { useLanguage } from '@/components/LanguageProvider'
import {
  BRIDGE_POLL_MS,
  KYC_POLL_MS,
  buildCheckoutBody,
  buildCustomerBody,
  buildExchangeBody,
  buildKycInfo,
  classifyCryptoApiError,
  initialCryptoPayState,
  initialEffects,
  transition,
  type CryptoApiFailure,
  type CryptoPayEffect,
  type CryptoPayEvent,
  type CryptoPayState,
  type CryptoPrefill,
  type CryptoVerification,
  type KycFormMode,
  type KycFormValues,
} from '@/lib/cryptoPayStep'
import { KYC_LOCALE_COOKIE, KYC_NEXT_COOKIE } from '@/lib/kycReturn'
import KycForm from './KycForm'
import RelayForm from './RelayForm'
import PayIntro from './PayIntro'
import BridgeKycCard from './BridgeKycCard'
import SdkElementHost from './SdkElementHost'

// Thin host for the K5 crypto pay machine (lib/cryptoPayStep.ts): dispatches
// events, executes the reducer's declarative effects, fires its captures.
// All decisions live in the reducer — this file is I/O and rendering only.
//
// Mount discipline: PayStep renders this once per transfer; the tracker's 5s
// poll re-renders the parent but React preserves this subtree, and the two
// live SDK surfaces (authenticate modal, payment element) are mounted by
// element identity in SdkElementHost — never remounted mid-flow.

function readVerifications(body: unknown): CryptoVerification[] {
  if (typeof body !== 'object' || body === null) return []
  const v = (body as { verifications?: unknown }).verifications
  if (!Array.isArray(v)) return []
  return v.filter(
    (entry): entry is CryptoVerification =>
      typeof entry === 'object' &&
      entry !== null &&
      typeof (entry as { type?: unknown }).type === 'string' &&
      typeof (entry as { status?: unknown }).status === 'string',
  )
}

function readPrefill(body: unknown): CryptoPrefill | null {
  if (typeof body !== 'object' || body === null) return null
  const b = body as Record<string, unknown>
  if (typeof b.phone !== 'string') return null
  const str = (v: unknown) => (typeof v === 'string' ? v : null)
  return {
    firstName: str(b.firstName),
    lastName: str(b.lastName),
    email: str(b.email),
    phone: b.phone,
    addressLine1: str(b.addressLine1),
    addressLine2: str(b.addressLine2),
    addressCity: str(b.addressCity),
    addressState: str(b.addressState),
    addressPostalCode: str(b.addressPostalCode),
    bridgeCustomerId: str(b.bridgeCustomerId),
    kycStatus: str(b.kycStatus) ?? 'not_started',
    // Absent on a pre-K6 API = not accepted: the gate shows, and the
    // click-through is idempotent server-side.
    bridgeTosAccepted: b.bridgeTosAccepted === true,
  }
}

/** The `{ url }` of a hosted-flow response, or null. */
function readUrl(body: unknown): string | null {
  if (typeof body !== 'object' || body === null) return null
  const url = (body as { url?: unknown }).url
  return typeof url === 'string' && url ? url : null
}

export default function CryptoPayStep({
  coordinator,
  transferId,
  walletAddress,
  onAdvanced,
}: {
  coordinator: OnrampCoordinator
  transferId: string
  /** Treasury address from the funding-session bootstrap. The SDK must
   *  register it before a session can be created; the client never chooses
   *  an address, it only registers the one the server pins. */
  walletAddress: string
  /** The tracker's refresh — nudged once checkout submits so FUNDED lands on
   *  the next webhook-driven poll without waiting a full interval. */
  onAdvanced: () => Promise<void>
}) {
  const { t, lang } = useLanguage()
  const c = t.send.track.crypto
  const s = t.send.track
  const router = useRouter()

  const [state, setState] = useState<CryptoPayState>(() => initialCryptoPayState(transferId))
  const [authElement, setAuthElement] = useState<HTMLElement | null>(null)
  const [collectElement, setCollectElement] = useState<HTMLElement | null>(null)

  const stateRef = useRef(state)
  const coordRef = useRef(coordinator)
  useEffect(() => {
    coordRef.current = coordinator
  }, [coordinator])
  const mountedRef = useRef(true)
  const timersRef = useRef<Set<ReturnType<typeof setTimeout>>>(new Set())
  /** Values captured at KYC_SUBMIT so the address-sync effect can hand the
   *  SAME values to ADDRESS_SYNCED (the reducer keeps PII out of API-bound
   *  effects on purpose, so the patch effect cannot carry them). */
  const pendingKycRef = useRef<{ values: KycFormValues; mode: KycFormMode } | null>(null)
  /** The checkout callback's classified failure — performCheckout surfaces
   *  our POST's rejection as a generic throw, so the real envelope is
   *  stashed here for CHECKOUT_ERROR. */
  const checkoutFailureRef = useRef<CryptoApiFailure | null>(null)

  const schedule = useCallback((ms: number, fn: () => void) => {
    const timer = setTimeout(() => {
      timersRef.current.delete(timer)
      if (mountedRef.current) fn()
    }, ms)
    timersRef.current.add(timer)
  }, [])

  const dispatchRef = useRef<(event: CryptoPayEvent) => void>(() => {})

  const runEffect = useCallback(
    async (effect: CryptoPayEffect) => {
      const dispatch = (event: CryptoPayEvent) => {
        if (mountedRef.current) dispatchRef.current(event)
      }

      /** Stash the way home before any hosted-flow redirect. The return
       *  pages read these; the Bridge/Persona redirect chain can't carry a
       *  query param (origin-built URLs). Path-validated on read. */
      const setReturnCookies = () => {
        const attrs = 'path=/; max-age=3600; SameSite=Lax'
        document.cookie = `${KYC_NEXT_COOKIE}=/dashboard/send/${transferId}; ${attrs}`
        document.cookie = `${KYC_LOCALE_COOKIE}=${lang}; ${attrs}`
      }

      switch (effect.kind) {
        case 'boot': {
          try {
            const [meRes, kycRes] = await Promise.all([
              fetch('/api/users/me', { cache: 'no-store' }),
              fetch('/api/crypto/kyc-status', { cache: 'no-store' }),
            ])
            if (meRes.status === 401) {
              router.replace('/continue')
              return
            }
            const meBody: unknown = await meRes.json().catch(() => null)
            const prefill = meRes.ok ? readPrefill(meBody) : null
            if (!prefill) {
              dispatch({ type: 'BOOT_FAILED' })
              return
            }
            // 404 = no crypto customer yet; 409 = token revoked. Both mean
            // the full Link flow runs — not errors.
            let kyc: { cryptoCustomerId: string; verifications: CryptoVerification[] } | null = null
            if (kycRes.ok) {
              const kycBody: unknown = await kycRes.json().catch(() => null)
              const customerId =
                typeof kycBody === 'object' && kycBody !== null
                  ? (kycBody as { customerId?: unknown }).customerId
                  : null
              if (typeof customerId === 'string' && customerId) {
                kyc = { cryptoCustomerId: customerId, verifications: readVerifications(kycBody) }
              }
            } else if (kycRes.status !== 404 && kycRes.status !== 409) {
              dispatch({ type: 'BOOT_FAILED' })
              return
            }
            dispatch({ type: 'BOOT_OK', prefill, kyc })
          } catch {
            dispatch({ type: 'BOOT_FAILED' })
          }
          return
        }

        case 'create_intent': {
          try {
            const res = await fetch('/api/crypto/link-auth-intent', { method: 'POST' })
            if (res.status === 401) {
              router.replace('/continue')
              return
            }
            const body: unknown = await res.json().catch(() => null)
            if (!res.ok || typeof body !== 'object' || body === null) {
              dispatch({ type: 'INTENT_FAILED' })
              return
            }
            const b = body as { authIntentId?: unknown; linkAccountExists?: unknown }
            dispatch({
              type: 'INTENT_OK',
              authIntentId: typeof b.authIntentId === 'string' ? b.authIntentId : '',
              linkAccountExists: b.linkAccountExists === true,
            })
          } catch {
            dispatch({ type: 'INTENT_FAILED' })
          }
          return
        }

        case 'sdk_register': {
          const prefill = stateRef.current.ctx.prefill
          if (!prefill?.email) {
            dispatch({ type: 'REGISTER_FAILED' })
            return
          }
          try {
            const fullName =
              [prefill.firstName, prefill.lastName].filter(Boolean).join(' ') || undefined
            await coordRef.current.registerLinkUser(prefill.email, prefill.phone, 'US', fullName)
            dispatch({ type: 'REGISTER_OK' })
          } catch {
            dispatch({ type: 'REGISTER_FAILED' })
          }
          return
        }

        case 'sdk_authenticate': {
          // The callback can fire BEFORE the element promise resolves (no
          // authentication needed) — in that case the element is never
          // mounted, per the SDK contract.
          let settled = false
          try {
            const element = await coordRef.current.authenticate(effect.authIntentId, (result) => {
              settled = true
              setAuthElement(null)
              dispatch({
                type: 'AUTH_RESULT',
                result: result.result,
                cryptoCustomerId: result.crypto_customer_id,
              })
            })
            if (!settled && element && mountedRef.current) setAuthElement(element)
          } catch {
            if (!settled) dispatch({ type: 'AUTH_FAILED' })
          }
          return
        }

        case 'exchange_and_customer': {
          try {
            const exRes = await fetch('/api/crypto/link-auth-intent/exchange', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify(buildExchangeBody(effect.authIntentId)),
            })
            if (!exRes.ok) {
              dispatch({ type: 'EXCHANGE_FAILED' })
              return
            }
            const custRes = await fetch('/api/crypto/customer', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify(buildCustomerBody(effect.cryptoCustomerId)),
            })
            const custBody: unknown = await custRes.json().catch(() => null)
            if (!custRes.ok) {
              dispatch({ type: 'EXCHANGE_FAILED' })
              return
            }
            dispatch({ type: 'EXCHANGE_OK', verifications: readVerifications(custBody) })
          } catch {
            dispatch({ type: 'EXCHANGE_FAILED' })
          }
          return
        }

        case 'patch_address': {
          try {
            const res = await fetch('/api/users/me', {
              method: 'PATCH',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify(effect.body),
            })
            const pending = pendingKycRef.current
            if (res.ok && pending) {
              dispatch({ type: 'ADDRESS_SYNCED', values: pending.values, mode: pending.mode })
            } else {
              dispatch({ type: 'ADDRESS_SYNC_FAILED' })
            }
          } catch {
            dispatch({ type: 'ADDRESS_SYNC_FAILED' })
          }
          return
        }

        case 'sdk_submit_kyc': {
          try {
            await coordRef.current.submitKycInfo(buildKycInfo(effect.values, effect.mode))
            dispatch({ type: 'KYC_SUBMITTED' })
          } catch {
            dispatch({ type: 'KYC_SUBMIT_FAILED' })
          }
          return
        }

        case 'poll_kyc': {
          schedule(KYC_POLL_MS, () => {
            void (async () => {
              try {
                const res = await fetch('/api/crypto/kyc-status', { cache: 'no-store' })
                const body: unknown = await res.json().catch(() => null)
                if (!res.ok) {
                  dispatch({ type: 'KYC_POLL_FAILED' })
                  return
                }
                dispatch({ type: 'KYC_POLL_RESULT', verifications: readVerifications(body) })
              } catch {
                dispatch({ type: 'KYC_POLL_FAILED' })
              }
            })()
          })
          return
        }

        case 'sdk_verify_documents': {
          try {
            const result = await coordRef.current.verifyDocuments()
            dispatch({ type: 'DOCS_RESULT', result: result.result })
          } catch {
            dispatch({ type: 'DOCS_FAILED' })
          }
          return
        }

        case 'relay': {
          // THE KYC RELAY (K6): the one POST to our API carrying the DOB and
          // tax ID, on their single pass to Bridge. Nothing here reads,
          // logs, or keeps the body — it is the reducer's effect, sent once.
          try {
            const res = await fetch('/api/users/me/bridge-customer', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify(effect.body),
            })
            if (res.status === 401) {
              router.replace('/continue')
              return
            }
            const body: unknown = await res.json().catch(() => null)
            if (!res.ok) {
              dispatch({ type: 'RELAY_ERROR', failure: classifyCryptoApiError(res.status, body) })
              return
            }
            const b = (typeof body === 'object' && body !== null ? body : {}) as {
              bridgeCustomerId?: unknown
              status?: unknown
            }
            if (typeof b.bridgeCustomerId !== 'string' || !b.bridgeCustomerId) {
              dispatch({
                type: 'RELAY_ERROR',
                failure: { status: 502, code: 'provider_unavailable', issue: null, path: null },
              })
              return
            }
            dispatch({
              type: 'RELAY_OK',
              bridgeCustomerId: b.bridgeCustomerId,
              status: typeof b.status === 'string' ? b.status : 'pending',
            })
          } catch {
            dispatch({ type: 'RELAY_ERROR', failure: { status: 0, code: null, issue: null, path: null } })
          }
          return
        }

        case 'bridge_redirect': {
          try {
            setReturnCookies()
            const res = await fetch('/api/users/me/tos-link', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ origin: window.location.origin, platform: 'web' }),
            })
            const url = readUrl(await res.json().catch(() => null))
            if (!res.ok || !url) {
              dispatch({ type: 'BRIDGE_REDIRECT_FAILED' })
              return
            }
            window.location.assign(url)
          } catch {
            dispatch({ type: 'BRIDGE_REDIRECT_FAILED' })
          }
          return
        }

        case 'poll_users_me': {
          schedule(BRIDGE_POLL_MS, () => {
            void (async () => {
              try {
                const res = await fetch('/api/users/me', { cache: 'no-store' })
                const body: unknown = await res.json().catch(() => null)
                const prefill = res.ok ? readPrefill(body) : null
                if (!prefill) {
                  dispatch({ type: 'USERS_ME_FAILED' })
                  return
                }
                dispatch({
                  type: 'USERS_ME_RESULT',
                  bridgeCustomerId: prefill.bridgeCustomerId,
                  kycStatus: prefill.kycStatus,
                })
              } catch {
                dispatch({ type: 'USERS_ME_FAILED' })
              }
            })()
          })
          return
        }

        case 'fetch_rejection': {
          try {
            const res = await fetch('/api/users/me/kyc-rejection', { cache: 'no-store' })
            const body: unknown = await res.json().catch(() => null)
            const b = (typeof body === 'object' && body !== null ? body : {}) as {
              reasons?: unknown
              retriesRemaining?: unknown
            }
            if (!res.ok || typeof b.retriesRemaining !== 'number') {
              dispatch({ type: 'REJECTION_FAILED' })
              return
            }
            dispatch({
              type: 'REJECTION_RESULT',
              reasons: Array.isArray(b.reasons)
                ? b.reasons.filter((r): r is string => typeof r === 'string')
                : [],
              retriesRemaining: b.retriesRemaining,
            })
          } catch {
            dispatch({ type: 'REJECTION_FAILED' })
          }
          return
        }

        case 'persona_retry': {
          try {
            setReturnCookies()
            // The proxy adds the origin and allowlists the returned host.
            const res = await fetch('/api/users/me/kyc-link/retry', { method: 'POST' })
            if (res.status === 401) {
              router.replace('/continue')
              return
            }
            const url = readUrl(await res.json().catch(() => null))
            if (!res.ok || !url) {
              dispatch({ type: 'PERSONA_REDIRECT_FAILED' })
              return
            }
            window.location.assign(url)
          } catch {
            dispatch({ type: 'PERSONA_REDIRECT_FAILED' })
          }
          return
        }

        case 'sdk_collect': {
          try {
            const element = await coordRef.current.collectPaymentMethod(
              {
                payment_method_types: ['card', 'us_bank_account'],
                wallets: { applePay: 'auto', googlePay: 'auto' },
              },
              (request) => {
                setCollectElement(null)
                const details = request.paymentMethodDetails
                const methodType = details?.type === 'us_bank_account' ? 'us_bank_account' : 'card'
                const card =
                  details && details.type === 'card'
                    ? (details as { card?: { funding?: string; wallet?: { type?: string } | null } })
                        .card
                    : undefined
                dispatch({
                  type: 'PM_COLLECTED',
                  cryptoPaymentToken: request.cryptoPaymentToken,
                  methodType,
                  cardFunding: card?.funding ?? null,
                  wallet: card?.wallet?.type ?? null,
                })
              },
            )
            if (mountedRef.current) setCollectElement(element)
          } catch {
            dispatch({ type: 'COLLECT_FAILED' })
          }
          return
        }

        case 'sdk_register_wallet': {
          try {
            // Base is the corridor's fixed network (server-side constant);
            // re-registering an existing wallet is safe and returns the same
            // ccw_, so no bookkeeping is needed across attempts.
            await coordRef.current.registerWalletAddress(walletAddress, 'base')
            dispatch({ type: 'WALLET_READY' })
          } catch {
            dispatch({ type: 'WALLET_FAILED' })
          }
          return
        }

        case 'create_session': {
          try {
            const res = await fetch(`/api/crypto/transfers/${transferId}/onramp-session`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify(effect.body),
            })
            if (res.status === 401) {
              router.replace('/continue')
              return
            }
            const body: unknown = await res.json().catch(() => null)
            if (!res.ok) {
              dispatch({ type: 'SESSION_ERROR', failure: classifyCryptoApiError(res.status, body) })
              return
            }
            const sessionId =
              typeof body === 'object' && body !== null
                ? (body as { sessionId?: unknown }).sessionId
                : null
            if (typeof sessionId !== 'string' || !sessionId) {
              dispatch({
                type: 'SESSION_ERROR',
                failure: { status: 502, code: 'provider_unavailable', issue: null, path: null },
              })
              return
            }
            dispatch({ type: 'SESSION_OK', sessionId })
          } catch {
            dispatch({ type: 'SESSION_ERROR', failure: { status: 0, code: null, issue: null, path: null } })
          }
          return
        }

        case 'sdk_checkout': {
          checkoutFailureRef.current = null
          const methodType = stateRef.current.ctx.paymentMethodType ?? 'card'
          try {
            const result = await coordRef.current.performCheckout(
              effect.sessionId,
              async (onrampSessionId) => {
                // Called only from inside performCheckout (possibly more than
                // once — 3DS next-actions). The clientSecret returns to the
                // SDK and is never stored.
                const res = await fetch(`/api/crypto/transfers/${transferId}/onramp-checkout`, {
                  method: 'POST',
                  headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify(buildCheckoutBody(onrampSessionId, methodType)),
                })
                const body: unknown = await res.json().catch(() => null)
                if (!res.ok) {
                  checkoutFailureRef.current = classifyCryptoApiError(res.status, body)
                  throw new Error('checkout refused')
                }
                const secret =
                  typeof body === 'object' && body !== null
                    ? (body as { clientSecret?: unknown }).clientSecret
                    : null
                if (typeof secret !== 'string' || !secret) {
                  checkoutFailureRef.current = {
                    status: 502,
                    code: 'provider_unavailable',
                    issue: null,
                    path: null,
                  }
                  throw new Error('checkout missing client secret')
                }
                return secret
              },
            )
            dispatch({ type: 'CHECKOUT_OK', successful: result.successful === true })
          } catch {
            dispatch({
              type: 'CHECKOUT_ERROR',
              failure: checkoutFailureRef.current ?? { status: 0, code: null, issue: null, path: null },
            })
          }
          return
        }
      }
    },
    [lang, router, schedule, transferId, walletAddress],
  )

  const dispatch = useCallback(
    (event: CryptoPayEvent) => {
      const result = transition(stateRef.current, event)
      stateRef.current = result.state
      setState(result.state)
      for (const capture of result.captures) {
        posthog.capture(capture.event, capture.props)
      }
      for (const effect of result.effects) {
        void runEffect(effect)
      }
      if (result.state.view.step === 'submitted') {
        void onAdvanced()
      }
    },
    [onAdvanced, runEffect],
  )
  useEffect(() => {
    dispatchRef.current = dispatch
  }, [dispatch])

  useEffect(() => {
    mountedRef.current = true
    for (const effect of initialEffects()) void runEffect(effect)
    const timers = timersRef.current
    return () => {
      mountedRef.current = false
      for (const timer of timers) clearTimeout(timer)
      timers.clear()
    }
    // Boot exactly once per mount — the machine owns everything after.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const { view, ctx } = state
  const wrap = { marginBottom: 14, paddingTop: 14, borderTop: '1px dashed var(--line)' } as const
  const busyLine = (text: string) => (
    <p role="status" style={{ fontSize: 13, color: 'var(--muted)', margin: 0, lineHeight: 1.5 }}>
      {text}
    </p>
  )
  const errorCard = (text: string, retry: boolean) => (
    <div style={wrap}>
      <p role="alert" style={{ color: 'var(--color-error)', fontSize: 13, margin: '0 0 8px' }}>
        {text}
      </p>
      {retry && (
        <button
          type="button"
          className="btn btn--ghost btn--sm"
          onClick={() => dispatch({ type: 'RETRY' })}
        >
          {c.errors.retryCta}
        </button>
      )}
    </div>
  )
  const titledCard = (title: string, body: string) => (
    <div style={wrap}>
      <p style={{ fontSize: 14.5, fontWeight: 600, color: 'var(--ink)', margin: '0 0 4px' }}>{title}</p>
      <p style={{ fontSize: 13, color: 'var(--muted)', margin: 0, lineHeight: 1.5 }}>{body}</p>
    </div>
  )

  switch (view.step) {
    case 'loading':
      return <div style={wrap}>{busyLine(c.link.starting)}</div>
    case 'boot_error':
      return errorCard(s.pay.sessionError, true)
    case 'intro':
      return (
        <div style={wrap}>
          <PayIntro onContinue={() => dispatch({ type: 'CONTINUE' })} />
        </div>
      )
    case 'bridge_tos':
      return (
        <div style={wrap}>
          <BridgeKycCard variant="tos" busy={false} onContinue={() => dispatch({ type: 'BRIDGE_CONTINUE' })} />
        </div>
      )
    case 'link_auth':
      return <div style={wrap}>{busyLine(c.link.starting)}</div>
    case 'link_register':
      return <div style={wrap}>{busyLine(c.link.registering)}</div>
    case 'link_verify':
      return (
        <div style={wrap}>
          {authElement ? (
            <>
              <p style={{ fontSize: 13, color: 'var(--muted)', margin: '0 0 10px', lineHeight: 1.5 }}>
                {c.link.modalHint}
              </p>
              <SdkElementHost element={authElement} />
            </>
          ) : (
            busyLine(c.link.starting)
          )}
        </div>
      )
    case 'link_abandoned':
      return (
        <div style={wrap}>
          <p style={{ fontSize: 14.5, fontWeight: 600, color: 'var(--ink)', margin: '0 0 4px' }}>
            {c.link.abandonedTitle}
          </p>
          <p style={{ fontSize: 13, color: 'var(--muted)', margin: '0 0 12px', lineHeight: 1.5 }}>
            {c.link.abandonedBody}
          </p>
          <button
            type="button"
            className="btn btn--accent btn--sm"
            onClick={() => dispatch({ type: 'RESUME_LINK' })}
          >
            {c.link.resumeCta}
          </button>
        </div>
      )
    case 'link_exchange':
      return <div style={wrap}>{busyLine(c.link.starting)}</div>
    case 'kyc_form':
    case 'kyc_address_sync':
    case 'kyc_submitting': {
      const mode: KycFormMode = view.step === 'kyc_form' ? view.mode : 'l1'
      const busy = view.step !== 'kyc_form'
      return (
        <div style={wrap}>
          <KycForm
            // Keyed on mode so a step-up re-entry gets a fresh prefill read;
            // within one mode the form keeps its local state across the
            // busy → invalid round-trip.
            key={mode}
            mode={mode}
            prefill={ctx.prefill}
            invalid={view.step === 'kyc_form' && view.invalid}
            notice={view.step === 'kyc_form' ? view.notice : null}
            busy={busy}
            onSubmit={(values, edited) => {
              pendingKycRef.current = { values, mode }
              dispatch({ type: 'KYC_SUBMIT', values, addressEdited: edited })
            }}
          />
        </div>
      )
    }
    case 'kyc_polling':
      return (
        <div style={wrap}>
          {busyLine(c.kyc.verifying)}
          {view.timedOut && (
            <p style={{ fontSize: 13, color: 'var(--muted)', margin: '8px 0 0', lineHeight: 1.5 }}>
              {c.kyc.verifyTimeout}
            </p>
          )}
        </div>
      )
    case 'kyc_docs':
      return (
        <div style={wrap}>
          <p style={{ fontSize: 14.5, fontWeight: 600, color: 'var(--ink)', margin: '0 0 4px' }}>
            {c.kyc.docsTitle}
          </p>
          <p style={{ fontSize: 13, color: 'var(--muted)', margin: '0 0 12px', lineHeight: 1.5 }}>
            {view.abandoned ? c.kyc.docsAbandoned : c.kyc.docsBody}
          </p>
          {view.abandoned && (
            <button
              type="button"
              className="btn btn--accent btn--sm"
              onClick={() => dispatch({ type: 'START_DOCS' })}
            >
              {c.kyc.docsCta}
            </button>
          )}
        </div>
      )
    case 'relaying':
      return <div style={wrap}>{busyLine(c.relay.verifying)}</div>
    case 'relay_form':
      return (
        <div style={wrap}>
          <RelayForm
            key={view.reason}
            reason={view.reason}
            invalid={view.invalid}
            onSubmit={(values) => dispatch({ type: 'RELAY_FORM_SUBMIT', values })}
          />
        </div>
      )
    case 'bridge_polling':
    case 'bridge_rejection':
      return (
        <div style={wrap}>
          <BridgeKycCard variant="waiting" busy={false} />
        </div>
      )
    case 'bridge_wait':
      return (
        <div style={wrap}>
          <BridgeKycCard variant="wait" busy={false} onContinue={() => dispatch({ type: 'BRIDGE_RECHECK' })} />
        </div>
      )
    case 'bridge_persona':
      return (
        <div style={wrap}>
          <BridgeKycCard variant="persona" busy={false} onContinue={() => dispatch({ type: 'START_PERSONA' })} />
        </div>
      )
    case 'collect':
      return (
        <div style={wrap}>
          <p style={{ fontSize: 14.5, fontWeight: 600, color: 'var(--ink)', margin: '0 0 4px' }}>
            {c.collect.title}
          </p>
          <p style={{ fontSize: 13, color: 'var(--muted)', margin: '0 0 10px', lineHeight: 1.5 }}>
            {c.collect.debitNote} {c.kyc.achRequiresDocs}
          </p>
          {view.notice === 'restart' && (
            <p role="alert" style={{ color: 'var(--color-error)', fontSize: 13, margin: '0 0 10px' }}>
              {c.errors.restartPayment}
            </p>
          )}
          {view.notice === 'reauth' && (
            <p role="alert" style={{ color: 'var(--color-error)', fontSize: 13, margin: '0 0 10px' }}>
              {c.link.reauthNote}
            </p>
          )}
          <SdkElementHost element={collectElement} />
        </div>
      )
    case 'session_create':
      return <div style={wrap}>{busyLine(c.pay.creatingSession)}</div>
    case 'checkout':
      return <div style={wrap}>{busyLine(c.pay.startingCheckout)}</div>
    case 'submitted':
      return titledCard(s.pay.submittedTitle, s.pay.submittedBody)
    case 'failed': {
      if (view.kind === 'kyc_rejected') {
        return titledCard(c.kyc.rejectedTitle, c.kyc.rejectedBody)
      }
      if (view.kind === 'duplicate_identity') {
        return (
          <div style={wrap}>
            <BridgeKycCard variant="duplicate" busy={false} />
          </div>
        )
      }
      if (view.kind === 'unsupported') {
        return errorCard(t.send.errors.funding_unsupported, false)
      }
      if (view.kind === 'link_declined') {
        return (
          <div style={wrap}>
            <p style={{ fontSize: 13, color: 'var(--muted)', margin: '0 0 12px', lineHeight: 1.5 }}>
              {c.link.declined}
            </p>
            <button
              type="button"
              className="btn btn--accent btn--sm"
              onClick={() => dispatch({ type: 'RETRY' })}
            >
              {c.errors.retryCta}
            </button>
          </div>
        )
      }
      return errorCard(t.send.errors.generic, true)
    }
  }
}
