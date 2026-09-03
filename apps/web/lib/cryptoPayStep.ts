// Pure state machine for the embedded-components pay surface (K5) — the
// payStep.ts convention taken further: EVERY transition, step-up re-entry,
// error classification, and funnel capture lives here as data, so the whole
// flow is unit-testable without a DOM or the Stripe SDK.
//
// The component (CryptoPayStep.tsx) is a thin host: it dispatches events,
// executes the returned `effects` (fetches against our /api, SDK calls), and
// fires the returned `captures` into PostHog. It never decides anything.
//
// PII rule (decision 3, ratified 2026-08-27; degrade clause invoked
// 2026-09-02): the tax ID and DOB go client → Stripe SDK, and ONCE through
// our API to Bridge (relay-never-persist). The only builders allowed to
// produce bodies for OUR /api are the build*Body/buildAddressPatch functions
// below, and a test feeds full KYC form values (tax ID, DOB) through every
// one of them asserting no such field survives. Exactly two exceptions are
// sanctioned, and the guard test asserts both DO carry the values:
//   • buildKycInfo → onramp.submitKycInfo (client → Stripe SDK only)
//   • buildRelayBody → the `relay` effect → POST /api/users/me/bridge-customer
// The values live in exactly one ctx field (`relayValues`) between the form
// and the relay, and are nulled the moment the relay answers.

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
  /** Bridge-side status — drives the post-relay polling and the Persona
   *  fallback branch. */
  kycStatus: string
  /** The current Bridge ToS version is on file (consents.bridge_tos). The
   *  ToS-first gate (K6 decision 1) is skipped when true. */
  bridgeTosAccepted: boolean
}

/** One entry of the crypto customer's verifications array (preview API — the
 *  exact vocabulary is unpinned, so every reader below is defensive). */
export interface CryptoVerification {
  type: string
  status: string
}

export type TaxIdType = 'ssn' | 'itin'

/** The two values Bridge needs that Stripe does not share: DOB and the tax
 *  ID. Rendered by the KYC form (first pass) and by the two-field re-entry
 *  form (reload edge / Bridge correction, K6 decision 12). */
export interface IdentityFormValues {
  dobMonth: string
  dobDay: string
  dobYear: string
  taxId: string
  taxIdType: TaxIdType
}

export interface KycFormValues extends IdentityFormValues {
  firstName: string
  lastName: string
  addressLine1: string
  addressLine2: string
  city: string
  state: string
  postalCode: string
}

/** Normalized identity values held between the KYC form and the relay. THE
 *  ONE PII-carrying context field; nulled after RELAY_OK/RELAY_ERROR, on a
 *  Stripe rejection, and by RETRY (fresh initial state). */
export interface RelayValues {
  /** YYYY-MM-DD */
  dob: string
  taxIdType: TaxIdType
  /** 9 digits, dashes stripped. */
  taxId: string
}

/** Wire body of POST /api/users/me/bridge-customer (mirrors the API's
 *  relayBodySchema — the only route schema that names these fields). */
export interface RelayBody {
  dob: string
  taxId: { type: TaxIdType; number: string }
}

/** l0 = minimum identity (name + address); l1 = adds DOB + tax ID. The first
 *  pass renders the combined l1 form (solution-plan Option A — one
 *  submitKycInfo, no L0→L1 ping-pong); l0 exists for the step-up where the
 *  400 names only the minimum tier. */
export type KycFormMode = 'l0' | 'l1'

// ── Views (discriminated on `step`) ─────────────────────────────────────────

export type FailKind =
  | 'kyc_rejected'
  | 'unsupported'
  | 'link_declined'
  | 'retryable'
  /** Bridge already holds a verification for this tax ID (decision 9: hard
   *  stop, support route, never auto-link). */
  | 'duplicate_identity'

export type CryptoPayView =
  | { step: 'loading' }
  | { step: 'boot_error' }
  | { step: 'intro' }
  /** Bridge's standalone ToS click-through, BEFORE Link auth (decision 1). */
  | { step: 'bridge_tos' }
  | { step: 'link_auth' }
  | { step: 'link_register' }
  | { step: 'link_verify' }
  | { step: 'link_abandoned' }
  | { step: 'link_exchange' }
  /** `notice: 'rejected'` = Stripe refused the first L1 attempt and this is
   *  the one correction (decision 4). */
  | { step: 'kyc_form'; mode: KycFormMode; invalid: boolean; notice: 'rejected' | null }
  | { step: 'kyc_address_sync' }
  | { step: 'kyc_submitting' }
  | { step: 'kyc_polling'; timedOut: boolean }
  | { step: 'kyc_docs'; abandoned: boolean }
  /** POST relay in flight. */
  | { step: 'relaying' }
  /** The two-field re-entry form: `reload` = verified but the in-memory
   *  values are gone (page reload); `correction` = Bridge 422'd the create. */
  | { step: 'relay_form'; reason: 'reload' | 'correction'; invalid: boolean }
  /** Bounded poll of GET /users/me for Bridge's verdict. */
  | { step: 'bridge_polling' }
  /** Bridge rejected; fetching the reasons to pick Persona vs terminal. */
  | { step: 'bridge_rejection' }
  /** The hosted-KYC fallback offer. null retries = the rejection detail
   *  could not be read; offered anyway (the server bounds retries). */
  | { step: 'bridge_persona'; retriesRemaining: number | null }
  /** Past the poll bound or on manual review: come back later. */
  | { step: 'bridge_wait' }
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
  /** Shared by the Stripe KYC poll and the Bridge poll — they never overlap
   *  (afterKycVerified resets it before the Bridge leg starts). */
  pollCount: number
  /** THE ONE PII-carrying field. See the header comment. */
  relayValues: RelayValues | null
  /** The single Stripe L1 correction (decision 4) has been spent. */
  correctionUsed: boolean
  /** The treasury wallet is registered on this customer (ccw_ exists), so
   *  session create will be accepted. Survives step-up round-trips. */
  walletRegistered: boolean
  /** Whether an SDK failure has already sent us back through Link auth once.
   *  The SDK's session can lapse mid-flow (it is not our OAuth token), and
   *  re-authenticating is the actual remedy — but only once, so a genuinely
   *  broken collect can't loop the sender forever. */
  sdkReauthed: boolean
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
  /** Sanctioned PII carrier #1: client → Stripe SDK only. */
  | { kind: 'sdk_submit_kyc'; values: KycFormValues; mode: KycFormMode }
  | { kind: 'poll_kyc' }
  | { kind: 'sdk_verify_documents' }
  /** Sanctioned PII carrier #2: the one POST to our API that carries the
   *  DOB + tax ID, on their single pass to Bridge (K6). */
  | { kind: 'relay'; body: RelayBody }
  | { kind: 'bridge_redirect' }
  | { kind: 'poll_users_me' }
  /** GET /api/users/me/kyc-rejection → REJECTION_RESULT | REJECTION_FAILED. */
  | { kind: 'fetch_rejection' }
  /** POST /api/users/me/kyc-link/retry, stash the way home, navigate to the
   *  hosted flow. Same return leg as bridge_redirect. */
  | { kind: 'persona_retry' }
  | { kind: 'sdk_collect' }
  /** Register the treasury wallet with the SDK. Stripe's headless session
   *  create refuses a raw wallet_address
   *  (`crypto_onramp_consumer_wallet_doesnt_exist`, proven live 2026-08-29),
   *  so the address must exist as a ccw_ on the customer first. Wallets are
   *  reusable, so this runs once per attempt at most. */
  | { kind: 'sdk_register_wallet' }
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
  /** details[0].path — the relay's 409 conflict names which precondition
   *  (`bridge_tos` | `signed_agreement_id`). */
  path: string | null
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
  | { type: 'RELAY_OK'; bridgeCustomerId: string; status: string }
  | { type: 'RELAY_ERROR'; failure: CryptoApiFailure }
  | { type: 'RELAY_FORM_SUBMIT'; values: IdentityFormValues }
  | { type: 'BRIDGE_CONTINUE' }
  | { type: 'BRIDGE_REDIRECT_FAILED' }
  | { type: 'USERS_ME_RESULT'; bridgeCustomerId: string | null; kycStatus: string }
  | { type: 'USERS_ME_FAILED' }
  | { type: 'BRIDGE_RECHECK' }
  | { type: 'REJECTION_RESULT'; reasons: string[]; retriesRemaining: number }
  | { type: 'REJECTION_FAILED' }
  | { type: 'START_PERSONA' }
  | { type: 'PERSONA_REDIRECT_FAILED' }
  | {
      type: 'PM_COLLECTED'
      cryptoPaymentToken: string
      methodType: 'card' | 'us_bank_account'
      cardFunding: string | null
      wallet: string | null
    }
  | { type: 'COLLECT_FAILED' }
  | { type: 'WALLET_READY' }
  | { type: 'WALLET_FAILED' }
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
/** Ticks before the Bridge poll gives up on the in-place update and shows the
 *  come-back-later card (~2 min; sandbox approvals land in seconds, live
 *  database lookups in well under this). The draft persists either way. */
export const BRIDGE_POLL_TIMEOUT_TICKS = 40

// ── Verification readers (defensive: preview API vocabulary is unpinned) ────

type KycOutcome = 'verified' | 'rejected' | 'pending' | 'not_started'

const VERIFIED_STATUSES = new Set(['verified', 'approved', 'active'])
const REJECTED_STATUSES = new Set(['rejected', 'failed', 'canceled'])

/** The identity (L0/L1) entry: any non-document entry. Deliberately loose —
 *  the preview API has answered with BOTH `verifications[]` types like
 *  'kyc_verified' AND `kyc_tiers[]`-derived types like 'l1' (seen live
 *  2026-08-28); matching on kyc/identity substrings missed the tier
 *  vocabulary and stranded the poll. Mirrors the server's own posture
 *  (cacheKycStatus: any verified non-document entry ⇒ L1+). */
function identityEntry(verifications: CryptoVerification[]): CryptoVerification | undefined {
  return verifications.find((v) => !v.type.includes('document'))
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

// ── API-bound payload builders (THE TAX-ID/DOB GUARD SURFACE) ──────────────
// Every body this client sends to our own /api is built here and nowhere
// else. cryptoPayStep.test.ts feeds full KYC values (tax ID, DOB) through
// each builder and asserts the serialized output never matches the PII
// pattern — except buildRelayBody, the sanctioned relay, which it asserts
// DOES.

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

/** Normalize the identity fields for the relay: ISO date (zero-padded),
 *  digits-only tax ID. Same normalization the SDK builder applies, so the
 *  two providers see identical values. */
export function relayValuesFrom(values: IdentityFormValues): RelayValues {
  const pad = (part: string) => part.trim().padStart(2, '0')
  return {
    dob: `${values.dobYear.trim()}-${pad(values.dobMonth)}-${pad(values.dobDay)}`,
    taxIdType: values.taxIdType,
    taxId: digitsOnly(values.taxId),
  }
}

/** Sanctioned PII carrier #2 (see header). The ONLY builder whose output
 *  reaches our API with identity numbers in it. */
export function buildRelayBody(values: RelayValues): RelayBody {
  return { dob: values.dob, taxId: { type: values.taxIdType, number: values.taxId } }
}

function digitsOnly(value: string): string {
  return value.replace(/[^0-9]/g, '')
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
  /** `us_ssn` is the only type the SDK (1.1.3) declares; an ITIN goes in the
   *  same field (Stripe SA, 2026-08-28: ITIN accepted with an L2 step-up).
   *  The pilot verifies. The funnel carries `taxIdType` so the two cohorts
   *  can be told apart. */
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
    // date_of_birth there means the user is never asked for a tax ID a tier
    // didn't demand.
    ...(mode === 'l1'
      ? {
          id_number: { type: 'us_ssn' as const, value: digitsOnly(values.taxId) },
          date_of_birth: {
            day: Number(values.dobDay),
            month: Number(values.dobMonth),
            year: Number(values.dobYear),
          },
        }
      : {}),
  }
}

// ── Form validation (sanity only — Stripe and Bridge are the authorities) ──

/** DOB + tax ID. An ITIN is nine digits starting with 9 (IRS format); an SSN
 *  is any nine digits — the sandbox's canonical 000000000 must pass. */
export function invalidIdentityFields(values: IdentityFormValues): string[] {
  const bad: string[] = []
  const month = Number(values.dobMonth)
  const day = Number(values.dobDay)
  const year = Number(values.dobYear)
  if (!Number.isInteger(month) || month < 1 || month > 12) bad.push('dobMonth')
  if (!Number.isInteger(day) || day < 1 || day > 31) bad.push('dobDay')
  if (!Number.isInteger(year) || year < 1900 || year > 2100) bad.push('dobYear')
  const digits = values.taxId.replace(/-/g, '')
  const shape = values.taxIdType === 'itin' ? /^9[0-9]{8}$/ : /^[0-9]{9}$/
  if (!shape.test(digits)) bad.push('taxId')
  return bad
}

export function invalidKycFields(values: KycFormValues, mode: KycFormMode): string[] {
  const bad: string[] = []
  if (!values.firstName.trim()) bad.push('firstName')
  if (!values.lastName.trim()) bad.push('lastName')
  if (!values.addressLine1.trim()) bad.push('addressLine1')
  if (!values.city.trim()) bad.push('city')
  if (!/^[A-Z]{2}$/.test(values.state)) bad.push('state')
  if (!/^[0-9]{5}(-[0-9]{4})?$/.test(values.postalCode)) bad.push('postalCode')
  if (mode === 'l1') bad.push(...invalidIdentityFields(values))
  return bad
}

/**
 * The phone `registerLinkUser` gets: E.164. `users.phone` is NOT reliably
 * E.164 — GoTrue stores the login phone without its `+` and the signup
 * trigger copies it verbatim, so most rows read `1XXXXXXXXXX` (staging
 * 2026-09-03: 4 of 5). Stripe's consumer sign-up 400s on that ("There was an
 * issue parsing the phone number"), which no drive had hit because the K5
 * fixture already had a Link account. NANP only (the sender is US); null
 * means "don't call the SDK with it".
 */
export function linkPhoneFor(raw: string): string | null {
  const digits = raw.replace(/[^0-9]/g, '')
  if (digits.length === 10) return `+1${digits}`
  if (digits.length === 11 && digits.startsWith('1')) return `+${digits}`
  return null
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
  let path: string | null = null
  if (typeof body === 'object' && body !== null) {
    const err = (body as { error?: unknown }).error
    if (typeof err === 'object' && err !== null) {
      const e = err as { code?: unknown; details?: unknown }
      if (typeof e.code === 'string') code = e.code
      if (Array.isArray(e.details)) {
        const first = e.details[0] as { issue?: unknown; path?: unknown } | undefined
        if (first && typeof first.issue === 'string') issue = first.issue
        if (first && typeof first.path === 'string') path = first.path
      }
    }
  }
  return { status, code, issue, path }
}

/** Stripe step-up code → which form re-enters. */
export function stepUpFormFor(issue: string | null): 'l0' | 'l1' | 'docs' | null {
  if (issue === 'crypto_onramp_missing_minimum_identity_verification') return 'l0'
  if (issue === 'crypto_onramp_missing_identity_verification') return 'l1'
  if (issue === 'crypto_onramp_missing_document_verification') return 'docs'
  return null
}

/**
 * Bridge rejection reasons that no document upload can cure. The vocabulary
 * is unevidenced (open fact, rep asked 2026-09-02), so this is a denylist
 * that fails TOWARD the Persona offer: an unrecognized reason gets the
 * hosted retry, and the server's KYC_MAX_RETRIES bounds it.
 */
const PERMANENT_REJECTION =
  /sanction|\bpep\b|politically exposed|prohibited|fraud|underage|unsupported|deceased|blocklist|watchlist/i

export function isPermanentRejection(reasons: string[]): boolean {
  return reasons.some((reason) => PERMANENT_REJECTION.test(reason))
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
      relayValues: null,
      correctionUsed: false,
      walletRegistered: false,
      sdkReauthed: false,
    },
  }
}

export function initialEffects(): CryptoPayEffect[] {
  return [{ kind: 'boot' }]
}

function cap(ctx: CryptoPayContext, event: string, props: Record<string, string | number> = {}): FunnelCapture {
  return { event, props: { transfer_id: ctx.transferId, ...props } }
}

/** Forget the identity values. Called the moment they can no longer be
 *  relayed (relay answered, customer already exists, Stripe rejected). */
function dropRelayValues(ctx: CryptoPayContext): CryptoPayContext {
  return ctx.relayValues ? { ...ctx, relayValues: null } : ctx
}

/**
 * Where a boot lands. Everything except a settled rejection goes through the
 * intro → (ToS) → Link-auth path, EVEN when the server already knows this
 * user's crypto customer.
 *
 * Why (found on the 2026-08-28 drive, in a fresh browser): our server's
 * OAuth token and the SDK's Link session are DIFFERENT credentials living in
 * different places. `stripe_crypto_customer_id` on the row proves the user
 * verified once — it says nothing about whether THIS browser's SDK is
 * authenticated. Resuming straight to kyc_form/collect on that basis put an
 * unauthenticated SDK in front of `collectPaymentMethod`, which threw 403s
 * and dead-ended the sender with a generic retry card. Real users hit this
 * by switching device, clearing storage, or using a second browser.
 *
 * Routing through `authenticate` costs nothing when the SDK IS already
 * authenticated — Stripe's contract is that the callback fires immediately
 * and no element is presented — and the stored LinkAuthIntent is reused
 * server-side (K3's 5-minute margin), so no extra OTP is forced. The
 * exchange that follows re-reads verifications, so the post-auth routing
 * lands on exactly the step the old shortcut was trying to guess.
 */
function stepAfterBoot(ctx: CryptoPayContext): Transition {
  if (kycOutcomeFor(ctx.verifications) === 'rejected') {
    // The one shortcut worth keeping: a settled rejection needs no SDK.
    // (A rejection is only correctable in the session it happened in —
    // after a reload the correction has been spent as far as we can tell.)
    return {
      state: { view: { step: 'failed', kind: 'kyc_rejected' }, ctx },
      effects: [],
      captures: [cap(ctx, 'send_kyc_rejected', { code: 'boot_rejected' })],
    }
  }
  return { state: { view: { step: 'intro' }, ctx }, effects: [], captures: [] }
}

/** Where a known Bridge status goes (entered from the relay's answer, from a
 *  verified exchange with an existing customer, or from the poll). Pending
 *  statuses enter the bounded poll fresh (pollCount 0). */
function routeByBridgeStatus(ctx: CryptoPayContext, kycStatus: string): Transition {
  if (kycStatus === 'approved') {
    return {
      state: { view: { step: 'collect', notice: null }, ctx },
      effects: [{ kind: 'sdk_collect' }],
      captures: [cap(ctx, 'send_bridge_kyc_approved')],
    }
  }
  if (kycStatus === 'rejected') {
    return {
      state: { view: { step: 'bridge_rejection' }, ctx },
      effects: [{ kind: 'fetch_rejection' }],
      captures: [cap(ctx, 'send_bridge_kyc_rejected')],
    }
  }
  if (kycStatus === 'manual_review') {
    return {
      state: { view: { step: 'bridge_wait' }, ctx },
      effects: [],
      captures: [cap(ctx, 'send_bridge_wait', { reason: 'manual_review' })],
    }
  }
  return {
    state: { view: { step: 'bridge_polling' }, ctx: { ...ctx, pollCount: 0 } },
    effects: [{ kind: 'poll_users_me' }],
    captures: [],
  }
}

/** One more Bridge poll, or the come-back-later card at the bound. */
function bridgePollTick(ctx: CryptoPayContext): Transition {
  const next = { ...ctx, pollCount: ctx.pollCount + 1 }
  if (next.pollCount >= BRIDGE_POLL_TIMEOUT_TICKS) {
    return {
      state: { view: { step: 'bridge_wait' }, ctx: next },
      effects: [],
      captures: [cap(next, 'send_bridge_wait', { reason: 'timeout' })],
    }
  }
  return {
    state: { view: { step: 'bridge_polling' }, ctx: next },
    effects: [{ kind: 'poll_users_me' }],
    captures: [],
  }
}

/** POST the relay. Requires ctx.relayValues (callers guarantee it). */
function startRelay(ctx: CryptoPayContext, reason: 'verified' | 'reload' | 'correction'): Transition {
  const values = ctx.relayValues!
  return {
    state: { view: { step: 'relaying' }, ctx },
    effects: [{ kind: 'relay', body: buildRelayBody(values) }],
    captures: [cap(ctx, 'send_bridge_relay_started', { taxIdType: values.taxIdType, reason })],
  }
}

/** Where a verified Stripe KYC goes next (decision 2, ratified 2026-08-28:
 *  the Bridge gate sits BEFORE payment). K6: with no Bridge customer yet the
 *  relay runs from the values the KYC form left in ctx; after a reload those
 *  are gone and the two-field form asks again. */
function afterStripeKycVerified(ctx: CryptoPayContext): Transition {
  const prefill = ctx.prefill
  if (prefill?.bridgeCustomerId) {
    return routeByBridgeStatus(dropRelayValues(ctx), prefill.kycStatus)
  }
  if (ctx.relayValues) return startRelay(ctx, 'verified')
  return {
    state: { view: { step: 'relay_form', reason: 'reload', invalid: false }, ctx },
    effects: [],
    captures: [cap(ctx, 'send_relay_form_viewed', { reason: 'reload' })],
  }
}

/** The KYC poll settled verified: resume a pending step-up, else continue the
 *  first-time flow. A step-up happens past the Bridge gate (the customer
 *  exists), so the identity values can never be relayed from here. */
function afterKycVerified(ctx: CryptoPayContext, verifications: CryptoVerification[]): Transition {
  const next = { ...ctx, verifications, pollCount: 0 }
  const verifiedCap = cap(next, 'send_kyc_verified', { tier: kycTierFor(verifications) })
  if (next.stepUp?.resume === 'session_create' && next.paymentTokenId) {
    const t = startSessionCreate({ ...dropRelayValues(next), stepUp: null })
    return { ...t, captures: [verifiedCap, ...t.captures] }
  }
  if (next.stepUp?.resume === 'checkout' && next.sessionId) {
    const resumed = { ...dropRelayValues(next), stepUp: null }
    return {
      state: { view: { step: 'checkout' }, ctx: resumed },
      effects: [{ kind: 'sdk_checkout', sessionId: resumed.sessionId! }],
      captures: [verifiedCap],
    }
  }
  const t = afterStripeKycVerified({ ...next, stepUp: null })
  return { ...t, captures: [verifiedCap, ...t.captures] }
}

/**
 * Enter the session-create leg. The treasury wallet must exist as a ccw_ on
 * the customer first — Stripe's headless create refuses a raw address — so
 * this registers it once, then creates. Both legs render the same busy view;
 * the sender sees one "preparing your payment" beat either way.
 */
function startSessionCreate(ctx: CryptoPayContext): Transition {
  if (!ctx.paymentTokenId) {
    // No token to spend — recollect rather than call with nothing.
    return {
      state: { view: { step: 'collect', notice: null }, ctx },
      effects: [{ kind: 'sdk_collect' }],
      captures: [],
    }
  }
  return {
    state: { view: { step: 'session_create' }, ctx },
    effects: [
      ctx.walletRegistered
        ? { kind: 'create_session', body: buildSessionCreateBody(ctx.paymentTokenId) }
        : { kind: 'sdk_register_wallet' },
    ],
    captures: [],
  }
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
        state: { view: { step: 'kyc_form', mode: form, invalid: false, notice: null }, ctx: next },
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
      // ToS first (K6 decision 1): Bridge's click-through precedes Link auth
      // for everyone who has neither the current ToS on file nor a Bridge
      // customer already (a pre-K6 customer accepted through the hosted
      // flow).
      const p = ctx.prefill
      if (p && !p.bridgeTosAccepted && !p.bridgeCustomerId) {
        return {
          state: { view: { step: 'bridge_tos' }, ctx },
          effects: [],
          captures: [cap(ctx, 'send_bridge_tos_viewed', { reason: 'first' })],
        }
      }
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
        state: { view: { step: 'kyc_form', mode: 'l1', invalid: false, notice: null }, ctx: next },
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
          state: { view: { step: 'kyc_form', mode, invalid: true, notice: view.notice }, ctx },
          effects: [],
          captures: [],
        }
      }
      // The l1 form is the one place the identity values enter the machine;
      // they wait in ctx for the relay that follows Stripe's verdict.
      const next = mode === 'l1' ? { ...ctx, relayValues: relayValuesFrom(event.values) } : ctx
      const submitted = cap(next, 'send_kyc_submitted', {
        mode,
        ...(mode === 'l1' ? { taxIdType: event.values.taxIdType } : {}),
      })
      if (event.addressEdited && next.prefill) {
        return {
          state: { view: { step: 'kyc_address_sync' }, ctx: next },
          effects: [{ kind: 'patch_address', body: buildAddressPatch(next.prefill, event.values) }],
          captures: [submitted],
        }
      }
      return {
        state: { view: { step: 'kyc_submitting' }, ctx: next },
        effects: [{ kind: 'sdk_submit_kyc', values: event.values, mode }],
        captures: [submitted],
      }
    }
    case 'KYC_INVALID': {
      if (view.step !== 'kyc_form') return stay()
      return {
        state: { view: { step: 'kyc_form', mode: view.mode, invalid: true, notice: view.notice }, ctx },
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
      // The form resubmits everything, so the held values are dropped now.
      const mode = ctx.stepUp?.form === 'l0' ? 'l0' : 'l1'
      return {
        state: { view: { step: 'kyc_form', mode, invalid: true, notice: null }, ctx: dropRelayValues(ctx) },
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
        state: { view: { step: 'kyc_form', mode, invalid: true, notice: null }, ctx: dropRelayValues(ctx) },
        effects: [],
        captures: [cap(ctx, 'send_kyc_rejected', { code: 'submit_failed' })],
      }
    }

    case 'KYC_POLL_RESULT': {
      if (view.step !== 'kyc_polling') return stay()
      const outcome = kycOutcomeFor(event.verifications)
      if (outcome === 'verified') return afterKycVerified(ctx, event.verifications)
      if (outcome === 'rejected') {
        // Decision 4: one correction, then terminal. The held values are
        // dropped either way — the form re-enters them or nothing does.
        if (!ctx.correctionUsed) {
          const next: CryptoPayContext = {
            ...ctx,
            verifications: event.verifications,
            correctionUsed: true,
            relayValues: null,
          }
          const mode = ctx.stepUp?.form === 'l0' ? 'l0' : 'l1'
          return {
            state: { view: { step: 'kyc_form', mode, invalid: false, notice: 'rejected' }, ctx: next },
            effects: [],
            captures: [cap(next, 'send_kyc_correction_offered')],
          }
        }
        const next: CryptoPayContext = { ...ctx, verifications: event.verifications, relayValues: null }
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

    case 'RELAY_OK': {
      if (view.step !== 'relaying') return stay()
      // The values have done their one job. The customer now exists (or
      // already did — the route no-ops), so route on Bridge's status.
      const base = dropRelayValues(ctx)
      const next: CryptoPayContext = {
        ...base,
        prefill: base.prefill
          ? { ...base.prefill, bridgeCustomerId: event.bridgeCustomerId, kycStatus: event.status }
          : base.prefill,
      }
      const created = cap(next, 'send_bridge_customer_created', { status: event.status })
      const t = routeByBridgeStatus(next, event.status)
      return { ...t, captures: [created, ...t.captures] }
    }
    case 'RELAY_ERROR': {
      if (view.step !== 'relaying') return stay()
      // Whatever the answer, the values are gone; every path that needs them
      // again re-enters them through a form.
      const next = dropRelayValues(ctx)
      const f = event.failure
      const failed = cap(next, 'send_bridge_relay_failed', {
        code: f.code ?? `http_${f.status}`,
        ...(f.path ? { path: f.path } : {}),
      })
      if (f.status === 409 && f.code === 'duplicate_identity') {
        return {
          state: { view: { step: 'failed', kind: 'duplicate_identity' }, ctx: next },
          effects: [],
          captures: [failed],
        }
      }
      if (f.status === 422) {
        return {
          state: { view: { step: 'relay_form', reason: 'correction', invalid: false }, ctx: next },
          effects: [],
          captures: [failed, cap(next, 'send_relay_form_viewed', { reason: 'correction' })],
        }
      }
      if (f.status === 409 && f.code === 'conflict') {
        // bridge_tos missing, or the agreement id was consumed (pointer
        // already cleared server-side): the click-through runs again.
        return {
          state: { view: { step: 'bridge_tos' }, ctx: next },
          effects: [],
          captures: [failed, cap(next, 'send_bridge_tos_viewed', { reason: f.path ?? 'conflict' })],
        }
      }
      if (f.status === 403 && f.code === 'kyc_required') {
        // The server's view of Stripe's tier disagrees with ours: re-verify.
        return {
          state: { view: { step: 'kyc_form', mode: 'l1', invalid: false, notice: null }, ctx: next },
          effects: [],
          captures: [failed, cap(next, 'send_kyc_form_viewed', { mode: 'l1' })],
        }
      }
      return {
        state: { view: { step: 'failed', kind: 'retryable' }, ctx: next },
        effects: [],
        captures: [failed],
      }
    }
    case 'RELAY_FORM_SUBMIT': {
      if (view.step !== 'relay_form') return stay()
      if (invalidIdentityFields(event.values).length > 0) {
        return {
          state: { view: { step: 'relay_form', reason: view.reason, invalid: true }, ctx },
          effects: [],
          captures: [],
        }
      }
      return startRelay({ ...ctx, relayValues: relayValuesFrom(event.values) }, view.reason)
    }

    case 'BRIDGE_CONTINUE': {
      if (view.step !== 'bridge_tos') return stay()
      // The effect sets the kyc_next/kyc_locale cookies and navigates away —
      // no state to keep; the return leg records the consent and reboots the
      // machine, which then passes the gate.
      return stay([{ kind: 'bridge_redirect' }], [cap(ctx, 'send_bridge_tos_started')])
    }
    case 'BRIDGE_REDIRECT_FAILED':
      return {
        state: { view: { step: 'failed', kind: 'retryable' }, ctx },
        effects: [],
        captures: [cap(ctx, 'send_payment_failed', { code: 'bridge_redirect_failed' })],
      }
    case 'USERS_ME_RESULT': {
      if (view.step !== 'bridge_polling') return stay()
      const next = {
        ...ctx,
        prefill: ctx.prefill
          ? { ...ctx.prefill, bridgeCustomerId: event.bridgeCustomerId, kycStatus: event.kycStatus }
          : ctx.prefill,
      }
      const settled =
        event.kycStatus === 'approved' ||
        event.kycStatus === 'rejected' ||
        event.kycStatus === 'manual_review'
      if (event.bridgeCustomerId && settled) return routeByBridgeStatus(next, event.kycStatus)
      return bridgePollTick(next)
    }
    case 'USERS_ME_FAILED': {
      if (view.step !== 'bridge_polling') return stay()
      // Transient read failure counts toward the same bound — the wait card
      // is the honest vent either way.
      return bridgePollTick(ctx)
    }
    case 'BRIDGE_RECHECK': {
      if (view.step !== 'bridge_wait') return stay()
      return {
        state: { view: { step: 'bridge_polling' }, ctx: { ...ctx, pollCount: 0 } },
        effects: [{ kind: 'poll_users_me' }],
        captures: [cap(ctx, 'send_bridge_recheck')],
      }
    }

    case 'REJECTION_RESULT': {
      if (view.step !== 'bridge_rejection') return stay()
      // Decisions 5-6: Persona is the fallback for what a document can cure;
      // a permanent reason (or no retries left) is terminal.
      const permanent = isPermanentRejection(event.reasons)
      if (event.retriesRemaining > 0 && !permanent) {
        return {
          state: { view: { step: 'bridge_persona', retriesRemaining: event.retriesRemaining }, ctx },
          effects: [],
          captures: [cap(ctx, 'send_bridge_persona_offered', { retriesRemaining: event.retriesRemaining })],
        }
      }
      return {
        state: { view: { step: 'failed', kind: 'kyc_rejected' }, ctx },
        effects: [],
        captures: [
          cap(ctx, 'send_kyc_rejected', {
            code: 'bridge_rejected',
            reason: permanent ? 'permanent' : 'retries_exhausted',
          }),
        ],
      }
    }
    case 'REJECTION_FAILED': {
      if (view.step !== 'bridge_rejection') return stay()
      // Could not read the reasons: fail toward the offer. The server bounds
      // retries, so an exhausted user gets a refused link, never a loop.
      return {
        state: { view: { step: 'bridge_persona', retriesRemaining: null }, ctx },
        effects: [],
        captures: [cap(ctx, 'send_bridge_persona_offered', { retriesRemaining: 'unknown' })],
      }
    }
    case 'START_PERSONA': {
      if (view.step !== 'bridge_persona') return stay()
      return stay([{ kind: 'persona_retry' }], [cap(ctx, 'send_bridge_persona_started')])
    }
    case 'PERSONA_REDIRECT_FAILED':
      return {
        state: { view: { step: 'failed', kind: 'retryable' }, ctx },
        effects: [],
        captures: [cap(ctx, 'send_bridge_persona_failed')],
      }

    case 'PM_COLLECTED': {
      const next: CryptoPayContext = {
        ...ctx,
        paymentTokenId: event.cryptoPaymentToken,
        paymentMethodType: event.methodType,
      }
      const t = startSessionCreate(next)
      return {
        ...t,
        captures: [
          cap(next, 'send_payment_method_collected', {
            type: event.methodType,
            ...(event.cardFunding ? { funding: event.cardFunding } : {}),
            ...(event.wallet ? { wallet: event.wallet } : {}),
          }),
        ],
      }
    }
    case 'COLLECT_FAILED': {
      // The SDK refused to present the payment sheet. Overwhelmingly this
      // means ITS session lapsed (ours is a different credential), so send
      // the sender back through Link auth — which is a no-op when the SDK is
      // fine — rather than stranding them on a retry card. Once only.
      if (!ctx.sdkReauthed) {
        const next = { ...ctx, sdkReauthed: true }
        return {
          state: { view: { step: 'link_auth' }, ctx: next },
          effects: [{ kind: 'create_intent' }],
          captures: [cap(next, 'send_link_auth_started', { reason: 'sdk_collect_failed' })],
        }
      }
      return {
        state: { view: { step: 'failed', kind: 'retryable' }, ctx },
        effects: [],
        captures: [cap(ctx, 'send_payment_failed', { code: 'collect_failed' })],
      }
    }

    case 'WALLET_READY':
      return startSessionCreate({ ...ctx, walletRegistered: true })
    case 'WALLET_FAILED':
      // Nothing the sender can do about a wallet registration failure, and
      // nothing was charged — surface it as retryable, not as a payment
      // problem (no send_payment_failed: no payment was ever attempted).
      return {
        state: { view: { step: 'failed', kind: 'retryable' }, ctx },
        effects: [],
        captures: [cap(ctx, 'send_payment_failed', { code: 'wallet_registration_failed' })],
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
      // The fresh initial state also drops any held identity values.
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
