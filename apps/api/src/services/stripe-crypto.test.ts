import { describe, it, expect, vi, beforeEach } from 'vitest'

// env.ts parses process.env at import time — the crypto pair must exist
// before the dynamic imports below (setup.ts leaves STRIPE_SECRET_KEY unset
// globally so the funding-adapter suites can prove unconfigured behavior).
process.env.STRIPE_SECRET_KEY = 'sk_test_platform'
process.env.STRIPE_CRYPTO_OAUTH_CLIENT_ID = 'lwlpk_test_client'
process.env.STRIPE_CRYPTO_OAUTH_CLIENT_SECRET = 'lwlsk_test_secret'
process.env.ONRAMP_DESTINATION_ADDRESS = '0x' + 'a'.repeat(40)

const from = vi.fn()
vi.mock('../services/supabase.js', () => ({
  supabaseAdmin: { from: (...args: unknown[]) => from(...args) },
}))

const fetchMock = vi.fn()
vi.stubGlobal('fetch', fetchMock)

const {
  createOrReuseLinkAuthIntent,
  exchangeLinkAuthIntent,
  mintAccessToken,
  getCryptoCustomer,
  getOnrampQuote,
  createOnrampSession,
  checkoutOnrampSession,
  isStripeCryptoConfigured,
  NoStoredTokenError,
  StripeCryptoApiError,
} = await import('./stripe-crypto.js')
const { decryptString, encryptString } = await import('../utils/encryption.js')

function jsonResponse(status: number, body: unknown) {
  return { ok: status >= 200 && status < 300, status, json: async () => body }
}

// select(...).eq(...).maybeSingle() / .single()
function selectRow(row: unknown) {
  return {
    select: vi.fn(() => ({
      eq: vi.fn(() => ({
        maybeSingle: vi.fn(async () => ({ data: row, error: null })),
        single: vi.fn(async () => ({ data: row, error: null })),
      })),
    })),
  }
}

const upsert = vi.fn(async (..._args: unknown[]) => ({ error: null }))
const update = vi.fn(() => ({ eq: vi.fn(async () => ({ error: null })) }))

// The compare-and-swap store: .update(payload).eq(user).eq(ciphertext).select()
// `casRows` is what the swap matched — [] means another rotation won the race.
let casRows: unknown[] = [{ user_id: 'user-1' }]
const casUpdate = vi.fn((_payload: unknown) => {
  const chain: Record<string, unknown> = {}
  chain.eq = vi.fn(() => chain)
  chain.select = vi.fn(async () => ({ data: casRows, error: null }))
  return chain
})
/** A `from()` result that serves a row read AND the CAS store. */
function tokenTable(row: unknown) {
  return { ...selectRow(row), upsert, update: casUpdate }
}

beforeEach(() => {
  from.mockReset()
  fetchMock.mockReset()
  upsert.mockClear()
  update.mockClear()
  casUpdate.mockClear()
  casRows = [{ user_id: 'user-1' }]
})

describe('isStripeCryptoConfigured', () => {
  it('is true with the platform key and OAuth pair set', () => {
    expect(isStripeCryptoConfigured()).toBe(true)
  })
})

describe('createOrReuseLinkAuthIntent', () => {
  it('reuses a stored, still-valid intent without touching the network', async () => {
    const future = new Date(Date.now() + 60 * 60 * 1000).toISOString()
    from.mockReturnValue(selectRow({ auth_intent_id: 'lai_stored', lai_expires_at: future }))

    const intent = await createOrReuseLinkAuthIntent('user-1', 'a@b.com')

    expect(intent.id).toBe('lai_stored')
    expect(intent.linkAccountExists).toBe(true)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('creates a fresh intent when the stored one is near expiry, and persists it', async () => {
    const soon = new Date(Date.now() + 60 * 1000).toISOString() // inside the 5-min margin
    from.mockImplementation(() => ({ ...selectRow({ auth_intent_id: 'lai_old', lai_expires_at: soon }), upsert }))
    fetchMock.mockResolvedValue(jsonResponse(200, { id: 'lai_new', expires_at: 1893456000 }))

    const intent = await createOrReuseLinkAuthIntent('user-1', 'a@b.com')

    expect(intent.id).toBe('lai_new')
    const [url, init] = fetchMock.mock.calls[0]!
    expect(url).toBe('https://login.link.test/v1/link_auth_intent')
    expect(init.headers.Authorization).toBe('Bearer sk_test_platform')
    // login.link.com is not a crypto endpoint — no beta version header
    expect(init.headers['Stripe-Version']).toBeUndefined()
    expect(JSON.parse(init.body)).toEqual({
      email: 'a@b.com',
      oauth_client_id: 'lwlpk_test_client',
      oauth_scopes: 'kyc.status:read,crypto:ramp',
    })
    expect(upsert).toHaveBeenCalledWith(
      expect.objectContaining({ user_id: 'user-1', auth_intent_id: 'lai_new' }),
      { onConflict: 'user_id' },
    )
    // The stored refresh token must never be part of this write
    expect(Object.keys(upsert.mock.calls[0]![0] as object)).not.toContain('refresh_token_enc')
  })

  it('maps the documented 404 to "no Link account" instead of throwing', async () => {
    from.mockReturnValue({ ...selectRow(null), upsert })
    fetchMock.mockResolvedValue(jsonResponse(404, { error: { code: 'not_found' } }))

    const intent = await createOrReuseLinkAuthIntent('user-1', 'a@b.com')
    expect(intent.linkAccountExists).toBe(false)
    expect(intent.id).toBe('')
  })
})

describe('exchangeLinkAuthIntent', () => {
  it('banks the refresh token encrypted and AAD-bound to the user', async () => {
    from.mockReturnValue({ upsert })
    fetchMock.mockResolvedValue(
      jsonResponse(200, {
        access_token: 'liwltoken_abc',
        refresh: { refresh_token: 'liwlrefresh_abc' },
      }),
    )

    const accessToken = await exchangeLinkAuthIntent('user-1', 'lai_x')

    expect(accessToken).toBe('liwltoken_abc')
    const [url, init] = fetchMock.mock.calls[0]!
    expect(url).toBe('https://login.link.test/v1/link_auth_intent/lai_x/tokens')
    expect(init.method).toBe('POST')

    const stored = (upsert.mock.calls[0]![0] as { refresh_token_enc: string }).refresh_token_enc
    expect(stored).not.toContain('liwlrefresh_abc') // never plaintext at rest
    expect(decryptString(stored, 'user-1')).toBe('liwlrefresh_abc')
  })
})

describe('mintAccessToken', () => {
  it('runs the refresh grant with the OAuth pair and rotates the stored token', async () => {
    const enc = encryptString('liwlrefresh_old', 'user-1')
    from.mockImplementation(() => tokenTable({ refresh_token_enc: enc }))
    fetchMock.mockResolvedValue(
      jsonResponse(200, { access_token: 'liwltoken_new', refresh_token: 'liwlrefresh_new' }),
    )

    const token = await mintAccessToken('user-1')

    expect(token).toBe('liwltoken_new')
    const [url, init] = fetchMock.mock.calls[0]!
    expect(url).toBe('https://login.link.test/auth/token')
    const params = new URLSearchParams(init.body)
    expect(params.get('grant_type')).toBe('refresh_token')
    expect(params.get('refresh_token')).toBe('liwlrefresh_old')
    expect(params.get('client_id')).toBe('lwlpk_test_client')
    expect(params.get('client_secret')).toBe('lwlsk_test_secret')

    const stored = (casUpdate.mock.calls[0]![0] as { refresh_token_enc: string }).refresh_token_enc
    expect(decryptString(stored, 'user-1')).toBe('liwlrefresh_new')
  })

  it('throws NoStoredTokenError when the user has no banked token', async () => {
    from.mockReturnValue(selectRow(null))
    await expect(mintAccessToken('user-1')).rejects.toThrow(NoStoredTokenError)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('treats a rejected refresh grant as "re-authenticate", not a provider failure', async () => {
    const enc = encryptString('liwlrefresh_revoked', 'user-1')
    from.mockReturnValue(selectRow({ refresh_token_enc: enc }))
    fetchMock.mockResolvedValue(jsonResponse(400, { error: 'invalid_grant' }))

    await expect(mintAccessToken('user-1')).rejects.toThrow(NoStoredTokenError)
  })

  // ── Refresh-rotation race (drive finding 2026-08-29) ───────────────────
  // Two requests for one user (two tabs; React's double-invoked effects in
  // dev) both present the same refresh token. Stripe rotates on the first and
  // rejects the second. RFC 9700 has authorization servers treat reuse of a
  // rotated token as a breach signal and revoke the whole grant, so losing
  // this race must be handled, never shrugged at.
  it('retries once with the token a concurrent rotation just stored', async () => {
    const mine = encryptString('liwlrefresh_mine', 'user-1')
    const theirs = encryptString('liwlrefresh_theirs', 'user-1')
    // First read gives our token; the post-rejection re-read shows the row
    // changed under us — the other request won.
    const reads = [{ refresh_token_enc: mine }, { refresh_token_enc: theirs }]
    let call = 0
    from.mockImplementation(() => tokenTable(reads[Math.min(call++, reads.length - 1)]))
    fetchMock
      .mockResolvedValueOnce(jsonResponse(400, { error: 'invalid_grant' }))
      .mockResolvedValueOnce(
        jsonResponse(200, { access_token: 'liwltoken_ok', refresh_token: 'liwlrefresh_next' }),
      )

    const token = await mintAccessToken('user-1')

    expect(token).toBe('liwltoken_ok')
    expect(fetchMock).toHaveBeenCalledTimes(2)
    // The retry presented the WINNER's token, not our rejected one.
    const retried = new URLSearchParams(fetchMock.mock.calls[1]![1].body)
    expect(retried.get('refresh_token')).toBe('liwlrefresh_theirs')
  })

  it('does not retry when the stored token is unchanged — the grant is truly dead', async () => {
    const enc = encryptString('liwlrefresh_revoked', 'user-1')
    from.mockImplementation(() => tokenTable({ refresh_token_enc: enc }))
    fetchMock.mockResolvedValue(jsonResponse(400, { error: 'invalid_grant' }))

    await expect(mintAccessToken('user-1')).rejects.toThrow(NoStoredTokenError)
    // One grant attempt, plus the re-read that proved nothing had changed.
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('the compare-and-swap never clobbers a fresher token', async () => {
    const enc = encryptString('liwlrefresh_old', 'user-1')
    from.mockImplementation(() => tokenTable({ refresh_token_enc: enc }))
    fetchMock.mockResolvedValue(
      jsonResponse(200, { access_token: 'liwltoken_slow', refresh_token: 'liwlrefresh_slow' }),
    )
    casRows = [] // the row already moved on — our swap matches nothing

    // Losing the write race is success: the winner's token is the live one,
    // and this call's access token is still valid for its own request.
    await expect(mintAccessToken('user-1')).resolves.toBe('liwltoken_slow')

    const eqCalls = casUpdate.mock.results[0]!.value as { eq: ReturnType<typeof vi.fn> }
    // Guarded on BOTH the user and the exact ciphertext we consumed.
    expect(eqCalls.eq).toHaveBeenCalledWith('user_id', 'user-1')
    expect(eqCalls.eq).toHaveBeenCalledWith('refresh_token_enc', enc)
  })

  it('rejects a ciphertext bound to a different user (AAD)', async () => {
    const enc = encryptString('liwlrefresh_stolen', 'someone-else')
    from.mockReturnValue(selectRow({ refresh_token_enc: enc }))

    await expect(mintAccessToken('user-1')).rejects.toThrow(NoStoredTokenError)
    expect(fetchMock).not.toHaveBeenCalled()
  })
})

describe('getCryptoCustomer', () => {
  it('sends both auth headers plus the beta version header', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse(200, {
        id: 'crc_1',
        verifications: [{ type: 'kyc_verified', status: 'not_started' }],
      }),
    )

    const status = await getCryptoCustomer('crc_1', 'liwltoken_x')

    const [url, init] = fetchMock.mock.calls[0]!
    expect(url).toBe('https://api.stripe.test/v1/crypto/customers/crc_1')
    expect(init.headers.Authorization).toBe('Bearer sk_test_platform')
    expect(init.headers['Stripe-OAuth-Token']).toBe('liwltoken_x')
    expect(init.headers['Stripe-Version']).toBe('2026-05-27.preview;crypto_onramp_beta=v2')
    expect(status.verifications).toEqual([{ type: 'kyc_verified', status: 'not_started' }])
  })

  it('normalizes the SA doc’s kyc_tiers shape too (preview drift tolerance)', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse(200, {
        id: 'crc_1',
        kyc_tiers: [{ tier: 'L1', verification_status: 'verified' }],
      }),
    )

    const status = await getCryptoCustomer('crc_1', 'liwltoken_x')
    expect(status.verifications).toEqual([{ type: 'L1', status: 'verified' }])
  })

  it('wraps provider errors with a non-enumerable body', async () => {
    fetchMock.mockResolvedValue(jsonResponse(401, { error: { code: 'invalid_token' } }))

    const err = await getCryptoCustomer('crc_1', 'bad').catch((e: unknown) => e)
    expect(err).toBeInstanceOf(StripeCryptoApiError)
    expect((err as InstanceType<typeof StripeCryptoApiError>).code).toBe('invalid_token')
    // The body must not survive serialization — it can echo request context
    expect(JSON.stringify(err)).not.toContain('invalid_token')
  })
})

describe('createOnrampSession', () => {
  const input = {
    transferId: 'transfer-1',
    cryptoCustomerId: 'crc_1',
    paymentTokenId: 'cpt_1',
    destinationAmountUsd: '25.00',
    clientIp: '203.0.113.7',
    accessToken: 'liwltoken_x',
  }

  it('pins everything the sender must not control server-side', async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, { id: 'cos_1', status: 'initialized' }))

    const session = await createOnrampSession(input)

    expect(session).toEqual({ id: 'cos_1', status: 'initialized' })
    const [url, init] = fetchMock.mock.calls[0]!
    expect(url).toBe('https://api.stripe.test/v1/crypto/onramp_sessions')
    expect(init.headers['Stripe-OAuth-Token']).toBe('liwltoken_x')
    expect(init.headers['Stripe-Version']).toBe('2026-05-27.preview;crypto_onramp_beta=v2')
    // Attempt-scoped dedup: same transfer + same payment token = same session
    expect(init.headers['Idempotency-Key']).toBe('funding_init_transfer-1_cpt_1')
    const params = new URLSearchParams(init.body)
    expect(params.get('ui_mode')).toBe('headless')
    expect(params.get('crypto_customer_id')).toBe('crc_1')
    expect(params.get('payment_token')).toBe('cpt_1')
    expect(params.get('destination_amount')).toBe('25.00')
    expect(params.get('destination_network')).toBe('base')
    expect(params.get('wallet_address')).toBe('0x' + 'a'.repeat(40))
    expect(params.get('customer_ip_address')).toBe('203.0.113.7')
    expect(params.get('metadata[transfer_id]')).toBe('transfer-1')
  })

  it('refuses a session Stripe returns without an id', async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, { status: 'initialized' }))
    await expect(createOnrampSession(input)).rejects.toThrow(StripeCryptoApiError)
  })
})

describe('checkoutOnrampSession', () => {
  it('card checkout sends no mandate body', async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, { client_secret: 'cos_secret_x' }))

    const result = await checkoutOnrampSession({ sessionId: 'cos_1', accessToken: 'liwltoken_x' })

    expect(result).toEqual({ clientSecret: 'cos_secret_x' })
    const [url, init] = fetchMock.mock.calls[0]!
    expect(url).toBe('https://api.stripe.test/v1/crypto/onramp_sessions/cos_1/checkout')
    expect(init.method).toBe('POST')
    expect(init.body).toBeUndefined()
  })

  it('ACH checkout carries the online mandate acceptance evidence', async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, { client_secret: 'cos_secret_x' }))

    await checkoutOnrampSession({
      sessionId: 'cos_1',
      accessToken: 'liwltoken_x',
      achMandate: { clientIp: '203.0.113.7', userAgent: 'test-browser' },
    })

    const [, init] = fetchMock.mock.calls[0]!
    const params = new URLSearchParams(init.body)
    expect(params.get('mandate_data[customer_acceptance][type]')).toBe('online')
    expect(params.get('mandate_data[customer_acceptance][online][ip_address]')).toBe('203.0.113.7')
    expect(params.get('mandate_data[customer_acceptance][online][user_agent]')).toBe('test-browser')
  })

  it('refuses a checkout response without a client_secret', async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, {}))
    await expect(
      checkoutOnrampSession({ sessionId: 'cos_1', accessToken: 'liwltoken_x' }),
    ).rejects.toThrow(StripeCryptoApiError)
  })
})

describe('getOnrampQuote', () => {
  it('requests a headless quote and picks the matching network/currency entry', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse(200, {
        destination_network_quotes: {
          base: [
            {
              destination_currency: 'usdc',
              destination_amount: '24.50',
              destination_network: 'base',
              fees: { network_fee_monetary: '0.10', transaction_fee_monetary: '0.40' },
              source_total_amount: '25.00',
            },
          ],
        },
      }),
    )

    const quote = await getOnrampQuote({
      sourceAmount: '25.00',
      destinationCurrency: 'usdc',
      destinationNetwork: 'base',
    })

    const [url] = fetchMock.mock.calls[0]!
    const parsed = new URL(url as string)
    expect(parsed.pathname).toBe('/v1/crypto/onramp_quotes')
    expect(parsed.searchParams.get('ui_mode')).toBe('headless')
    expect(parsed.searchParams.get('source_amount')).toBe('25.00')
    expect(parsed.searchParams.getAll('destination_currencies[]')).toEqual(['usdc'])
    expect(parsed.searchParams.getAll('destination_networks[]')).toEqual(['base'])
    expect(quote).toEqual({
      destinationCurrency: 'usdc',
      destinationAmount: '24.50',
      destinationNetwork: 'base',
      networkFee: '0.10',
      transactionFee: '0.40',
      sourceTotalAmount: '25.00',
    })
  })

  it('returns null when Stripe has no quote for the corridor', async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, { destination_network_quotes: {} }))
    const quote = await getOnrampQuote({
      sourceAmount: '25.00',
      destinationCurrency: 'usdc',
      destinationNetwork: 'base',
    })
    expect(quote).toBeNull()
  })
})
