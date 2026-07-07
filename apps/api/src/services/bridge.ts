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
