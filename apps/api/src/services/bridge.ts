import crypto from 'node:crypto'
import { env } from '../config/env.js'

export class BridgeApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly body: unknown,
  ) {
    // Bridge error bodies can contain request PII — keep the message to status only
    super(`Bridge API request failed with status ${status}`)
    this.name = 'BridgeApiError'
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
export async function getBridgeCustomer(customerId: string): Promise<{
  status: string | undefined
  rejectionReasons: string[]
}> {
  const customer = (await bridgeFetch(`/v0/customers/${customerId}`)) as {
    status?: string
    rejection_reasons?: Array<{ reason?: string; developer_reason?: string }>
  }

  return {
    status: customer.status,
    rejectionReasons: (customer.rejection_reasons ?? [])
      .map((r) => r.reason)
      .filter((reason): reason is string => Boolean(reason)),
  }
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
