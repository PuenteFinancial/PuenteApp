import crypto from 'node:crypto'
import type { KycStatus } from '@puente/shared'
import { env } from '../config/env.js'

// Bridge customer statuses → our KycStatus. One map, shared by the KYC webhook
// and the K6 relay route, so a Bridge status is never mapped two ways.
// Unrecognized statuses fall through unmapped and are only logged.
export const BRIDGE_KYC_STATUS_MAP: Record<string, KycStatus> = {
  not_started: 'not_started',
  incomplete: 'pending',
  awaiting_questionnaire: 'pending',
  awaiting_ubo: 'pending',
  under_review: 'pending',
  in_review: 'pending',
  pending: 'pending',
  manual_review: 'manual_review',
  approved: 'approved',
  active: 'approved',
  rejected: 'rejected',
}

export class BridgeApiError extends Error {
  // Raw Bridge error body — readable for code branching (err.body.code), but
  // deliberately NON-ENUMERABLE so console.error / util.inspect / JSON never
  // print it: Bridge error bodies can echo request PII (names, CLABEs).
  declare readonly body: unknown

  constructor(
    public readonly status: number,
    body: unknown,
  ) {
    // Bridge error bodies can contain request PII — keep the message to status only
    super(`Bridge API request failed with status ${status}`)
    this.name = 'BridgeApiError'
    Object.defineProperty(this, 'body', { value: body, enumerable: false })
  }

  // Contract B alias: payout callers branch on a numeric statusCode
  // (400 → retry, 422/other 4xx → hold).
  get statusCode(): number {
    return this.status
  }
}

async function bridgeFetch(path: string, init: RequestInit = {}): Promise<unknown> {
  const res = await fetch(`${env.BRIDGE_API_BASE}${path}`, {
    ...init,
    // Bounded waiting, nothing else. A fired timeout rejects with the signal's
    // reason (DOMException 'TimeoutError'), which travels the SAME
    // non-BridgeApiError path as undici's TypeError('fetch failed') — no
    // caller branches on either class (routes map it to 502/503, jobs rethrow
    // into pg-boss retry) — so the only behavior change is failing in
    // BRIDGE_TIMEOUT_SECONDS instead of undici's ~300s defaults. Placed after
    // the spread so the bound is unconditional — a caller-supplied init.signal
    // would be CLOBBERED, deliberately (none exists; every call site lives in
    // this file). If one ever appears, compose with AbortSignal.any instead.
    signal: AbortSignal.timeout(env.BRIDGE_TIMEOUT_SECONDS * 1000),
    headers: {
      'Api-Key': env.BRIDGE_API_KEY,
      'Content-Type': 'application/json',
      ...init.headers,
    },
  })

  if (!res.ok) {
    const body = await res.json().catch(() => null)
    throw new BridgeApiError(res.status, body)
  }

  return res.json()
}

export async function createBridgeCustomer(data: {
  firstName: string
  lastName: string
  email: string
  signedAgreementId: string
}): Promise<{ id: string }> {
  const customer = (await bridgeFetch('/v0/customers', {
    method: 'POST',
    headers: { 'Idempotency-Key': crypto.randomUUID() },
    body: JSON.stringify({
      type: 'individual',
      first_name: data.firstName,
      last_name: data.lastName,
      email: data.email,
      signed_agreement_id: data.signedAgreementId,
    }),
  })) as { id: string }

  return { id: customer.id }
}

export interface CreateBridgeCustomerWithIdentityInput {
  /** Our user id — namespaces the idempotency key only. Never sent to Bridge. */
  userId: string
  firstName: string
  lastName: string
  email: string
  signedAgreementId: string
  /** YYYY-MM-DD, already validated by the route schema. */
  birthDate: string
  address: {
    streetLine1: string
    streetLine2?: string | null
    city: string
    /** Two-letter US state, already uppercased by the caller. */
    subdivision: string
    postalCode: string
  }
  taxId: { type: 'ssn' | 'itin'; number: string }
}

// K6 relay body. Every field comes from the request or the user row — no
// clocks, no randomness — and the key order is fixed, so a byte-identical
// retry serializes identically (Bridge 422s on same-Idempotency-Key/
// different-body). The string holds DOB + tax ID: it exists only in this
// frame and the fetch body, and nothing here logs, stores, or rethrows it.
function buildIdentityCustomerBody(input: CreateBridgeCustomerWithIdentityInput): string {
  return JSON.stringify({
    type: 'individual',
    first_name: input.firstName,
    last_name: input.lastName,
    email: input.email,
    signed_agreement_id: input.signedAgreementId,
    birth_date: input.birthDate,
    residential_address: {
      street_line_1: input.address.streetLine1,
      ...(input.address.streetLine2 ? { street_line_2: input.address.streetLine2 } : {}),
      city: input.address.city,
      subdivision: input.address.subdivision,
      postal_code: input.address.postalCode,
      country: 'USA',
    },
    identifying_information: [
      { type: input.taxId.type, issuing_country: 'usa', number: input.taxId.number },
    ],
    endorsements: ['base', 'spei'],
  })
}

/**
 * K6 (2026-09-03): create the Bridge customer from the identity the sender
 * typed once into the pay step — the "relay-never-persist" degrade of the
 * 2026-08-27 custody rule, invoked because Bridge's Customers API puts
 * tax_identification_number in missing.all_of (proven in sandbox 9/2).
 *
 * Idempotency-Key = per-user + a hash of the body: a byte-identical retry
 * (double submit, lost response, crash before persist) replays and returns
 * the SAME customer, while a corrected body (decision 4: one correction
 * attempt) gets a fresh key instead of Bridge's permanent same-key/
 * different-body 422. The legacy createBridgeCustomer above keeps its
 * random key — the flag-OFF Persona path still uses it.
 */
export async function createBridgeCustomerWithIdentity(
  input: CreateBridgeCustomerWithIdentityInput,
): Promise<{ id: string; status: string | undefined }> {
  const body = buildIdentityCustomerBody(input)
  const digest = crypto.createHash('sha256').update(body).digest('hex').slice(0, 16)
  const customer = (await bridgeFetch('/v0/customers', {
    method: 'POST',
    headers: { 'Idempotency-Key': `bridge-customer-${input.userId}-${digest}` },
    body,
  })) as { id: string; status?: string }

  return { id: customer.id, status: customer.status }
}

export type BridgeCustomerErrorKind = 'duplicate' | 'agreement' | 'rejected' | 'unavailable'

// Flatten Bridge's `source` object ({ key: { field: 'message' } } and
// variants) into its keys + string leaves, depth-bounded. The output is only
// ever pattern-matched, never logged: it can echo request values.
function flattenSource(value: unknown, depth = 0): string[] {
  if (depth > 4 || value === null || value === undefined) return []
  if (typeof value === 'string') return [value]
  if (Array.isArray(value)) return value.flatMap((v) => flattenSource(v, depth + 1))
  if (typeof value === 'object') {
    return Object.entries(value as Record<string, unknown>).flatMap(([k, v]) => [
      k,
      ...flattenSource(v, depth + 1),
    ])
  }
  return []
}

/**
 * Classify a failed identity-bearing customer create for the relay route.
 * Bridge reports both "a customer with this email already exists" and "this
 * signed_agreement_id was already used" as `400 invalid_parameters`, so the
 * code alone cannot tell them apart — the field named in message/source can.
 * Agreement errors are checked first: "signed_agreement_id has already been
 * used" must read as agreement, not duplicate. The exact wording of Bridge's
 * duplicate-tax-ID rejection is unevidenced as of 2026-09-03; the fixtures in
 * bridge.test.ts are the contract and get replaced by sandbox captures.
 */
export function classifyBridgeCustomerError(err: BridgeApiError): BridgeCustomerErrorKind {
  if (err.status >= 500) return 'unavailable'
  const body = (err.body ?? {}) as { code?: unknown; message?: unknown; source?: unknown }
  const haystack = [
    typeof body.code === 'string' ? body.code : '',
    typeof body.message === 'string' ? body.message : '',
    ...flattenSource(body.source),
  ]
    .join(' ')
    .toLowerCase()

  if (/signed_agreement|agreement_id|terms_of_service/.test(haystack)) return 'agreement'
  if (/duplicate|already[ _](been[ _])?(taken|exist|exists|used|registered)/.test(haystack)) {
    return 'duplicate'
  }
  return 'rejected'
}

// ToS URLs must be generated per-session through the API — a statically
// constructed dashboard link yields a signed_agreement_id that Bridge
// rejects at customer creation.
export async function createTosLink(redirectUri: string): Promise<{ url: string }> {
  const response = (await bridgeFetch('/v0/customers/tos_links', {
    method: 'POST',
    headers: { 'Idempotency-Key': crypto.randomUUID() },
  })) as { url?: string; data?: { url?: string } }

  const url = response.url ?? response.data?.url
  if (!url) {
    throw new BridgeApiError(502, { code: 'tos_link_missing_url' })
  }

  const tosUrl = new URL(url)
  tosUrl.searchParams.set('redirect_uri', redirectUri)
  return { url: tosUrl.toString() }
}

// rejection_reasons[].reason is Bridge's customer-facing explanation;
// developer_reason is internal detail and is dropped here so it can never
// reach a client or a log line.
export interface BridgeCustomerEndorsement {
  name: string
  status: string
}

export interface BridgeCustomerSnapshot {
  status: string | undefined
  rejectionReasons: string[]
  /** Per-endorsement status (base, spei, …). Empty when Bridge omits the array. */
  endorsements: BridgeCustomerEndorsement[]
}

export async function getBridgeCustomer(customerId: string): Promise<BridgeCustomerSnapshot> {
  const customer = (await bridgeFetch(`/v0/customers/${customerId}`)) as {
    status?: string
    rejection_reasons?: Array<{ reason?: string; developer_reason?: string }>
    endorsements?: Array<{ name?: string; status?: string }>
  }

  return {
    status: customer.status,
    rejectionReasons: (customer.rejection_reasons ?? [])
      .map((r) => r.reason)
      .filter((reason): reason is string => Boolean(reason)),
    endorsements: (customer.endorsements ?? [])
      .filter((e): e is { name: string; status: string } => Boolean(e.name) && Boolean(e.status))
      .map((e) => ({ name: e.name, status: e.status })),
  }
}

// MXN payouts ride the SPEI endorsement. Whether customer-level `approved`
// already implies it is an open fact (2026-09-03); this reads the endorsement
// itself so the runbook and the pilot can check the stricter signal.
export function isPayoutReady(customer: Pick<BridgeCustomerSnapshot, 'endorsements'>): boolean {
  return customer.endorsements.some((e) => e.name === 'spei' && e.status === 'approved')
}

// Registers a recipient's MXN CLABE account with Bridge so payouts (slice 5)
// can reference it. Names arrive already structured (first/last verbatim —
// last_name carries both Mexican surnames); nothing here derives or splits.
// A 201 means "registered", not "verified" — Bridge validates the CLABE
// check digit but performs no Verification-of-Payee for MXN.
export async function createExternalAccount(
  customerId: string,
  data: { firstName: string; lastName: string; clabe: string },
): Promise<{ id: string }> {
  const account = (await bridgeFetch(`/v0/customers/${customerId}/external_accounts`, {
    method: 'POST',
    headers: { 'Idempotency-Key': crypto.randomUUID() },
    body: JSON.stringify({
      currency: 'mxn',
      account_owner_name: `${data.firstName} ${data.lastName}`,
      account_owner_type: 'individual',
      first_name: data.firstName,
      last_name: data.lastName,
      account_type: 'clabe',
      clabe: { account_number: data.clabe },
    }),
  })) as { id: string }

  return { id: account.id }
}

// Used to adopt an already-registered account when a create hits Bridge's
// per-customer CLABE dedupe (duplicate_external_account) — e.g. a lost
// response or failed DB insert on a prior attempt. Bridge only returns the
// CLABE's last 4 (clabe.last_4), so matching is by last4; the full number
// never comes back over the wire.
export async function listExternalAccounts(
  customerId: string,
): Promise<Array<{ id: string; clabeLast4: string | null }>> {
  const response = (await bridgeFetch(`/v0/customers/${customerId}/external_accounts`)) as {
    data?: Array<{ id: string; clabe?: { last_4?: string } }>
  }

  return (response.data ?? []).map((account) => ({
    id: account.id,
    clabeLast4: account.clabe?.last_4 ?? null,
  }))
}

// Indicative FX rate — Bridge offers no rate lock (rates refresh ~30s). The
// buy_rate is the executable side quotes are priced from (docs/ledger-rules.md).
// Rates stay strings end-to-end; parsing/validation happens in services/quotes.ts.
export async function getExchangeRate(
  from: string,
  to: string,
): Promise<{
  midmarketRate: string
  buyRate: string
  sellRate: string
  updatedAt: string
}> {
  const params = new URLSearchParams({ from, to })
  const rates = (await bridgeFetch(`/v0/exchange_rates?${params.toString()}`)) as {
    midmarket_rate: string
    buy_rate: string
    sell_rate: string
    updated_at: string
  }

  return {
    midmarketRate: rates.midmarket_rate,
    buyRate: rates.buy_rate,
    sellRate: rates.sell_rate,
    updatedAt: rates.updated_at,
  }
}

export interface CreateBridgePayoutInput {
  idempotencyKey: string // = transfers.idempotency_key
  clientReferenceId: string // = transfer UUID
  onBehalfOf: string // sender's bridge_customer_id
  sourceWalletId: string // env.BRIDGE_TREASURY_WALLET_ID
  destinationExternalAccountId: string // payout_destinations.provider_account_ref
  destinationAmountMxn: string // decimal string, exactly 2dp, from receive_amount_minor
}

export interface BridgePayoutResult {
  bridgeTransferId: string
  state: string // raw Bridge state
  sourceAmount: string // actual USDC draw, decimal string — caller does strict decimal→minor
}

// Every field must come from immutable transfer terms — no clocks, no
// randomness, no derived values — and the key order is fixed, so a retry
// serializes byte-identically (Bridge 422s on same-Idempotency-Key/
// different-body).
function buildPayoutBody(input: CreateBridgePayoutInput): string {
  return JSON.stringify({
    on_behalf_of: input.onBehalfOf,
    client_reference_id: input.clientReferenceId,
    developer_fee: '0',
    source: {
      payment_rail: 'bridge_wallet',
      currency: 'usdc',
      bridge_wallet_id: input.sourceWalletId,
    },
    destination: {
      payment_rail: 'spei',
      currency: 'mxn',
      external_account_id: input.destinationExternalAccountId,
      // Fixed receive amount: the customer was quoted an exact MXN figure;
      // Bridge computes the USDC draw and reports it as source.amount.
      amount: input.destinationAmountMxn,
    },
  })
}

// The id is the only field a caller cannot proceed without; state/source.amount
// are passed through raw (empty string if absent) — the submit job's strict
// decimal parser rejects malformed amounts before any minor-unit conversion.
function parseTransferResponse(response: unknown): BridgePayoutResult {
  const transfer = response as {
    id?: string
    state?: string
    source?: { amount?: string }
  }
  if (!transfer.id) {
    throw new BridgeApiError(502, { code: 'bridge_transfer_missing_id' })
  }
  return {
    bridgeTransferId: transfer.id,
    state: transfer.state ?? '',
    sourceAmount: transfer.source?.amount ?? '',
  }
}

// USD→MXN stablecoin-sandwich payout: treasury wallet USDC → SPEI/MXN.
// Idempotency-Key = transfers.idempotency_key, so a crash-recovery re-POST
// with the byte-identical body returns the existing transfer instead of
// creating a second one. Sandbox-verified: payouts are never cancelable after
// creation; concurrent payouts serialize (loser gets a sync 400, no transfer
// created); MXN destination minimum is $2.00 USD; client_reference_id
// round-trips. Sandbox-UNVERIFIED until the PR 3 e2e: the exact field names
// source.bridge_wallet_id and destination.amount (fixed-receive placement) —
// verify there before relying on them in prod.
export async function createBridgePayout(
  input: CreateBridgePayoutInput,
): Promise<BridgePayoutResult> {
  const response = await bridgeFetch('/v0/transfers', {
    method: 'POST',
    headers: { 'Idempotency-Key': input.idempotencyKey },
    body: buildPayoutBody(input),
  })

  return parseTransferResponse(response)
}

// Polling backstop for missed webhooks (payout.poll cron).
export async function getBridgeTransfer(bridgeTransferId: string): Promise<BridgePayoutResult> {
  const response = await bridgeFetch(`/v0/transfers/${bridgeTransferId}`)
  return parseTransferResponse(response)
}

// ── Reconciliation reads (slice-8 O2) ───────────────────────────────────────
// Read-only inputs for the daily ledger.reconcile cron. Both endpoints were
// verified live against the sandbox 2026-07-31: GET /v0/transfers and
// GET /v0/wallets return { count, data: [...] }.

export interface BridgeTransferListItem {
  bridgeTransferId: string
  clientReferenceId: string | null
  state: string
  createdAt: string
}

/**
 * Newest Bridge transfers on this developer account (orphan detection input).
 * Bounded by `limit` — the caller must treat a full page as a truncated view,
 * never as "everything" (no-silent-caps rule in the recon job).
 */
export async function listBridgeTransfers(limit: number): Promise<BridgeTransferListItem[]> {
  const response = (await bridgeFetch(`/v0/transfers?limit=${limit}`)) as {
    data?: Array<{
      id?: string
      client_reference_id?: string | null
      state?: string
      created_at?: string
    }>
  }
  if (!Array.isArray(response.data)) {
    throw new BridgeApiError(502, { code: 'bridge_transfer_list_malformed' })
  }
  return response.data
    .filter((t) => typeof t.id === 'string' && t.id !== '')
    .map((t) => ({
      bridgeTransferId: t.id as string,
      clientReferenceId: t.client_reference_id ?? null,
      state: t.state ?? '',
      createdAt: t.created_at ?? '',
    }))
}

export interface BridgeWalletBalance {
  currency: string
  /** Decimal string as Bridge reports it (e.g. "5.69") — caller parses strictly. */
  balance: string
}

/**
 * Balances of one wallet, found via the developer-wide GET /v0/wallets list —
 * env carries only BRIDGE_TREASURY_WALLET_ID, not its owning customer id, and
 * the per-customer read needs both. Throws when the wallet isn't in the first
 * page: the treasury wallet missing from its own account is itself a finding.
 */
export async function getBridgeWalletBalances(walletId: string): Promise<BridgeWalletBalance[]> {
  const response = (await bridgeFetch('/v0/wallets?limit=100')) as {
    data?: Array<{
      id?: string
      balances?: Array<{ balance?: string; currency?: string }>
    }>
  }
  if (!Array.isArray(response.data)) {
    throw new BridgeApiError(502, { code: 'bridge_wallet_list_malformed' })
  }
  const wallet = response.data.find((w) => w.id === walletId)
  if (!wallet) {
    throw new BridgeApiError(502, { code: 'bridge_treasury_wallet_not_found' })
  }
  return (wallet.balances ?? [])
    .filter((b) => typeof b.balance === 'string' && typeof b.currency === 'string')
    .map((b) => ({ currency: b.currency as string, balance: b.balance as string }))
}

export async function getKycLink(
  customerId: string,
  redirectUri: string,
): Promise<{ url: string }> {
  const params = new URLSearchParams({ endorsement: 'spei', redirect_uri: redirectUri })
  const link = (await bridgeFetch(
    `/v0/customers/${customerId}/kyc_link?${params.toString()}`,
  )) as { url: string }

  return { url: link.url }
}

// ── Onramp create (funding-ops slice 3) ─────────────────────────────────────

export interface CreateBridgeOnrampInput {
  /** Our transfer UUID — becomes client_reference_id AND keys the Bridge Idempotency-Key. */
  transferId: string
  /** Sender's bridge_customer_id. */
  onBehalfOf: string
  /** env.BRIDGE_TREASURY_WALLET_ID — where the deposit lands as USDC. */
  treasuryWalletId: string
  /** Transfer total (send + fee) as a 2dp decimal string, from minorToDecimal. */
  amountUsd: string
}

// Same byte-identical-retry rule as buildPayoutBody: every field comes from
// immutable transfer terms, fixed key order — a retry under the same
// Idempotency-Key must serialize identically (Bridge 422s on same-key/
// different-body). Key order matches the runbook §2 curl, the manual
// convention this replaces.
function buildOnrampBody(input: CreateBridgeOnrampInput): string {
  return JSON.stringify({
    amount: input.amountUsd,
    on_behalf_of: input.onBehalfOf,
    // Bridge documents developer_fee as required — always zero here.
    developer_fee: '0',
    // The sender funds Bridge's coordinates out of band; ach_push canonicalizes
    // to 'ach' at attach time (DEPOSIT_RAIL_MAP below).
    source: { payment_rail: 'ach_push', currency: 'usd' },
    // destination payment_rail is the CHAIN name ('base'), not 'bridge_wallet'
    // — learned live 2026-08-18 (runbook §2 gotchas).
    destination: {
      payment_rail: 'base',
      currency: 'usdc',
      bridge_wallet_id: input.treasuryWalletId,
    },
    client_reference_id: input.transferId,
  })
}

/**
 * USD onramp into the treasury wallet — the deposit target auto-created at
 * confirm (funding.onramp_prepare job). Idempotency-Key `onramp-<transferId>`
 * is the SAME convention the runbook curl uses, so a mixed manual/auto history
 * can never double-create an onramp for one transfer: a byte-identical retry
 * returns the existing onramp, and a curl-created onramp with a differently
 * serialized body makes this 422 rather than mint a second deposit target
 * (the slice-1 attach button is the recovery path).
 */
export async function createBridgeOnramp(
  input: CreateBridgeOnrampInput,
): Promise<{ bridgeTransferId: string; state: string }> {
  const response = await bridgeFetch('/v0/transfers', {
    method: 'POST',
    headers: { 'Idempotency-Key': `onramp-${input.transferId}` },
    body: buildOnrampBody(input),
  })
  const { bridgeTransferId, state } = parseTransferResponse(response)
  return { bridgeTransferId, state }
}

// ── Onramp deposit instructions (#199) ──────────────────────────────────────

// Bridge's deposit rail names → Puente's canonical stored values. An explicit
// allowlist, not a string transformation: the deposit_instructions table
// constrains payment_rail to ('ach','wire','fednow'), and the first real prod
// attach (2026-08-18) failed at that constraint because Bridge returned
// 'ach_push' and we persisted it raw. Unknown rails throw — refuse loudly and
// involve a human rather than store a rail we don't recognize.
const DEPOSIT_RAIL_MAP: Record<string, 'ach' | 'wire' | 'fednow'> = {
  ach: 'ach',
  ach_push: 'ach',
  wire: 'wire',
  fednow: 'fednow',
}

export interface BridgeDepositInstructions {
  paymentRail: 'ach' | 'wire' | 'fednow'
  currency: string
  /** Decimal string as Bridge reports it — caller parses strictly. */
  amount: string | null
  bankName: string
  bankRoutingNumber: string
  bankAccountNumber: string
  bankBeneficiaryName: string | null
  /** The reference code Bridge matches the incoming deposit by. */
  depositMessage: string
}

/**
 * source_deposit_instructions from a hand-created onramp transfer — the bank
 * coordinates the sender must wire/ACH money to, plus the reference code that
 * ties the deposit to the transfer at Bridge. Throws BridgeApiError(502) when
 * the object has no instructions (a payout, or an onramp Bridge hasn't issued
 * coordinates for yet) or when a load-bearing field is missing — the ops
 * action must refuse loudly rather than store a partial set the sender would
 * then wire money against.
 */
export async function getBridgeDepositInstructions(
  bridgeTransferId: string,
): Promise<BridgeDepositInstructions> {
  const response = (await bridgeFetch(`/v0/transfers/${bridgeTransferId}`)) as {
    source_deposit_instructions?: {
      payment_rail?: string
      currency?: string
      amount?: string
      bank_name?: string
      bank_routing_number?: string
      bank_account_number?: string
      bank_beneficiary_name?: string
      deposit_message?: string
    }
  }
  const raw = response.source_deposit_instructions
  if (!raw) {
    throw new BridgeApiError(502, { code: 'bridge_no_deposit_instructions' })
  }
  const required = {
    paymentRail: raw.payment_rail,
    currency: raw.currency,
    bankName: raw.bank_name,
    bankRoutingNumber: raw.bank_routing_number,
    bankAccountNumber: raw.bank_account_number,
    depositMessage: raw.deposit_message,
  }
  for (const [field, value] of Object.entries(required)) {
    if (typeof value !== 'string' || value.trim() === '') {
      throw new BridgeApiError(502, {
        code: 'bridge_deposit_instructions_incomplete',
        field,
      })
    }
  }
  const rail = DEPOSIT_RAIL_MAP[required.paymentRail!.toLowerCase()]
  if (!rail) {
    throw new BridgeApiError(502, {
      code: 'bridge_unsupported_deposit_rail',
      rail: required.paymentRail,
    })
  }
  return {
    paymentRail: rail,
    currency: required.currency!.toLowerCase(),
    amount: raw.amount ?? null,
    bankName: required.bankName!,
    bankRoutingNumber: required.bankRoutingNumber!,
    bankAccountNumber: required.bankAccountNumber!,
    bankBeneficiaryName: raw.bank_beneficiary_name ?? null,
    depositMessage: required.depositMessage!,
  }
}
