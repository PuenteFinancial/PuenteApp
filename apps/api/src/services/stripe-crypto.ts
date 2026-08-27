import { env } from '../config/env.js'
import { supabaseAdmin } from '../services/supabase.js'
import { encryptString, decryptString, DecryptionError } from '../utils/encryption.js'

// Stripe crypto onramp, embedded components (K3 — KYC rehaul slice 3).
//
// Server half of the Link OAuth + crypto client. Endpoint shapes come from
// two sources, in trust order:
//   1. Stripe's public integration guide (docs.stripe.com/crypto/onramp/
//      embedded-components-integration-guide, fetched 2026-08-27) — LAI
//      create/exchange/refresh, customers retrieve, onramp_quotes.
//   2. The SA solution plan (2026-08-18) — transaction_limits, which has no
//      public doc yet; that call is SMOKE-VALIDATED (scripts/
//      smoke-stripe-crypto.ts), not doc-proven.
// Until the account's preview flags are provisioned, crypto calls fail with
// Stripe's documented "Unrecognized request URL" — an SA fix, not a code bug.
//
// Credential rules (NON-NEGOTIABLE):
// - Access tokens (1h TTL) live in memory for the duration of a request and
//   are NEVER persisted or returned to a client.
// - Refresh tokens (90d TTL, rotate on every use) are stored AES-256-GCM
//   encrypted, AAD-bound to the owning user_id (utils/encryption.ts).
// - The OAuth client secret appears in exactly one call: the refresh grant.
// - Nothing in this file logs a token, an email, or an error body.

const LINK_TOKENS_TABLE = 'stripe_link_tokens'

// Web scope set. auth.persist_login:read (seamless sign-in) is mobile-only
// and joins in K8 — requesting it on web would widen the consent screen for
// a capability web cannot use.
export const LINK_OAUTH_SCOPES_WEB = 'kyc.status:read,crypto:ramp'

export class StripeCryptoApiError extends Error {
  // Raw error body — readable for code branching, deliberately NON-ENUMERABLE
  // (bridge.ts precedent) so console.error / JSON.stringify never print it:
  // Stripe error bodies can echo request context.
  declare readonly body: unknown

  constructor(
    public readonly status: number,
    body: unknown,
  ) {
    super(`Stripe crypto API request failed with status ${status}`)
    this.name = 'StripeCryptoApiError'
    Object.defineProperty(this, 'body', { value: body, enumerable: false })
  }

  // Stripe error envelope: { error: { code, message, … } }
  get code(): string | undefined {
    const err = (this.body as { error?: { code?: string } } | null)?.error
    return err?.code
  }
}

export function isStripeCryptoConfigured(): boolean {
  return Boolean(
    env.STRIPE_SECRET_KEY && env.STRIPE_CRYPTO_OAUTH_CLIENT_ID && env.STRIPE_CRYPTO_OAUTH_CLIENT_SECRET,
  )
}

// Both hosts take the platform secret key as Bearer auth; crypto endpoints
// additionally take the beta version header and (for user-scoped calls) the
// user's OAuth access token. Bounded by STRIPE_TIMEOUT_SECONDS like every
// other provider call (bridge.ts precedent — same rationale, same knob shape).
async function cryptoFetch(
  base: string,
  path: string,
  init: RequestInit & { oauthToken?: string; stripeVersion?: boolean } = {},
): Promise<unknown> {
  const { oauthToken, stripeVersion, ...rest } = init
  const res = await fetch(`${base}${path}`, {
    ...rest,
    signal: AbortSignal.timeout(env.STRIPE_TIMEOUT_SECONDS * 1000),
    headers: {
      Authorization: `Bearer ${env.STRIPE_SECRET_KEY}`,
      ...(stripeVersion !== false && { 'Stripe-Version': env.STRIPE_CRYPTO_VERSION }),
      ...(oauthToken && { 'Stripe-OAuth-Token': oauthToken }),
      ...rest.headers,
    },
  })

  if (!res.ok) {
    const body = await res.json().catch(() => null)
    throw new StripeCryptoApiError(res.status, body)
  }

  return res.json()
}

// ── LinkAuthIntent ─────────────────────────────────────────────────────────

export interface LinkAuthIntent {
  id: string
  expiresAt: number // unix seconds
  // 404 from creation means "no Link account for this email" — the client
  // must run registerLinkUser first. Surfaced as data, not an error, because
  // it is an expected branch of the flow, not a failure.
  linkAccountExists: boolean
}

// Create a LinkAuthIntent for the user's email — or REUSE the stored one
// when it is still valid. The reuse rule is web-critical (SA doc): a fresh
// intent per page load forces the user through Link OTP every time. A
// 5-minute safety margin keeps us from handing the SDK an intent that
// expires mid-OTP.
const LAI_REUSE_MARGIN_MS = 5 * 60 * 1000

export async function createOrReuseLinkAuthIntent(
  userId: string,
  email: string,
): Promise<LinkAuthIntent> {
  const { data: stored } = await supabaseAdmin
    .from(LINK_TOKENS_TABLE)
    .select('auth_intent_id, lai_expires_at')
    .eq('user_id', userId)
    .maybeSingle()

  const row = stored as { auth_intent_id: string | null; lai_expires_at: string | null } | null
  if (row?.auth_intent_id && row.lai_expires_at) {
    const expiresMs = new Date(row.lai_expires_at).getTime()
    if (expiresMs - LAI_REUSE_MARGIN_MS > Date.now()) {
      return {
        id: row.auth_intent_id,
        expiresAt: Math.floor(expiresMs / 1000),
        linkAccountExists: true,
      }
    }
  }

  let created: { id: string; expires_at: number }
  try {
    created = (await cryptoFetch(env.LINK_OAUTH_API_BASE, '/v1/link_auth_intent', {
      method: 'POST',
      // login.link.com endpoints are not versioned with the crypto beta header
      stripeVersion: false,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email,
        oauth_client_id: env.STRIPE_CRYPTO_OAUTH_CLIENT_ID,
        oauth_scopes: LINK_OAUTH_SCOPES_WEB,
      }),
    })) as { id: string; expires_at: number }
  } catch (err) {
    // Documented 404: "the provided email has no active Link customer" —
    // the registration branch, not a failure. (The same status can also mean
    // a bad OAuth client; the smoke script disambiguates at setup time.)
    if (err instanceof StripeCryptoApiError && err.status === 404) {
      return { id: '', expiresAt: 0, linkAccountExists: false }
    }
    throw err
  }

  // Persist for reuse. Upsert: first contact inserts the row (token column
  // stays null until exchange); a stale intent gets replaced in place —
  // refresh_token_enc is absent from the payload, so a stored credential is
  // never touched. A failed save only costs the reuse optimization (next
  // load re-creates and re-OTPs); the returned intent is still valid.
  await supabaseAdmin.from(LINK_TOKENS_TABLE).upsert(
    {
      user_id: userId,
      auth_intent_id: created.id,
      lai_expires_at: new Date(created.expires_at * 1000).toISOString(),
    },
    { onConflict: 'user_id' },
  )

  return { id: created.id, expiresAt: created.expires_at, linkAccountExists: true }
}

// ── Tokens ─────────────────────────────────────────────────────────────────

interface TokenSet {
  accessToken: string
  refreshToken: string | null
}

// Exchange a consented LinkAuthIntent for tokens and store the refresh token
// encrypted. Returns the in-memory access token for immediate use.
export async function exchangeLinkAuthIntent(userId: string, authIntentId: string): Promise<string> {
  const data = (await cryptoFetch(
    env.LINK_OAUTH_API_BASE,
    `/v1/link_auth_intent/${encodeURIComponent(authIntentId)}/tokens`,
    { method: 'POST', stripeVersion: false },
  )) as { access_token: string; refresh?: { refresh_token?: string } }

  const refreshToken = data.refresh?.refresh_token ?? null
  if (refreshToken) {
    await storeRefreshToken(userId, refreshToken)
  }
  return data.access_token
}

async function storeRefreshToken(userId: string, refreshToken: string): Promise<void> {
  const { error } = await supabaseAdmin.from(LINK_TOKENS_TABLE).upsert(
    {
      user_id: userId,
      refresh_token_enc: encryptString(refreshToken, userId),
    },
    { onConflict: 'user_id' },
  )
  if (error) {
    // A refresh token we failed to store is a credential nobody holds — the
    // user just re-OTPs next session. Log the shape, never the token.
    throw new StripeCryptoApiError(500, { error: { code: 'token_store_failed' } })
  }
}

export class NoStoredTokenError extends Error {
  constructor() {
    super('No stored Link refresh token for user')
    this.name = 'NoStoredTokenError'
  }
}

// Mint a fresh access token from the stored refresh token. Stripe ROTATES
// the refresh token on every grant — the new one replaces the old before the
// access token is returned, so a crash between grant and store costs one
// re-OTP, never a stuck credential.
export async function mintAccessToken(userId: string): Promise<string> {
  const { data } = await supabaseAdmin
    .from(LINK_TOKENS_TABLE)
    .select('refresh_token_enc')
    .eq('user_id', userId)
    .maybeSingle()

  const row = data as { refresh_token_enc: string } | null
  if (!row?.refresh_token_enc) throw new NoStoredTokenError()

  let refreshToken: string
  try {
    refreshToken = decryptString(row.refresh_token_enc, userId)
  } catch (err) {
    if (err instanceof DecryptionError) throw new NoStoredTokenError()
    throw err
  }

  const params = new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: refreshToken,
    client_id: env.STRIPE_CRYPTO_OAUTH_CLIENT_ID!,
    client_secret: env.STRIPE_CRYPTO_OAUTH_CLIENT_SECRET!,
  })

  let granted: TokenSet
  try {
    const data = (await cryptoFetch(env.LINK_OAUTH_API_BASE, '/auth/token', {
      method: 'POST',
      stripeVersion: false,
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: params.toString(),
    })) as { access_token: string; refresh_token?: string }
    granted = { accessToken: data.access_token, refreshToken: data.refresh_token ?? null }
  } catch (err) {
    // An invalid/expired/revoked refresh token means the user must
    // re-authenticate — same recovery as having no token at all.
    if (err instanceof StripeCryptoApiError && (err.status === 400 || err.status === 401 || err.status === 403)) {
      throw new NoStoredTokenError()
    }
    throw err
  }

  if (granted.refreshToken && granted.refreshToken !== refreshToken) {
    await storeRefreshToken(userId, granted.refreshToken)
  }

  return granted.accessToken
}

// ── Crypto customer (KYC status) ───────────────────────────────────────────

export interface CryptoCustomerStatus {
  customerId: string
  // Normalized view over the preview API's verification entries. The public
  // v2 docs call the array `verifications`; the SA doc called it `kyc_tiers`.
  // Both are read; unknown members pass through untouched.
  verifications: Array<{ type: string; status: string }>
}

export async function getCryptoCustomer(
  customerId: string,
  accessToken: string,
): Promise<CryptoCustomerStatus> {
  const data = (await cryptoFetch(
    env.STRIPE_API_BASE,
    `/v1/crypto/customers/${encodeURIComponent(customerId)}`,
    { oauthToken: accessToken },
  )) as {
    id: string
    verifications?: Array<{ type?: string; status?: string }>
    kyc_tiers?: Array<{ tier?: string; type?: string; verification_status?: string; status?: string }>
  }

  const verifications =
    data.verifications?.map((v) => ({ type: v.type ?? 'unknown', status: v.status ?? 'unknown' })) ??
    data.kyc_tiers?.map((t) => ({
      type: t.tier ?? t.type ?? 'unknown',
      status: t.verification_status ?? t.status ?? 'unknown',
    })) ??
    []

  return { customerId: data.id, verifications }
}

// Cache the poll result on users. Display/routing hints only — Stripe stays
// the source of truth and nothing authorizes off these columns.
export async function cacheKycStatus(userId: string, status: CryptoCustomerStatus): Promise<void> {
  // Highest verified entry wins; entries look like { type: 'kyc_verified'|
  // 'document_verified'|…, status }. Kept deliberately loose for preview drift.
  const verified = status.verifications.filter((v) => v.status === 'verified')
  const tier = verified.some((v) => v.type.includes('document'))
    ? 'L2'
    : verified.length > 0
      ? 'L1'
      : null
  const anyStatus = status.verifications[0]?.status ?? null

  await supabaseAdmin
    .from('users')
    .update({
      stripe_crypto_customer_id: status.customerId,
      stripe_kyc_tier: tier,
      stripe_kyc_tier_status: anyStatus,
    })
    .eq('id', userId)
}

// ── Quotes & limits ────────────────────────────────────────────────────────

export interface OnrampQuote {
  destinationCurrency: string
  destinationAmount: string
  destinationNetwork: string
  networkFee: string
  transactionFee: string
  sourceTotalAmount: string
}

// Headless quote for the pay step's native fee display (decision: fees render
// from OUR UI via this API, never the widget). Platform-key call — no user
// token — so it can price a quote before the user has authenticated.
export async function getOnrampQuote(input: {
  sourceAmount: string // decimal string, e.g. "25.00" — Stripe quotes in decimal units
  destinationCurrency: string
  destinationNetwork: string
}): Promise<OnrampQuote | null> {
  const params = new URLSearchParams({
    ui_mode: 'headless',
    source_amount: input.sourceAmount,
    source_currency: 'usd',
  })
  params.append('destination_currencies[]', input.destinationCurrency)
  params.append('destination_networks[]', input.destinationNetwork)

  const data = (await cryptoFetch(env.STRIPE_API_BASE, `/v1/crypto/onramp_quotes?${params}`, {})) as {
    destination_network_quotes?: Record<
      string,
      Array<{
        destination_currency?: string
        destination_amount?: string
        destination_network?: string
        fees?: { network_fee_monetary?: string; transaction_fee_monetary?: string }
        source_total_amount?: string
      }>
    >
  }

  const quote = data.destination_network_quotes?.[input.destinationNetwork]?.find(
    (q) => q.destination_currency === input.destinationCurrency,
  )
  if (!quote) return null

  return {
    destinationCurrency: quote.destination_currency ?? input.destinationCurrency,
    destinationAmount: quote.destination_amount ?? '0',
    destinationNetwork: quote.destination_network ?? input.destinationNetwork,
    networkFee: quote.fees?.network_fee_monetary ?? '0',
    transactionFee: quote.fees?.transaction_fee_monetary ?? '0',
    sourceTotalAmount: quote.source_total_amount ?? '0',
  }
}

// SMOKE-VALIDATED SHAPE: transaction_limits has no public doc — the endpoint
// name comes from the SA solution plan ("transaction_limits pre-check on
// send-page load"). Until the smoke script proves it against a provisioned
// account, expect a 404 here and treat the response type as provisional.
export async function getTransactionLimits(accessToken: string): Promise<unknown> {
  return cryptoFetch(env.STRIPE_API_BASE, '/v1/crypto/transaction_limits', {
    oauthToken: accessToken,
  })
}
