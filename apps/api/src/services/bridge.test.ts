import { describe, it, expect, vi, beforeEach } from 'vitest'
import {
  BRIDGE_KYC_STATUS_MAP,
  classifyBridgeCustomerError,
  createBridgeCustomer,
  createBridgeCustomerWithIdentity,
  createBridgeOnramp,
  createBridgePayout,
  createExternalAccount,
  createTosLink,
  getBridgeCustomer,
  getBridgeTransfer,
  getExchangeRate,
  getKycLink,
  isPayoutReady,
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
    // body must be NON-ENUMERABLE: console.error / util.inspect / JSON print
    // enumerable own properties, and Bridge error bodies can echo request PII
    expect(Object.keys(err as object)).not.toContain('body')
    expect(JSON.stringify(err)).not.toContain('invalid_email')
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
      endorsements: [],
    })
  })

  it('returns empty reasons when rejection_reasons is missing', async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, { id: 'cust_abc', status: 'active' }))
    const result = await getBridgeCustomer('cust_abc')
    expect(result).toEqual({ status: 'active', rejectionReasons: [], endorsements: [] })
  })

  it('throws BridgeApiError on non-2xx', async () => {
    fetchMock.mockResolvedValue(jsonResponse(404, { code: 'not_found' }))
    await expect(getBridgeCustomer('cust_missing')).rejects.toBeInstanceOf(BridgeApiError)
  })

  it('parses per-endorsement statuses and drops malformed entries', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse(200, {
        id: 'cust_abc',
        status: 'active',
        endorsements: [
          { name: 'base', status: 'approved', requirements: { complete: ['first_name'] } },
          { name: 'spei', status: 'incomplete' },
          { name: 'sepa' },
          { status: 'approved' },
        ],
      }),
    )
    const result = await getBridgeCustomer('cust_abc')
    expect(result.endorsements).toEqual([
      { name: 'base', status: 'approved' },
      { name: 'spei', status: 'incomplete' },
    ])
  })
})

describe('isPayoutReady', () => {
  it('is true only when the spei endorsement is approved', () => {
    expect(isPayoutReady({ endorsements: [{ name: 'spei', status: 'approved' }] })).toBe(true)
    expect(isPayoutReady({ endorsements: [{ name: 'spei', status: 'incomplete' }] })).toBe(false)
    expect(isPayoutReady({ endorsements: [{ name: 'base', status: 'approved' }] })).toBe(false)
    expect(isPayoutReady({ endorsements: [] })).toBe(false)
  })
})

describe('createBridgeCustomerWithIdentity (K6 relay)', () => {
  const input = {
    userId: '11111111-1111-4111-8111-111111111111',
    firstName: 'Ana',
    lastName: 'García López',
    email: 'ana@example.com',
    signedAgreementId: 'agr_123',
    birthDate: '1987-03-21',
    address: {
      streetLine1: '123 Main St',
      streetLine2: 'Apt 4',
      city: 'Denver',
      subdivision: 'CO',
      postalCode: '80202',
    },
    taxId: { type: 'ssn' as const, number: '078051120' },
  }

  it('POSTs the full identity body in fixed key order with base+spei endorsements', async () => {
    fetchMock.mockResolvedValue(jsonResponse(201, { id: 'cust_new', status: 'incomplete' }))

    const result = await createBridgeCustomerWithIdentity(input)

    expect(result).toEqual({ id: 'cust_new', status: 'incomplete' })
    const [url, init] = fetchMock.mock.calls[0]!
    expect(url).toBe('https://api.bridge.test/v0/customers')
    expect(init.method).toBe('POST')
    // Key order is the byte-identical-retry contract, so compare the string.
    expect(init.body).toBe(
      JSON.stringify({
        type: 'individual',
        first_name: 'Ana',
        last_name: 'García López',
        email: 'ana@example.com',
        signed_agreement_id: 'agr_123',
        birth_date: '1987-03-21',
        residential_address: {
          street_line_1: '123 Main St',
          street_line_2: 'Apt 4',
          city: 'Denver',
          subdivision: 'CO',
          postal_code: '80202',
          country: 'USA',
        },
        identifying_information: [{ type: 'ssn', issuing_country: 'usa', number: '078051120' }],
        endorsements: ['base', 'spei'],
      }),
    )
  })

  it('omits street_line_2 when absent and sends itin as its own type', async () => {
    fetchMock.mockResolvedValue(jsonResponse(201, { id: 'cust_new' }))
    await createBridgeCustomerWithIdentity({
      ...input,
      address: { ...input.address, streetLine2: null },
      taxId: { type: 'itin', number: '912345678' },
    })
    const body = JSON.parse(fetchMock.mock.calls[0]![1].body)
    expect(body.residential_address).not.toHaveProperty('street_line_2')
    expect(body.identifying_information).toEqual([
      { type: 'itin', issuing_country: 'usa', number: '912345678' },
    ])
  })

  it('derives the same idempotency key for the same input, namespaced by user', async () => {
    fetchMock.mockResolvedValue(jsonResponse(201, { id: 'cust_new' }))
    await createBridgeCustomerWithIdentity(input)
    await createBridgeCustomerWithIdentity(input)
    const keys = fetchMock.mock.calls.map(([, init]) => init.headers['Idempotency-Key'])
    expect(keys[0]).toBe(keys[1])
    expect(keys[0]).toMatch(/^bridge-customer-11111111-1111-4111-8111-111111111111-[0-9a-f]{16}$/)
  })

  it('derives a different key when the body changes (the one correction attempt)', async () => {
    fetchMock.mockResolvedValue(jsonResponse(201, { id: 'cust_new' }))
    await createBridgeCustomerWithIdentity(input)
    await createBridgeCustomerWithIdentity({ ...input, birthDate: '1987-03-12' })
    const keys = fetchMock.mock.calls.map(([, init]) => init.headers['Idempotency-Key'])
    expect(keys[0]).not.toBe(keys[1])
  })

  it('never carries the identity into the thrown error', async () => {
    fetchMock.mockResolvedValue(jsonResponse(400, { code: 'invalid_parameters' }))
    const err = await createBridgeCustomerWithIdentity(input).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(BridgeApiError)
    expect(JSON.stringify(err)).not.toContain('078051120')
    expect((err as Error).message).not.toContain('1987')
  })
})

describe('classifyBridgeCustomerError', () => {
  const at = (status: number, body: unknown) => classifyBridgeCustomerError(new BridgeApiError(status, body))

  it('5xx and empty bodies are unavailable / rejected', () => {
    expect(at(502, null)).toBe('unavailable')
    expect(at(500, { code: 'internal' })).toBe('unavailable')
    expect(at(422, null)).toBe('rejected')
    expect(at(400, { code: 'invalid_parameters', message: 'birth_date is invalid' })).toBe('rejected')
  })

  it('reads a consumed or bad signed_agreement_id as agreement, even when phrased as already used', () => {
    expect(
      at(400, {
        code: 'invalid_parameters',
        message: 'signed_agreement_id has already been used',
      }),
    ).toBe('agreement')
    expect(
      at(400, { code: 'invalid_parameters', source: { key: { signed_agreement_id: 'is invalid' } } }),
    ).toBe('agreement')
  })

  it('reads one-per-email and duplicate-identity rejections as duplicate', () => {
    expect(
      at(400, { code: 'invalid_parameters', source: { key: { email: 'has already been taken' } } }),
    ).toBe('duplicate')
    expect(at(400, { code: 'duplicate_customer' })).toBe('duplicate')
    expect(at(409, { code: 'invalid_parameters', message: 'A customer with this tax id already exists' })).toBe(
      'duplicate',
    )
  })
})

describe('BRIDGE_KYC_STATUS_MAP', () => {
  it('maps Bridge customer statuses onto our KycStatus vocabulary', () => {
    expect(BRIDGE_KYC_STATUS_MAP.active).toBe('approved')
    expect(BRIDGE_KYC_STATUS_MAP.incomplete).toBe('pending')
    expect(BRIDGE_KYC_STATUS_MAP.rejected).toBe('rejected')
    expect(BRIDGE_KYC_STATUS_MAP.manual_review).toBe('manual_review')
    expect(BRIDGE_KYC_STATUS_MAP.unknown_thing).toBeUndefined()
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

describe('createBridgePayout', () => {
  const input = {
    idempotencyKey: 'idem_tr_1',
    clientReferenceId: '3f9a2b1c-4d5e-6f70-8192-a3b4c5d6e7f8',
    onBehalfOf: 'cust_sender',
    sourceWalletId: 'wallet_treasury',
    destinationExternalAccountId: 'ea_dest',
    destinationAmountMxn: '1850.00',
  }

  const createdBody = {
    id: 'transfer_1',
    state: 'awaiting_funds',
    client_reference_id: input.clientReferenceId,
    source: { payment_rail: 'bridge_wallet', currency: 'usdc', amount: '92.11' },
    destination: { payment_rail: 'spei', currency: 'mxn', amount: '1850.00' },
  }

  it('POSTs the exact payout body with the transfer idempotency key', async () => {
    fetchMock.mockResolvedValue(jsonResponse(201, createdBody))

    const result = await createBridgePayout(input)

    expect(result).toEqual({
      bridgeTransferId: 'transfer_1',
      state: 'awaiting_funds',
      sourceAmount: '92.11',
    })
    const [url, init] = fetchMock.mock.calls[0]!
    expect(url).toBe('https://api.bridge.test/v0/transfers')
    expect(init.method).toBe('POST')
    expect(init.headers['Api-Key']).toBe('bridge_test_key')
    // key comes from transfers.idempotency_key, never generated here
    expect(init.headers['Idempotency-Key']).toBe('idem_tr_1')
    expect(JSON.parse(init.body)).toEqual({
      on_behalf_of: 'cust_sender',
      client_reference_id: '3f9a2b1c-4d5e-6f70-8192-a3b4c5d6e7f8',
      developer_fee: '0',
      source: {
        payment_rail: 'bridge_wallet',
        currency: 'usdc',
        bridge_wallet_id: 'wallet_treasury',
      },
      destination: {
        payment_rail: 'spei',
        currency: 'mxn',
        external_account_id: 'ea_dest',
        amount: '1850.00',
      },
    })
    // fixed MXN amount is passed through as-is — no numeric round-trip
    expect(init.body).toContain('"amount":"1850.00"')
  })

  it('serializes a byte-identical body across calls with the same input', async () => {
    fetchMock.mockResolvedValue(jsonResponse(201, createdBody))
    await createBridgePayout(input)
    await createBridgePayout({ ...input })
    const bodies = fetchMock.mock.calls.map(([, init]) => init.body)
    expect(bodies[0]).toBe(bodies[1])
  })

  it('throws statusCode 400 on sync rejection (concurrent serialization / drained wallet)', async () => {
    fetchMock.mockResolvedValue(jsonResponse(400, { code: 'insufficient_funds' }))

    const err = await createBridgePayout(input).catch((e: unknown) => e)

    expect(err).toBeInstanceOf(BridgeApiError)
    expect((err as BridgeApiError).statusCode).toBe(400)
    expect((err as BridgeApiError).message).not.toContain('insufficient_funds')
  })

  it('throws statusCode 422 on idempotency-key body mismatch', async () => {
    fetchMock.mockResolvedValue(jsonResponse(422, { code: 'idempotency_key_mismatch' }))

    const err = await createBridgePayout(input).catch((e: unknown) => e)

    expect(err).toBeInstanceOf(BridgeApiError)
    expect((err as BridgeApiError).statusCode).toBe(422)
  })

  it('throws when the response has no transfer id', async () => {
    fetchMock.mockResolvedValue(jsonResponse(201, { state: 'awaiting_funds' }))
    await expect(createBridgePayout(input)).rejects.toBeInstanceOf(BridgeApiError)
  })
})

describe('createBridgeOnramp', () => {
  const input = {
    transferId: '3f9a2b1c-4d5e-6f70-8192-a3b4c5d6e7f8',
    onBehalfOf: 'cust_sender',
    treasuryWalletId: 'wallet_treasury',
    amountUsd: '57.00',
  }

  const createdBody = {
    id: 'onramp_1',
    state: 'awaiting_funds',
    client_reference_id: input.transferId,
  }

  it('POSTs the exact onramp body under the onramp-<transferId> idempotency key', async () => {
    fetchMock.mockResolvedValue(jsonResponse(201, createdBody))

    const result = await createBridgeOnramp(input)

    expect(result).toEqual({ bridgeTransferId: 'onramp_1', state: 'awaiting_funds' })
    const [url, init] = fetchMock.mock.calls[0]!
    expect(url).toBe('https://api.bridge.test/v0/transfers')
    expect(init.method).toBe('POST')
    // The runbook-curl convention — a mixed manual/auto history can never
    // double-create an onramp for one transfer.
    expect(init.headers['Idempotency-Key']).toBe(`onramp-${input.transferId}`)
    expect(JSON.parse(init.body)).toEqual({
      amount: '57.00',
      on_behalf_of: 'cust_sender',
      developer_fee: '0',
      source: { payment_rail: 'ach_push', currency: 'usd' },
      destination: {
        payment_rail: 'base',
        currency: 'usdc',
        bridge_wallet_id: 'wallet_treasury',
      },
      client_reference_id: input.transferId,
    })
    // amount passes through as-is — no numeric round-trip
    expect(init.body).toContain('"amount":"57.00"')
  })

  it('serializes a byte-identical body across calls with the same input', async () => {
    fetchMock.mockResolvedValue(jsonResponse(201, createdBody))
    await createBridgeOnramp(input)
    await createBridgeOnramp({ ...input })
    const bodies = fetchMock.mock.calls.map(([, init]) => init.body)
    expect(bodies[0]).toBe(bodies[1])
  })

  it('throws statusCode 422 on idempotency-key body mismatch (curl-created onramp)', async () => {
    fetchMock.mockResolvedValue(jsonResponse(422, { code: 'idempotency_key_mismatch' }))

    const err = await createBridgeOnramp(input).catch((e: unknown) => e)

    expect(err).toBeInstanceOf(BridgeApiError)
    expect((err as BridgeApiError).statusCode).toBe(422)
  })

  it('throws when the response has no transfer id', async () => {
    fetchMock.mockResolvedValue(jsonResponse(201, { state: 'awaiting_funds' }))
    await expect(createBridgeOnramp(input)).rejects.toBeInstanceOf(BridgeApiError)
  })
})

describe('getBridgeTransfer', () => {
  it('GETs the transfer without an idempotency key and maps the result', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse(200, {
        id: 'transfer_1',
        state: 'payment_processed',
        source: { amount: '92.11' },
      }),
    )

    const result = await getBridgeTransfer('transfer_1')

    expect(result).toEqual({
      bridgeTransferId: 'transfer_1',
      state: 'payment_processed',
      sourceAmount: '92.11',
    })
    const [url, init] = fetchMock.mock.calls[0]!
    expect(url).toBe('https://api.bridge.test/v0/transfers/transfer_1')
    expect(init.method ?? 'GET').toBe('GET')
    expect(init.headers['Idempotency-Key']).toBeUndefined()
  })

  it('throws BridgeApiError with statusCode 404 when the transfer is unknown', async () => {
    fetchMock.mockResolvedValue(jsonResponse(404, { code: 'not_found' }))

    const err = await getBridgeTransfer('transfer_missing').catch((e: unknown) => e)

    expect(err).toBeInstanceOf(BridgeApiError)
    expect((err as BridgeApiError).statusCode).toBe(404)
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

// ── the request deadline (slice-7 debt pass) ────────────────────────────────
// Every Bridge call is bounded by BRIDGE_TIMEOUT_SECONDS via AbortSignal.timeout
// in bridgeFetch. Without it, fetches inherit undici's ~300s defaults — the
// absence CLAIM_STALE_AFTER_MS's 30-minute era was derived from.
describe('bridgeFetch timeout + failure propagation', () => {
  it('attaches an abort signal to GETs', async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, { midmarket_rate: '20', buy_rate: '20', sell_rate: '20', updated_at: 'x' }))

    await getExchangeRate('usd', 'mxn')

    const [, init] = fetchMock.mock.calls[0]!
    expect(init.signal).toBeInstanceOf(AbortSignal)
  })

  it('attaches an abort signal to POSTs', async () => {
    fetchMock.mockResolvedValue(jsonResponse(201, { id: 'cust_abc' }))

    await createBridgeCustomer({
      firstName: 'Test',
      lastName: 'User',
      email: 'test@example.com',
      signedAgreementId: 'agr_123',
    })

    const [, init] = fetchMock.mock.calls[0]!
    expect(init.signal).toBeInstanceOf(AbortSignal)
  })

  // The spy calls through, so the instance assertions above stay honest; the
  // test env leaves BRIDGE_TIMEOUT_SECONDS unset, so this pins the zod default.
  it('derives the deadline from BRIDGE_TIMEOUT_SECONDS (default 15s) — and attaches THAT signal', async () => {
    const spy = vi.spyOn(AbortSignal, 'timeout')
    fetchMock.mockResolvedValue(jsonResponse(200, { id: 't1', state: 'payment_submitted', source: { amount: '1' } }))

    await getBridgeTransfer('t1')

    expect(spy).toHaveBeenCalledWith(15_000)
    // Identity, not just instance (review fix): a refactor could attach a
    // DIFFERENT signal while an AbortSignal.timeout call still exists
    // somewhere — instance checks stay green and every call silently reverts
    // to undici's ~300s, invalidating CLAIM_STALE_AFTER_MS's derivation.
    const [, init] = fetchMock.mock.calls[0]!
    expect(init.signal).toBe(spy.mock.results[0]!.value)
    spy.mockRestore()
  })

  // Network-level failures (undici TypeError, a fired TimeoutError) propagate
  // UNWRAPPED — they are not BridgeApiError, and callers treat that class
  // generically (routes → 502/503, jobs → pg-boss retry). A wrapper here would
  // change every caller's branch; bounded waiting must not.
  it('propagates a rejected fetch unwrapped, never as BridgeApiError', async () => {
    fetchMock.mockRejectedValue(new TypeError('fetch failed'))

    await expect(getBridgeTransfer('t1')).rejects.toThrow(TypeError)
    await expect(getBridgeTransfer('t1')).rejects.not.toBeInstanceOf(BridgeApiError)
  })
})

describe('getBridgeDepositInstructions', () => {
  const FULL = {
    payment_rail: 'ACH',
    currency: 'USD',
    amount: '100.00',
    bank_name: 'Lead Bank',
    bank_routing_number: '101019644',
    bank_account_number: '215268129123',
    bank_beneficiary_name: 'Bridge Ventures Inc',
    deposit_message: 'BRGABCD1234',
  }

  it.each([
    ['ach_push', 'ach'],
    ['ACH_PUSH', 'ach'],
    ['ach', 'ach'],
    ['wire', 'wire'],
    ['fednow', 'fednow'],
  ])('maps Bridge rail %s to canonical stored rail %s', async (bridgeRail, stored) => {
    fetchMock.mockResolvedValue(
      jsonResponse(200, {
        id: 'onramp_1',
        source_deposit_instructions: { ...FULL, payment_rail: bridgeRail },
      }),
    )
    const { getBridgeDepositInstructions } = await import('./bridge.js')
    const result = await getBridgeDepositInstructions('11111111-1111-4111-8111-111111111111')
    // The stored value must satisfy the deposit_instructions payment_rail
    // check constraint — persisting a raw Bridge rail is the prod bug
    // (2026-08-18: 'ach_push' violated the constraint on the first real attach).
    expect(result.paymentRail).toBe(stored)
  })

  it('rejects an unknown Bridge rail before anything can be persisted', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse(200, {
        id: 'onramp_1',
        source_deposit_instructions: { ...FULL, payment_rail: 'rtp' },
      }),
    )
    const { getBridgeDepositInstructions } = await import('./bridge.js')
    await expect(
      getBridgeDepositInstructions('11111111-1111-4111-8111-111111111111'),
    ).rejects.toMatchObject({ statusCode: 502 })
  })

  it('parses the full set and lowercases rail + currency', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse(200, { id: 'onramp_1', source_deposit_instructions: FULL }),
    )
    const { getBridgeDepositInstructions } = await import('./bridge.js')
    const result = await getBridgeDepositInstructions('11111111-1111-4111-8111-111111111111')
    expect(result).toEqual({
      paymentRail: 'ach',
      currency: 'usd',
      amount: '100.00',
      bankName: 'Lead Bank',
      bankRoutingNumber: '101019644',
      bankAccountNumber: '215268129123',
      bankBeneficiaryName: 'Bridge Ventures Inc',
      depositMessage: 'BRGABCD1234',
    })
  })

  it('tolerates missing optional fields (amount, beneficiary)', async () => {
    const required: Partial<typeof FULL> = { ...FULL }
    delete required.amount
    delete required.bank_beneficiary_name
    fetchMock.mockResolvedValue(
      jsonResponse(200, { id: 'onramp_1', source_deposit_instructions: required }),
    )
    const { getBridgeDepositInstructions } = await import('./bridge.js')
    const result = await getBridgeDepositInstructions('11111111-1111-4111-8111-111111111111')
    expect(result.amount).toBeNull()
    expect(result.bankBeneficiaryName).toBeNull()
  })

  it('throws 502 when the transfer has no instructions at all (a payout)', async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, { id: 'payout_1', state: 'payment_submitted' }))
    const { getBridgeDepositInstructions } = await import('./bridge.js')
    await expect(
      getBridgeDepositInstructions('11111111-1111-4111-8111-111111111111'),
    ).rejects.toMatchObject({ statusCode: 502 })
  })

  it.each(['payment_rail', 'currency', 'bank_name', 'bank_routing_number', 'bank_account_number', 'deposit_message'])(
    'throws 502 when load-bearing field %s is missing — never a partial set',
    async (field) => {
      const partial: Record<string, unknown> = { ...FULL }
      delete partial[field]
      fetchMock.mockResolvedValue(
        jsonResponse(200, { id: 'onramp_1', source_deposit_instructions: partial }),
      )
      const { getBridgeDepositInstructions } = await import('./bridge.js')
      await expect(
        getBridgeDepositInstructions('11111111-1111-4111-8111-111111111111'),
      ).rejects.toMatchObject({ statusCode: 502 })
    },
  )
})
