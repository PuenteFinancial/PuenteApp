// Pure state machine for the embedded-components pay surface (K5) — the
// payStep.ts convention taken further: EVERY transition, step-up re-entry,
// error classification, and funnel capture lives here as data, so the whole
// flow is unit-testable without a DOM or the Stripe SDK.
//
// The component (CryptoPayStep.tsx) is a thin host: it dispatches events,
// executes the returned `effects` (fetches against our /api, SDK calls), and
// fires the returned `captures` into PostHog. It never decides anything.
//
// PII rule (decision 3, ratified 2026-08-27): SSN and DOB go client → Stripe
// SDK ONLY. The only builders allowed to produce bodies for OUR /api are the
// build*Body/buildAddressPatch functions below, and a test feeds full KYC
// form values (SSN, DOB) through every one of them asserting no such field
// survives. buildKycInfo is the single deliberate exception: its output goes
// to onramp.submitKycInfo, never to fetch.

// ── Wire shapes ─────────────────────────────────────────────────────────────

/** Subset of GET /api/users/me the crypto pay step needs. */
export interface CryptoPrefill {
  firstName: string | null
  lastName: string | null
  email: string | null
  phone: string
  addressLine1: string | null
  addressLine2: string | null
  addressCity: string | null
  addressState: string | null
  addressPostalCode: string | null
  bridgeCustomerId: string | null
  /** Bridge-side status — drives the Persona fallback branch only. */
  kycStatus: string
}

/** One entry of the crypto customer's verifications array (preview API — the
 *  exact vocabulary is unpinned, so every reader below is defensive). */
export interface CryptoVerification {
  type: string
  status: string
}

export interface KycFormValues {
  firstName: string
  lastName: string
  addressLine1: string
  addressLine2: string
  city: string
  state: string
  postalCode: string
  dobMonth: string
  dobDay: string
  dobYear: string
  ssn: string
}

/** l0 = minimum identity (name + address); l1 = adds DOB + SSN. The first
 *  pass renders the combined l1 form (solution-plan Option A — one
 *  submitKycInfo, no L0→L1 ping-pong); l0 exists for the step-up where the
 *  400 names only the minimum tier. */
export type KycFormMode = 'l0' | 'l1'

// ── Views (discriminated on `step`) ─────────────────────────────────────────

export type FailKind = 'kyc_rejected' | 'unsupported' | 'link_declined' | 'retryable'

export type CryptoPayView =
  | { step: 'loading' }
  | { step: 'boot_error' }
  | { step: 'intro' }
  | { step: 'link_auth' }
  | { step: 'link_register' }
  | { step: 'link_verify' }
  | { step: 'link_abandoned' }
  | { step: 'link_exchange' }
  | { step: 'kyc_form'; mode: KycFormMode; invalid: boolean }
  | { step: 'kyc_address_sync' }
  | { step: 'kyc_submitting' }
  | { step: 'kyc_polling'; timedOut: boolean }
  | { step: 'kyc_docs'; abandoned: boolean }
  | { step: 'bridge_tos' }
  | { step: 'bridge_polling' }
  | { step: 'collect'; notice: 'restart' | 'reauth' | null }
  | { step: 'session_create' }
  | { step: 'checkout' }
  | { step: 'submitted' }
  | { step: 'failed'; kind: FailKind }

export interface CryptoPayContext {
  transferId: string
  prefill: CryptoPrefill | null
  authIntentId: string | null
  /** Loop guard: a second linkAccountExists=false AFTER a successful
   *  registration is a provider inconsistency, not a retry path. */
  registered: boolean
  cryptoCustomerId: string | null
  verifications: CryptoVerification[]
  paymentTokenId: string | null
  paymentMethodType: 'card' | 'us_bank_account' | null
  sessionId: string | null
  /** Pending step-up: which form the 400 demanded, and which call to resume
   *  once the poll shows verified. session_create keeps the cpt_ (a refused
   *  create never consumed it); checkout keeps the cos_. */
  stepUp: { form: 'l0' | 'l1' | 'docs'; resume: 'session_create' | 'checkout' } | null
  pollCount: number
  /** First sighting of bridgeCustomerId during bridge polling → the
   *  send_bridge_tos_accepted capture fires exactly once. */
  bridgeCustomerSeen: boolean
}

export interface CryptoPayState {
  view: CryptoPayView
  ctx: CryptoPayContext
}

// ── Effects (executed by the component, never by the reducer) ───────────────

export type CryptoPayEffect =
  | { kind: 'boot' }
  | { kind: 'create_intent' }
  | { kind: 'sdk_register' }
  | { kind: 'sdk_authenticate'; authIntentId: string }
  | { kind: 'exchange_and_customer'; authIntentId: string; cryptoCustomerId: string }
  | { kind: 'patch_address'; body: Record<string, string> }
  | { kind: 'sdk_submit_kyc'; values: KycFormValues; mode: KycFormMode }
  | { kind: 'poll_kyc' }
  | { kind: 'sdk_verify_documents' }
  | { kind: 'bridge_redirect' }
  | { kind: 'poll_users_me' }
  | { kind: 'sdk_collect' }
  | { kind: 'create_session'; body: { paymentTokenId: string } }
  | { kind: 'sdk_checkout'; sessionId: string }

export interface FunnelCapture {
  event: string
  props: Record<string, string | number>
}

export interface Transition {
  state: CryptoPayState
  effects: CryptoPayEffect[]
  captures: FunnelCapture[]
}

// ── Events ──────────────────────────────────────────────────────────────────

/** Classified API error (classifyCryptoApiError output). */
export interface CryptoApiFailure {
  status: number
  code: string | null
  /** details[0].issue on kyc_required — the exact Stripe step-up code. */
  issue: string | null
}

export type CryptoPayEvent =
  | {
      type: 'BOOT_OK'
      prefill: CryptoPrefill
      /** null = no crypto customer yet (404) or token revoked (409): the
       *  full Link flow runs either way. */
      kyc: { cryptoCustomerId: string; verifications: CryptoVerification[] } | null
    }
  | { type: 'BOOT_FAILED' }
  | { type: 'CONTINUE' }
  | { type: 'INTENT_OK'; authIntentId: string; linkAccountExists: boolean }
  | { type: 'INTENT_FAILED' }
  | { type: 'REGISTER_OK' }
  | { type: 'REGISTER_FAILED' }
  | { type: 'AUTH_RESULT'; result: 'success' | 'abandoned' | 'declined'; cryptoCustomerId?: string }
  | { type: 'AUTH_FAILED' }
  | { type: 'RESUME_LINK' }
  | { type: 'EXCHANGE_OK'; verifications: CryptoVerification[] }
  | { type: 'EXCHANGE_FAILED' }
  | { type: 'KYC_SUBMIT'; values: KycFormValues; addressEdited: boolean }
  | { type: 'KYC_INVALID' }
  | { type: 'ADDRESS_SYNCED'; values: KycFormValues; mode: KycFormMode }
  | { type: 'ADDRESS_SYNC_FAILED' }
  | { type: 'KYC_SUBMITTED' }
  | { type: 'KYC_SUBMIT_FAILED' }
  | { type: 'KYC_POLL_RESULT'; verifications: CryptoVerification[] }
  | { type: 'KYC_POLL_FAILED' }
  | { type: 'RETRY_POLL' }
  | { type: 'START_DOCS' }
  | { type: 'DOCS_RESULT'; result: 'success' | 'abandoned' }
  | { type: 'DOCS_FAILED' }
  | { type: 'BRIDGE_CONTINUE' }
  | { type: 'BRIDGE_REDIRECT_FAILED' }
  | { type: 'USERS_ME_RESULT'; bridgeCustomerId: string | null; kycStatus: string }
  | { type: 'USERS_ME_FAILED' }
  | {
      type: 'PM_COLLECTED'
      cryptoPaymentToken: string
      methodType: 'card' | 'us_bank_account'
      cardFunding: string | null
      wallet: string | null
    }
  | { type: 'COLLECT_FAILED' }
  | { type: 'SESSION_OK'; sessionId: string }
  | { type: 'SESSION_ERROR'; failure: CryptoApiFailure }
  | { type: 'CHECKOUT_OK'; successful: boolean }
  | { type: 'CHECKOUT_ERROR'; failure: CryptoApiFailure }
  | { type: 'RETRY' }

// ── Timing constants (the component schedules; the reducer counts) ──────────

/** KYC resolves in seconds (SA doc: L0 6-7s, L1 5s, L2 25s; poll 2-3s). */
export const KYC_POLL_MS = 2_500
/** Ticks before the polling view flips to its soft-timeout copy (~90s). */
export const KYC_POLL_TIMEOUT_TICKS = 36
export const BRIDGE_POLL_MS = 3_000

// ── Verification readers (defensive: preview API vocabulary is unpinned) ────

type KycOutcome = 'verified' | 'rejected' | 'pending' | 'not_started'

const VERIFIED_STATUSES = new Set(['verified', 'approved', 'active'])
const REJECTED_STATUSES = new Set(['rejected', 'failed', 'canceled'])

/** The identity (L0/L1) entry: type mentions kyc/identity but not document. */
function identityEntry(verifications: CryptoVerification[]): CryptoVerification | undefined {
  return verifications.find(
    (v) => !v.type.includes('document') && (v.type.includes('kyc') || v.type.includes('identity')),
  )
}

function documentEntry(verifications: CryptoVerification[]): CryptoVerification | undefined {
  return verifications.find((v) => v.type.includes('document'))
}

export function kycOutcomeFor(verifications: CryptoVerification[]): KycOutcome {
  const entry = identityEntry(verifications)
  if (!entry) return 'not_started'
  if (VERIFIED_STATUSES.has(entry.status)) return 'verified'
  if (REJECTED_STATUSES.has(entry.status)) return 'rejected'
  if (entry.status === 'not_started') return 'not_started'
  return 'pending'
}

/** Display tier for the send_kyc_verified capture — mirrors the server's
 *  cache derivation (L2 when a verified entry's type mentions document). */
export function kycTierFor(verifications: CryptoVerification[]): 'L1' | 'L2' {
  const doc = documentEntry(verifications)
  return doc && VERIFIED_STATUSES.has(doc.status) ? 'L2' : 'L1'
}

// ── API-bound payload builders (THE SSN/DOB GUARD SURFACE) ─────────────────
// Every body this client sends to our own /api is built here and nowhere
// else. cryptoPayStep.test.ts feeds full KYC values (SSN, DOB) through each
// builder and asserts the serialized output never matches the PII pattern.

export function buildAddressPatch(
  prefill: CryptoPrefill,
  values: KycFormValues,
): Record<string, string> {
  return {
    // PATCH /users/me requires the name+email trio; names come from the form
    // (the KYC form is also allowed to fix a typo'd legal name), email is not
    // a form field and rides from the profile.
    firstName: values.firstName,
    lastName: values.lastName,
    email: prefill.email ?? '',
    // All-or-none address group (K2).
    addressLine1: values.addressLine1,
    ...(values.addressLine2 ? { addressLine2: values.addressLine2 } : {}),
    addressCity: values.city,
    addressState: values.state,
    addressPostalCode: values.postalCode,
  }
}

export function buildExchangeBody(authIntentId: string): Record<string, string> {
  return { authIntentId }
}

export function buildCustomerBody(cryptoCustomerId: string): Record<string, string> {
  return { customerId: cryptoCustomerId }
}

export function buildSessionCreateBody(paymentTokenId: string): { paymentTokenId: string } {
  return { paymentTokenId }
}

export function buildCheckoutBody(
  sessionId: string,
  paymentMethodType: 'card' | 'us_bank_account',
): { sessionId: string; paymentMethodType: string } {
  return { sessionId, paymentMethodType }
}

// ── SDK payload builder (client → Stripe ONLY — never fetch this) ──────────

export interface SdkKycInfo {
  given_name: string
  surname: string
  address: {
    line1: string
    line2?: string
    city: string
    state: string
    postal_code: string
    country: 'US'
  }
  id_number?: { type: 'us_ssn'; value: string }
  date_of_birth?: { day: number; month: number; year: number }
}

export function buildKycInfo(values: KycFormValues, mode: KycFormMode): SdkKycInfo {
  return {
    given_name: values.firstName,
    surname: values.lastName,
    address: {
      line1: values.addressLine1,
      ...(values.addressLine2 ? { line2: values.addressLine2 } : {}),
      city: values.city,
      state: values.state,
      postal_code: values.postalCode,
      country: 'US',
    },
    // The l0 step-up asked for minimum identity only — omitting id_number and
    // date_of_birth there means the user is never asked for an SSN a tier
    // didn't demand.
    ...(mode === 'l1'
      ? {
          id_number: { type: 'us_ssn' as const, value: values.ssn },
          date_of_birth: {
            day: Number(values.dobDay),
            month: Number(values.dobMonth),
            year: Number(values.dobYear),
          },
        }
      : {}),
  }
}

// ── Form validation (sanity only — Stripe is the authority) ────────────────

export function invalidKycFields(values: KycFormValues, mode: KycFormMode): string[] {
  const bad: string[] = []
  if (!values.firstName.trim()) bad.push('firstName')
  if (!values.lastName.trim()) bad.push('lastName')
  if (!values.addressLine1.trim()) bad.push('addressLine1')
  if (!values.city.trim()) bad.push('city')
  if (!/^[A-Z]{2}$/.test(values.state)) bad.push('state')
  if (!/^[0-9]{5}(-[0-9]{4})?$/.test(values.postalCode)) bad.push('postalCode')
  if (mode === 'l1') {
    const month = Number(values.dobMonth)
    const day = Number(values.dobDay)
    const year = Number(values.dobYear)
    if (!Number.isInteger(month) || month < 1 || month > 12) bad.push('dobMonth')
    if (!Number.isInteger(day) || day < 1 || day > 31) bad.push('dobDay')
    if (!Number.isInteger(year) || year < 1900 || year > 2100) bad.push('dobYear')
    if (!/^[0-9]{9}$/.test(values.ssn.replace(/-/g, ''))) bad.push('ssn')
  }
  return bad
}

export function addressEdited(prefill: CryptoPrefill, values: KycFormValues): boolean {
  return (
    values.addressLine1 !== (prefill.addressLine1 ?? '') ||
    values.addressLine2 !== (prefill.addressLine2 ?? '') ||
    values.city !== (prefill.addressCity ?? '') ||
    values.state !== (prefill.addressState ?? '') ||
    values.postalCode !== (prefill.addressPostalCode ?? '')
  )
}

// ── Error classification ────────────────────────────────────────────────────

export function classifyCryptoApiError(status: number, body: unknown): CryptoApiFailure {
  let code: string | null = null
  let issue: string | null = null
  if (typeof body === 'object' && body !== null) {
    const err = (body as { error?: unknown }).error
    if (typeof err === 'object' && err !== null) {
      const e = err as { code?: unknown; details?: unknown }
      if (typeof e.code === 'string') code = e.code
      if (Array.isArray(e.details)) {
        const first = e.details[0] as { issue?: unknown } | undefined
        if (first && typeof first.issue === 'string') issue = first.issue
      }
    }
  }
  return { status, code, issue }
}

/** Stripe step-up code → which form re-enters. */
export function stepUpFormFor(issue: string | null): 'l0' | 'l1' | 'docs' | null {
  if (issue === 'crypto_onramp_missing_minimum_identity_verification') return 'l0'
  if (issue === 'crypto_onramp_missing_identity_verification') return 'l1'
  if (issue === 'crypto_onramp_missing_document_verification') return 'docs'
  return null
}

// ── Limits pre-check (deliberately unpinned response — parse or bail) ──────

/** Best-effort read of GET /api/crypto/limits. null = show the generic
 *  expectation copy; a value renders the limitLine. The shape is a preview
 *  API unknown, so this probes the two plausible spellings and refuses
 *  anything else — narrowing it further is post-smoke work (K3 note). */
export function parseLimits(body: unknown): { maxUsd: number } | null {
  if (typeof body !== 'object' || body === null) return null
  const limits = (body as { limits?: unknown }).limits
  if (typeof limits !== 'object' || limits === null) return null
  const l = limits as Record<string, unknown>
  const candidate = l.max_transaction_amount ?? l.transaction_maximum ?? null
  const n = typeof candidate === 'string' ? Number(candidate) : candidate
  if (typeof n === 'number' && Number.isFinite(n) && n > 0) return { maxUsd: n }
  return null
}

// ── The machine ─────────────────────────────────────────────────────────────

export function initialCryptoPayState(transferId: string): CryptoPayState {
  return {
    view: { step: 'loading' },
    ctx: {
      transferId,
      prefill: null,
      authIntentId: null,
      registered: false,
      cryptoCustomerId: null,
      verifications: [],
      paymentTokenId: null,
      paymentMethodType: null,
      sessionId: null,
      stepUp: null,
      pollCount: 0,
      bridgeCustomerSeen: false,
    },
  }
}

export function initialEffects(): CryptoPayEffect[] {
  return [{ kind: 'boot' }]
}

function cap(ctx: CryptoPayContext, event: string, props: Record<string, string | number> = {}): FunnelCapture {
  return { event, props: { transfer_id: ctx.transferId, ...props } }
}

/** Resume-at-right-step: a reload (or the Bridge return leg) reconstructs the
 *  position from server truth instead of trusting any client memory. */
function stepAfterBoot(ctx: CryptoPayContext): Transition {
  const { prefill, verifications, cryptoCustomerId } = ctx
  if (!cryptoCustomerId) {
    return { state: { view: { step: 'intro' }, ctx }, effects: [], captures: [] }
  }
  const outcome = kycOutcomeFor(verifications)
  if (outcome === 'rejected') {
    return {
      state: { view: { step: 'failed', kind: 'kyc_rejected' }, ctx },
      effects: [],
      captures: [cap(ctx, 'send_kyc_rejected', { code: 'boot_rejected' })],
    }
  }
  if (outcome === 'not_started' || outcome === 'pending') {
    // pending at boot: a submission may be mid-verify — polling is the safe
    // landing (it flows to the form when the outcome regresses). not_started
    // goes straight to the combined form: the token is stored, no Link UI.
    if (outcome === 'pending') {
      return {
        state: { view: { step: 'kyc_polling', timedOut: false }, ctx },
        effects: [{ kind: 'poll_kyc' }],
        captures: [],
      }
    }
    return {
      state: { view: { step: 'kyc_form', mode: 'l1', invalid: false }, ctx },
      effects: [],
      captures: [cap(ctx, 'send_kyc_form_viewed', { mode: 'l1' })],
    }
  }
  return afterStripeKycVerified(ctx)
}

/** Where a verified Stripe KYC goes next: the Persona/Bridge fallback gate
 *  (decision 2 — BEFORE payment, ratified 2026-08-28), then payment. */
function afterStripeKycVerified(ctx: CryptoPayContext): Transition {
  const prefill = ctx.prefill
  if (prefill && !prefill.bridgeCustomerId) {
    return {
      state: { view: { step: 'bridge_tos' }, ctx },
      effects: [],
      captures: [cap(ctx, 'send_bridge_fallback_started')],
    }
  }
  if (prefill && prefill.bridgeCustomerId && prefill.kycStatus === 'rejected') {
    return {
      state: { view: { step: 'failed', kind: 'kyc_rejected' }, ctx },
      effects: [],
      captures: [cap(ctx, 'send_kyc_rejected', { code: 'bridge_rejected' })],
    }
  }
  if (prefill && prefill.bridgeCustomerId && prefill.kycStatus !== 'approved') {
    return {
      state: {
        view: { step: 'bridge_polling' },
        ctx: { ...ctx, bridgeCustomerSeen: true },
      },
      effects: [{ kind: 'poll_users_me' }],
      captures: [],
    }
  }
  return {
    state: { view: { step: 'collect', notice: null }, ctx },
    effects: [{ kind: 'sdk_collect' }],
    captures: [],
  }
}

/** The KYC poll settled verified: resume a pending step-up, else continue the
 *  first-time flow. */
function afterKycVerified(ctx: CryptoPayContext, verifications: CryptoVerification[]): Transition {
  const next = { ...ctx, verifications, pollCount: 0 }
  const verifiedCap = cap(next, 'send_kyc_verified', { tier: kycTierFor(verifications) })
  if (next.stepUp?.resume === 'session_create' && next.paymentTokenId) {
    const resumed = { ...next, stepUp: null }
    return {
      state: { view: { step: 'session_create' }, ctx: resumed },
      effects: [{ kind: 'create_session', body: buildSessionCreateBody(resumed.paymentTokenId!) }],
      captures: [verifiedCap],
    }
  }
  if (next.stepUp?.resume === 'checkout' && next.sessionId) {
    const resumed = { ...next, stepUp: null }
    return {
      state: { view: { step: 'checkout' }, ctx: resumed },
      effects: [{ kind: 'sdk_checkout', sessionId: resumed.sessionId! }],
      captures: [verifiedCap],
    }
  }
  const t = afterStripeKycVerified({ ...next, stepUp: null })
  return { ...t, captures: [verifiedCap, ...t.captures] }
}

/** Shared handler for session-create and checkout failures. */
function handleMoneyCallError(
  ctx: CryptoPayContext,
  failure: CryptoApiFailure,
  resume: 'session_create' | 'checkout',
): Transition {
  if (failure.status === 400 && failure.code === 'kyc_required') {
    const form = stepUpFormFor(failure.issue)
    if (form === 'docs') {
      const next = { ...ctx, stepUp: { form, resume } }
      return {
        state: { view: { step: 'kyc_docs', abandoned: false }, ctx: next },
        effects: [{ kind: 'sdk_verify_documents' }],
        captures: [cap(next, 'send_kyc_docs_started')],
      }
    }
    if (form) {
      const next = { ...ctx, stepUp: { form, resume } }
      return {
        state: { view: { step: 'kyc_form', mode: form, invalid: false }, ctx: next },
        effects: [],
        captures: [cap(next, 'send_kyc_form_viewed', { mode: form })],
      }
    }
    // kyc_required without a recognizable issue: treat as retryable rather
    // than guessing a form the API didn't name.
    return {
      state: { view: { step: 'failed', kind: 'retryable' }, ctx },
      effects: [],
      captures: [cap(ctx, 'send_payment_failed', { code: 'kyc_required_unmapped' })],
    }
  }
  if (failure.status === 403) {
    return {
      state: { view: { step: 'failed', kind: 'unsupported' }, ctx },
      effects: [],
      captures: [cap(ctx, 'send_payment_failed', { code: 'funding_unsupported' })],
    }
  }
  if (failure.status === 409 && failure.code === 'link_auth_required') {
    // The stored token died mid-flow: back to Link auth with a fresh intent.
    // The payment attempt does not survive re-auth (recollect after).
    const next = { ...ctx, paymentTokenId: null, paymentMethodType: null, sessionId: null, stepUp: null }
    return {
      state: { view: { step: 'link_auth' }, ctx: next },
      effects: [{ kind: 'create_intent' }],
      captures: [cap(next, 'send_link_auth_started', { reason: 'reauth' })],
    }
  }
  if (failure.status === 409) {
    // Never-resume: the attempt is dead — recollect with a fresh cpt_.
    const next = { ...ctx, paymentTokenId: null, paymentMethodType: null, sessionId: null, stepUp: null }
    return {
      state: { view: { step: 'collect', notice: 'restart' }, ctx: next },
      effects: [{ kind: 'sdk_collect' }],
      captures: [cap(next, 'send_payment_failed', { code: 'conflict' })],
    }
  }
  return {
    state: { view: { step: 'failed', kind: 'retryable' }, ctx },
    effects: [],
    captures: [cap(ctx, 'send_payment_failed', { code: failure.code ?? `http_${failure.status}` })],
  }
}

export function transition(state: CryptoPayState, event: CryptoPayEvent): Transition {
  const { view, ctx } = state
  const stay = (effects: CryptoPayEffect[] = [], captures: FunnelCapture[] = []): Transition => ({
    state,
    effects,
    captures,
  })

  switch (event.type) {
    case 'BOOT_OK': {
      const next: CryptoPayContext = {
        ...ctx,
        prefill: event.prefill,
        cryptoCustomerId: event.kyc?.cryptoCustomerId ?? null,
        verifications: event.kyc?.verifications ?? [],
      }
      return stepAfterBoot(next)
    }
    case 'BOOT_FAILED':
      return { state: { view: { step: 'boot_error' }, ctx }, effects: [], captures: [] }

    case 'CONTINUE': {
      if (view.step !== 'intro') return stay()
      return {
        state: { view: { step: 'link_auth' }, ctx },
        effects: [{ kind: 'create_intent' }],
        captures: [cap(ctx, 'send_link_auth_started')],
      }
    }

    case 'INTENT_OK': {
      if (!event.linkAccountExists || !event.authIntentId) {
        if (ctx.registered) {
          // Registered moments ago and the account still doesn't resolve:
          // provider inconsistency, not a loop to retry silently.
          return {
            state: { view: { step: 'failed', kind: 'retryable' }, ctx },
            effects: [],
            captures: [cap(ctx, 'send_link_auth_failed', { outcome: 'register_loop' })],
          }
        }
        return {
          state: { view: { step: 'link_register' }, ctx },
          effects: [{ kind: 'sdk_register' }],
          captures: [],
        }
      }
      const next = { ...ctx, authIntentId: event.authIntentId }
      return {
        state: { view: { step: 'link_verify' }, ctx: next },
        effects: [{ kind: 'sdk_authenticate', authIntentId: event.authIntentId }],
        captures: [],
      }
    }
    case 'INTENT_FAILED':
      return {
        state: { view: { step: 'failed', kind: 'retryable' }, ctx },
        effects: [],
        captures: [cap(ctx, 'send_link_auth_failed', { outcome: 'intent_failed' })],
      }

    case 'REGISTER_OK': {
      const next = { ...ctx, registered: true }
      return {
        state: { view: { step: 'link_auth' }, ctx: next },
        effects: [{ kind: 'create_intent' }],
        captures: [cap(next, 'send_link_registered')],
      }
    }
    case 'REGISTER_FAILED':
      return {
        state: { view: { step: 'failed', kind: 'retryable' }, ctx },
        effects: [],
        captures: [cap(ctx, 'send_link_auth_failed', { outcome: 'register_failed' })],
      }

    case 'AUTH_RESULT': {
      if (event.result === 'success' && event.cryptoCustomerId && ctx.authIntentId) {
        const next = { ...ctx, cryptoCustomerId: event.cryptoCustomerId }
        return {
          state: { view: { step: 'link_exchange' }, ctx: next },
          effects: [
            {
              kind: 'exchange_and_customer',
              authIntentId: ctx.authIntentId,
              cryptoCustomerId: event.cryptoCustomerId,
            },
          ],
          captures: [cap(next, 'send_link_authenticated')],
        }
      }
      if (event.result === 'abandoned') {
        return {
          state: { view: { step: 'link_abandoned' }, ctx },
          effects: [],
          captures: [cap(ctx, 'send_link_auth_failed', { outcome: 'abandoned' })],
        }
      }
      return {
        state: { view: { step: 'failed', kind: 'link_declined' }, ctx },
        effects: [],
        captures: [cap(ctx, 'send_link_auth_failed', { outcome: 'declined' })],
      }
    }
    case 'AUTH_FAILED':
      return {
        state: { view: { step: 'failed', kind: 'retryable' }, ctx },
        effects: [],
        captures: [cap(ctx, 'send_link_auth_failed', { outcome: 'auth_failed' })],
      }

    case 'RESUME_LINK': {
      // A fresh intent on purpose: the abandoned modal's intent may be spent.
      return {
        state: { view: { step: 'link_auth' }, ctx },
        effects: [{ kind: 'create_intent' }],
        captures: [cap(ctx, 'send_link_auth_started', { reason: 'resume' })],
      }
    }

    case 'EXCHANGE_OK': {
      const next = { ...ctx, verifications: event.verifications }
      const created = cap(next, 'send_crypto_customer_created')
      const outcome = kycOutcomeFor(event.verifications)
      if (outcome === 'verified') {
        const t = afterStripeKycVerified(next)
        return { ...t, captures: [created, ...t.captures] }
      }
      if (outcome === 'rejected') {
        return {
          state: { view: { step: 'failed', kind: 'kyc_rejected' }, ctx: next },
          effects: [],
          captures: [created, cap(next, 'send_kyc_rejected', { code: 'exchange_rejected' })],
        }
      }
      return {
        state: { view: { step: 'kyc_form', mode: 'l1', invalid: false }, ctx: next },
        effects: [],
        captures: [created, cap(next, 'send_kyc_form_viewed', { mode: 'l1' })],
      }
    }
    case 'EXCHANGE_FAILED':
      return {
        state: { view: { step: 'failed', kind: 'retryable' }, ctx },
        effects: [],
        captures: [cap(ctx, 'send_link_auth_failed', { outcome: 'exchange_failed' })],
      }

    case 'KYC_SUBMIT': {
      if (view.step !== 'kyc_form') return stay()
      const mode = view.mode
      if (invalidKycFields(event.values, mode).length > 0) {
        return {
          state: { view: { step: 'kyc_form', mode, invalid: true }, ctx },
          effects: [],
          captures: [],
        }
      }
      if (event.addressEdited && ctx.prefill) {
        return {
          state: { view: { step: 'kyc_address_sync' }, ctx },
          effects: [{ kind: 'patch_address', body: buildAddressPatch(ctx.prefill, event.values) }],
          captures: [cap(ctx, 'send_kyc_submitted', { mode })],
        }
      }
      return {
        state: { view: { step: 'kyc_submitting' }, ctx },
        effects: [{ kind: 'sdk_submit_kyc', values: event.values, mode }],
        captures: [cap(ctx, 'send_kyc_submitted', { mode })],
      }
    }
    case 'KYC_INVALID': {
      if (view.step !== 'kyc_form') return stay()
      return {
        state: { view: { step: 'kyc_form', mode: view.mode, invalid: true }, ctx },
        effects: [],
        captures: [],
      }
    }

    case 'ADDRESS_SYNCED': {
      // Refresh the prefill so a later re-render (or re-edit) compares
      // against what is now stored.
      const p = ctx.prefill
      const next = p
        ? {
            ...ctx,
            prefill: {
              ...p,
              firstName: event.values.firstName,
              lastName: event.values.lastName,
              addressLine1: event.values.addressLine1,
              addressLine2: event.values.addressLine2 || null,
              addressCity: event.values.city,
              addressState: event.values.state,
              addressPostalCode: event.values.postalCode,
            },
          }
        : ctx
      return {
        state: { view: { step: 'kyc_submitting' }, ctx: next },
        effects: [{ kind: 'sdk_submit_kyc', values: event.values, mode: event.mode }],
        captures: [],
      }
    }
    case 'ADDRESS_SYNC_FAILED': {
      // The all-or-none PATCH refused (per-field details) — back to the form.
      const mode = ctx.stepUp?.form === 'l0' ? 'l0' : 'l1'
      return {
        state: { view: { step: 'kyc_form', mode, invalid: true }, ctx },
        effects: [],
        captures: [],
      }
    }

    case 'KYC_SUBMITTED': {
      const next = { ...ctx, pollCount: 0 }
      return {
        state: { view: { step: 'kyc_polling', timedOut: false }, ctx: next },
        effects: [{ kind: 'poll_kyc' }],
        captures: [],
      }
    }
    case 'KYC_SUBMIT_FAILED': {
      const mode = ctx.stepUp?.form === 'l0' ? 'l0' : 'l1'
      return {
        state: { view: { step: 'kyc_form', mode, invalid: true }, ctx },
        effects: [],
        captures: [cap(ctx, 'send_kyc_rejected', { code: 'submit_failed' })],
      }
    }

    case 'KYC_POLL_RESULT': {
      if (view.step !== 'kyc_polling') return stay()
      const outcome = kycOutcomeFor(event.verifications)
      if (outcome === 'verified') return afterKycVerified(ctx, event.verifications)
      if (outcome === 'rejected') {
        const next = { ...ctx, verifications: event.verifications }
        return {
          state: { view: { step: 'failed', kind: 'kyc_rejected' }, ctx: next },
          effects: [],
          captures: [cap(next, 'send_kyc_rejected', { code: 'verification_rejected' })],
        }
      }
      const next = { ...ctx, verifications: event.verifications, pollCount: ctx.pollCount + 1 }
      return {
        state: {
          view: { step: 'kyc_polling', timedOut: next.pollCount >= KYC_POLL_TIMEOUT_TICKS },
          ctx: next,
        },
        effects: [{ kind: 'poll_kyc' }],
        captures: [],
      }
    }
    case 'KYC_POLL_FAILED': {
      if (view.step !== 'kyc_polling') return stay()
      // Transient read failure: keep polling — the timeout copy is the vent.
      const next = { ...ctx, pollCount: ctx.pollCount + 1 }
      return {
        state: {
          view: { step: 'kyc_polling', timedOut: next.pollCount >= KYC_POLL_TIMEOUT_TICKS },
          ctx: next,
        },
        effects: [{ kind: 'poll_kyc' }],
        captures: [],
      }
    }
    case 'RETRY_POLL': {
      if (view.step !== 'kyc_polling') return stay()
      const next = { ...ctx, pollCount: 0 }
      return {
        state: { view: { step: 'kyc_polling', timedOut: false }, ctx: next },
        effects: [{ kind: 'poll_kyc' }],
        captures: [],
      }
    }

    case 'START_DOCS': {
      if (view.step !== 'kyc_docs') return stay()
      return {
        state: { view: { step: 'kyc_docs', abandoned: false }, ctx },
        effects: [{ kind: 'sdk_verify_documents' }],
        captures: [cap(ctx, 'send_kyc_docs_started')],
      }
    }
    case 'DOCS_RESULT': {
      const done = cap(ctx, 'send_kyc_docs_completed', { result: event.result })
      if (event.result === 'abandoned') {
        return {
          state: { view: { step: 'kyc_docs', abandoned: true }, ctx },
          effects: [],
          captures: [done],
        }
      }
      const next = { ...ctx, pollCount: 0 }
      return {
        state: { view: { step: 'kyc_polling', timedOut: false }, ctx: next },
        effects: [{ kind: 'poll_kyc' }],
        captures: [done],
      }
    }
    case 'DOCS_FAILED':
      return {
        state: { view: { step: 'kyc_docs', abandoned: true }, ctx },
        effects: [],
        captures: [cap(ctx, 'send_kyc_docs_completed', { result: 'failed' })],
      }

    case 'BRIDGE_CONTINUE': {
      if (view.step !== 'bridge_tos' && view.step !== 'bridge_polling') return stay()
      // The effect sets the kyc_next cookie and navigates away — no state to
      // keep; the return leg reboots the machine and lands via stepAfterBoot.
      return stay([{ kind: 'bridge_redirect' }])
    }
    case 'BRIDGE_REDIRECT_FAILED':
      return {
        state: { view: { step: 'failed', kind: 'retryable' }, ctx },
        effects: [],
        captures: [cap(ctx, 'send_payment_failed', { code: 'bridge_redirect_failed' })],
      }
    case 'USERS_ME_RESULT': {
      if (view.step !== 'bridge_polling') return stay()
      const firstSighting = !ctx.bridgeCustomerSeen && event.bridgeCustomerId !== null
      const next = {
        ...ctx,
        bridgeCustomerSeen: ctx.bridgeCustomerSeen || event.bridgeCustomerId !== null,
        prefill: ctx.prefill
          ? { ...ctx.prefill, bridgeCustomerId: event.bridgeCustomerId, kycStatus: event.kycStatus }
          : ctx.prefill,
      }
      const sight = firstSighting ? [cap(next, 'send_bridge_tos_accepted')] : []
      if (event.bridgeCustomerId && event.kycStatus === 'approved') {
        return {
          state: { view: { step: 'collect', notice: null }, ctx: next },
          effects: [{ kind: 'sdk_collect' }],
          captures: [...sight, cap(next, 'send_bridge_kyc_approved')],
        }
      }
      if (event.bridgeCustomerId && event.kycStatus === 'rejected') {
        return {
          state: { view: { step: 'failed', kind: 'kyc_rejected' }, ctx: next },
          effects: [],
          captures: [...sight, cap(next, 'send_kyc_rejected', { code: 'bridge_rejected' })],
        }
      }
      return {
        state: { view: { step: 'bridge_polling' }, ctx: next },
        effects: [{ kind: 'poll_users_me' }],
        captures: sight,
      }
    }
    case 'USERS_ME_FAILED': {
      if (view.step !== 'bridge_polling') return stay()
      return stay([{ kind: 'poll_users_me' }])
    }

    case 'PM_COLLECTED': {
      const next: CryptoPayContext = {
        ...ctx,
        paymentTokenId: event.cryptoPaymentToken,
        paymentMethodType: event.methodType,
      }
      return {
        state: { view: { step: 'session_create' }, ctx: next },
        effects: [{ kind: 'create_session', body: buildSessionCreateBody(event.cryptoPaymentToken) }],
        captures: [
          cap(next, 'send_payment_method_collected', {
            type: event.methodType,
            ...(event.cardFunding ? { funding: event.cardFunding } : {}),
            ...(event.wallet ? { wallet: event.wallet } : {}),
          }),
        ],
      }
    }
    case 'COLLECT_FAILED':
      return {
        state: { view: { step: 'failed', kind: 'retryable' }, ctx },
        effects: [],
        captures: [cap(ctx, 'send_payment_failed', { code: 'collect_failed' })],
      }

    case 'SESSION_OK': {
      const next = { ...ctx, sessionId: event.sessionId }
      return {
        state: { view: { step: 'checkout' }, ctx: next },
        effects: [{ kind: 'sdk_checkout', sessionId: event.sessionId }],
        captures: [],
      }
    }
    case 'SESSION_ERROR':
      return handleMoneyCallError(ctx, event.failure, 'session_create')

    case 'CHECKOUT_OK': {
      if (event.successful) {
        return {
          state: { view: { step: 'submitted' }, ctx },
          effects: [],
          captures: [cap(ctx, 'send_payment_submitted')],
        }
      }
      // Unsuccessful without an error: dead attempt, never claim a charge.
      const next = { ...ctx, paymentTokenId: null, paymentMethodType: null, sessionId: null }
      return {
        state: { view: { step: 'collect', notice: 'restart' }, ctx: next },
        effects: [{ kind: 'sdk_collect' }],
        captures: [cap(next, 'send_payment_failed', { code: 'checkout_unsuccessful' })],
      }
    }
    case 'CHECKOUT_ERROR':
      return handleMoneyCallError(ctx, event.failure, 'checkout')

    case 'RETRY': {
      // Full reboot on purpose: stepAfterBoot reconstructs the position from
      // server truth, which is simpler and safer than resuming a guessed one.
      if (view.step !== 'failed' && view.step !== 'boot_error') return stay()
      return {
        state: initialCryptoPayState(ctx.transferId),
        effects: initialEffects(),
        captures: [],
      }
    }

    default:
      return stay()
  }
}
