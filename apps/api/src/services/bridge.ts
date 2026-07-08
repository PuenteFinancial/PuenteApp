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
