import { describe, it, expect, vi, beforeEach } from 'vitest'
import {
  createBridgeCustomer,
  createExternalAccount,
  createTosLink,
  getBridgeCustomer,
  getExchangeRate,
  getKycLink,
  listExternalAccounts,
  BridgeApiError,
} from './bridge.js'

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

describe('createTosLink', () => {
  it('POSTs with an idempotency key and appends redirect_uri to the returned url', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse(200, { url: 'https://dashboard.bridge.xyz/accept-terms-of-service?session_token=tok_1' }),
    )

    const result = await createTosLink('https://puentefinancial.com/onboarding/kyc/tos-return')

    const [url, init] = fetchMock.mock.calls[0]!
    expect(url).toBe('https://api.bridge.test/v0/customers/tos_links')
    expect(init.method).toBe('POST')
    expect(init.headers['Idempotency-Key']).toMatch(/[0-9a-f-]{36}/)
    expect(result.url).toBe(
      'https://dashboard.bridge.xyz/accept-terms-of-service?session_token=tok_1&redirect_uri=https%3A%2F%2Fpuentefinancial.com%2Fonboarding%2Fkyc%2Ftos-return',
    )
  })

  it('handles the enveloped { data: { url } } response shape', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse(200, { data: { url: 'https://compliance.bridge.xyz/accept-terms-of-service?session_token=tok_2' } }),
    )
    const result = await createTosLink('https://x.test/return')
    expect(result.url).toContain('session_token=tok_2')
    expect(result.url).toContain('redirect_uri=https%3A%2F%2Fx.test%2Freturn')
  })

  it('throws BridgeApiError when no url is returned', async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, {}))
    await expect(createTosLink('https://x.test/return')).rejects.toBeInstanceOf(BridgeApiError)
  })

  it('throws BridgeApiError on non-2xx', async () => {
    fetchMock.mockResolvedValue(jsonResponse(401, { code: 'invalid_credentials' }))
    await expect(createTosLink('https://x.test/return')).rejects.toBeInstanceOf(BridgeApiError)
  })
})

describe('createExternalAccount', () => {
  const input = {
    firstName: 'María del Carmen',
    lastName: 'García López',
    clabe: '646180003000000006',
  }

  it('POSTs the sandbox-verified CLABE payload with names passed verbatim', async () => {
    fetchMock.mockResolvedValue(jsonResponse(201, { id: 'ea_123' }))

    const result = await createExternalAccount('cust_abc', input)

    expect(result).toEqual({ id: 'ea_123' })
    const [url, init] = fetchMock.mock.calls[0]!
    expect(url).toBe('https://api.bridge.test/v0/customers/cust_abc/external_accounts')
    expect(init.method).toBe('POST')
    expect(init.headers['Api-Key']).toBe('bridge_test_key')
    expect(init.headers['Idempotency-Key']).toMatch(/[0-9a-f-]{36}/)
    expect(JSON.parse(init.body)).toEqual({
      currency: 'mxn',
      account_owner_name: 'María del Carmen García López',
      account_owner_type: 'individual',
      first_name: 'María del Carmen',
      last_name: 'García López',
      account_type: 'clabe',
      clabe: { account_number: '646180003000000006' },
    })
  })

  it('uses a fresh idempotency key per call', async () => {
    fetchMock.mockResolvedValue(jsonResponse(201, { id: 'ea_123' }))
    await createExternalAccount('cust_abc', input)
    await createExternalAccount('cust_abc', input)
    const keys = fetchMock.mock.calls.map(([, init]) => init.headers['Idempotency-Key'])
    expect(keys[0]).not.toBe(keys[1])
  })

  it('throws BridgeApiError on non-2xx without leaking the body in the message', async () => {
    fetchMock.mockResolvedValue(jsonResponse(400, { code: 'invalid_clabe' }))

    const err = await createExternalAccount('cust_abc', input).catch((e: unknown) => e)

    expect(err).toBeInstanceOf(BridgeApiError)
    expect((err as BridgeApiError).status).toBe(400)
    expect((err as BridgeApiError).message).not.toContain('invalid_clabe')
  })
})

describe('listExternalAccounts', () => {
  it('GETs the list and maps ids with clabe last4', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse(200, {
        count: 2,
        data: [
          { id: 'ea_1', clabe: { last_4: '0006' } },
          { id: 'ea_2' }, // non-clabe account (e.g. us bank) has no clabe key
        ],
      }),
    )

    const result = await listExternalAccounts('cust_abc')

    const [url] = fetchMock.mock.calls[0]!
    expect(url).toBe('https://api.bridge.test/v0/customers/cust_abc/external_accounts')
    expect(result).toEqual([
      { id: 'ea_1', clabeLast4: '0006' },
      { id: 'ea_2', clabeLast4: null },
    ])
  })

  it('returns [] when data is missing', async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, { count: 0 }))
    expect(await listExternalAccounts('cust_abc')).toEqual([])
  })

  it('throws BridgeApiError on non-2xx', async () => {
    fetchMock.mockResolvedValue(jsonResponse(500, null))
    await expect(listExternalAccounts('cust_abc')).rejects.toBeInstanceOf(BridgeApiError)
  })
})

describe('getBridgeCustomer', () => {
  it('GETs the customer and maps customer-facing rejection reasons', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse(200, {
        id: 'cust_abc',
        status: 'rejected',
        rejection_reasons: [
          { reason: 'ID photo could not be read', developer_reason: 'ocr_confidence_low' },
          { developer_reason: 'internal_only_no_customer_reason' },
          { reason: 'Address document expired' },
        ],
      }),
    )

    const result = await getBridgeCustomer('cust_abc')

    const [url] = fetchMock.mock.calls[0]!
    expect(url).toBe('https://api.bridge.test/v0/customers/cust_abc')
    expect(result).toEqual({
      status: 'rejected',
      rejectionReasons: ['ID photo could not be read', 'Address document expired'],
    })
  })

  it('returns empty reasons when rejection_reasons is missing', async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, { id: 'cust_abc', status: 'active' }))
    const result = await getBridgeCustomer('cust_abc')
    expect(result).toEqual({ status: 'active', rejectionReasons: [] })
  })

  it('throws BridgeApiError on non-2xx', async () => {
    fetchMock.mockResolvedValue(jsonResponse(404, { code: 'not_found' }))
    await expect(getBridgeCustomer('cust_missing')).rejects.toBeInstanceOf(BridgeApiError)
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

describe('getExchangeRate', () => {
  const rateBody = {
    midmarket_rate: '20.00025',
    buy_rate: '20.100251',
    sell_rate: '19.900249',
    updated_at: '2026-07-17T14:00:00.000Z',
  }

  it('GETs the pair and passes rate strings through untouched', async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, rateBody))

    const result = await getExchangeRate('usd', 'mxn')

    expect(result).toEqual({
      midmarketRate: '20.00025',
      buyRate: '20.100251',
      sellRate: '19.900249',
      updatedAt: '2026-07-17T14:00:00.000Z',
    })
    const [url, init] = fetchMock.mock.calls[0]!
    expect(url).toBe('https://api.bridge.test/v0/exchange_rates?from=usd&to=mxn')
    expect(init.method ?? 'GET').toBe('GET')
    expect(init.headers['Api-Key']).toBe('bridge_test_key')
    // GETs must not carry an idempotency key (Bridge rejects it on non-POST)
    expect(init.headers['Idempotency-Key']).toBeUndefined()
  })

  it('throws BridgeApiError on non-2xx', async () => {
    fetchMock.mockResolvedValue(jsonResponse(503, { code: 'rate_unavailable' }))
    await expect(getExchangeRate('usd', 'mxn')).rejects.toBeInstanceOf(BridgeApiError)
  })
})
