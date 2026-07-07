import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createBridgeCustomer, getKycLink, BridgeApiError } from './bridge.js'

const fetchMock = vi.fn()
vi.stubGlobal('fetch', fetchMock)

function jsonResponse(status: number, body: unknown) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  }
}

beforeEach(() => {
  fetchMock.mockReset()
})

describe('createBridgeCustomer', () => {
  it('POSTs the customer with an idempotency key and returns the id', async () => {
    fetchMock.mockResolvedValue(jsonResponse(201, { id: 'cust_abc' }))

    const result = await createBridgeCustomer({
      firstName: 'Test',
      lastName: 'User',
      email: 'test@example.com',
      signedAgreementId: 'agr_123',
    })

    expect(result).toEqual({ id: 'cust_abc' })
    const [url, init] = fetchMock.mock.calls[0]!
    expect(url).toBe('https://api.bridge.test/v0/customers')
    expect(init.method).toBe('POST')
    expect(init.headers['Api-Key']).toBe('bridge_test_key')
    expect(init.headers['Idempotency-Key']).toMatch(/[0-9a-f-]{36}/)
    expect(JSON.parse(init.body)).toEqual({
      type: 'individual',
      first_name: 'Test',
      last_name: 'User',
      email: 'test@example.com',
      signed_agreement_id: 'agr_123',
    })
  })

  it('uses a fresh idempotency key per call', async () => {
    fetchMock.mockResolvedValue(jsonResponse(201, { id: 'cust_abc' }))
    const input = {
      firstName: 'Test',
      lastName: 'User',
      email: 'test@example.com',
      signedAgreementId: 'agr_123',
    }
    await createBridgeCustomer(input)
    await createBridgeCustomer(input)
    const keys = fetchMock.mock.calls.map(([, init]) => init.headers['Idempotency-Key'])
    expect(keys[0]).not.toBe(keys[1])
  })

  it('throws BridgeApiError with status and body on non-2xx', async () => {
    fetchMock.mockResolvedValue(jsonResponse(422, { code: 'invalid_email' }))

    const err = await createBridgeCustomer({
      firstName: 'Test',
      lastName: 'User',
      email: 'bad',
      signedAgreementId: 'agr_123',
    }).catch((e: unknown) => e)

    expect(err).toBeInstanceOf(BridgeApiError)
    expect((err as BridgeApiError).status).toBe(422)
    expect((err as BridgeApiError).body).toEqual({ code: 'invalid_email' })
    // message must not leak the response body (may contain PII)
    expect((err as BridgeApiError).message).not.toContain('invalid_email')
  })
})

describe('getKycLink', () => {
  it('GETs the kyc link with endorsement and encoded redirect_uri', async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, { url: 'https://bridge.example/kyc/xyz' }))

    const result = await getKycLink('cust_abc', 'https://puentefinancial.com/onboarding/kyc/return')

    expect(result).toEqual({ url: 'https://bridge.example/kyc/xyz' })
    const [url] = fetchMock.mock.calls[0]!
    expect(url).toBe(
      'https://api.bridge.test/v0/customers/cust_abc/kyc_link?endorsement=spei&redirect_uri=https%3A%2F%2Fpuentefinancial.com%2Fonboarding%2Fkyc%2Freturn',
    )
  })

  it('throws BridgeApiError on non-2xx', async () => {
    fetchMock.mockResolvedValue(jsonResponse(404, { code: 'not_found' }))
    await expect(getKycLink('cust_missing', 'https://x.test/return')).rejects.toBeInstanceOf(
      BridgeApiError,
    )
  })
})
