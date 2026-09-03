import { describe, it, expect, vi, beforeEach } from 'vitest'

// DETAILS_ENCRYPTION_KEY comes from src/test/setup.ts — setting it here with
// the wrong encoding fails env validation and exits the process.

const from = vi.fn()
vi.mock('./supabase.js', () => ({
  supabaseAdmin: { from: (...args: unknown[]) => from(...args) },
}))

const createExternalAccount = vi.hoisted(() => vi.fn())
const listExternalAccounts = vi.hoisted(() => vi.fn())
vi.mock('./bridge.js', async () => {
  const actual = await vi.importActual<typeof import('./bridge.js')>('./bridge.js')
  return {
    BridgeApiError: actual.BridgeApiError,
    createExternalAccount: (...a: unknown[]) => createExternalAccount(...a),
    listExternalAccounts: (...a: unknown[]) => listExternalAccounts(...a),
  }
})

const { registerPendingDestinations } = await import('./destination-registration.js')
const { BridgeApiError } = await import('./bridge.js')
const { encryptString } = await import('../utils/encryption.js')

const RECIPIENT = 'recipient-1'
const CLABE = '002010077777777771'
const USER = 'user-1'

/** payout_destinations select chain → rows, plus a capturing update chain. */
const update = vi.fn()
function tables(rows: unknown[]) {
  const selectChain: Record<string, unknown> = {}
  for (const m of ['select', 'is', 'eq']) selectChain[m] = vi.fn(() => selectChain)
  ;(selectChain as { then?: unknown }).then = (resolve: (v: unknown) => void) =>
    resolve({ data: rows, error: null })

  from.mockImplementation(() => ({ ...selectChain, update }))
}

function pendingRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'dest-1',
    recipient_id: RECIPIENT,
    details: { clabe_ciphertext: encryptString(CLABE, RECIPIENT), clabe_last4: CLABE.slice(-4) },
    recipients: { first_name: 'Ana', last_name: 'Ruiz' },
    ...overrides,
  }
}

beforeEach(() => {
  from.mockReset()
  createExternalAccount.mockReset()
  listExternalAccounts.mockReset()
  update.mockReset()
  // .update(payload).eq(id).is(ref, null) → { error: null }
  update.mockImplementation(() => {
    const chain: Record<string, unknown> = {}
    chain.eq = vi.fn(() => chain)
    chain.is = vi.fn(async () => ({ error: null }))
    return chain
  })
})

describe('registerPendingDestinations', () => {
  it('registers an unregistered destination and persists the ref', async () => {
    tables([pendingRow()])
    createExternalAccount.mockResolvedValue({ id: 'ext_1' })

    const result = await registerPendingDestinations(USER, 'cust_1')

    expect(result).toEqual({ registered: 1, failed: [] })
    // The decrypted CLABE reaches Bridge — never the ciphertext.
    expect(createExternalAccount).toHaveBeenCalledWith('cust_1', {
      firstName: 'Ana',
      lastName: 'Ruiz',
      clabe: CLABE,
    })
    expect(update).toHaveBeenCalledWith({ provider_account_ref: 'ext_1' })
  })

  it('adopts the existing Bridge account when the CLABE is already registered', async () => {
    // Bridge dedupes identical CLABEs per customer, which a retried or
    // half-finished backfill reaches. Adopting is the only correct answer —
    // a second account cannot be minted and failing would strand the payout.
    tables([pendingRow()])
    createExternalAccount.mockRejectedValue(
      new BridgeApiError(400, { code: 'duplicate_external_account' }),
    )
    listExternalAccounts.mockResolvedValue([{ id: 'ext_existing', clabeLast4: CLABE.slice(-4) }])

    const result = await registerPendingDestinations(USER, 'cust_1')

    expect(result.registered).toBe(1)
    expect(update).toHaveBeenCalledWith({ provider_account_ref: 'ext_existing' })
  })

  it('refuses to guess when the duplicate match is ambiguous', async () => {
    // Bridge exposes only last_4. Two candidates means we could attach the
    // wrong bank account to a payout — leave it for a human.
    tables([pendingRow()])
    createExternalAccount.mockRejectedValue(
      new BridgeApiError(400, { code: 'duplicate_external_account' }),
    )
    listExternalAccounts.mockResolvedValue([
      { id: 'ext_a', clabeLast4: CLABE.slice(-4) },
      { id: 'ext_b', clabeLast4: CLABE.slice(-4) },
    ])

    const result = await registerPendingDestinations(USER, 'cust_1')

    expect(result.registered).toBe(0)
    expect(result.failed).toEqual([{ destinationId: 'dest-1', reason: 'duplicate_ambiguous' }])
    expect(update).not.toHaveBeenCalled()
  })

  it('reports a Bridge rejection without throwing — the caller must not break', async () => {
    tables([pendingRow()])
    createExternalAccount.mockRejectedValue(new BridgeApiError(422, { code: 'invalid_account' }))

    const result = await registerPendingDestinations(USER, 'cust_1')

    expect(result.registered).toBe(0)
    expect(result.failed[0]!.reason).toBe('bridge_rejected_422')
  })

  it('reports an undecryptable CLABE instead of retrying it forever', async () => {
    tables([pendingRow({ details: { clabe_ciphertext: 'not-a-real-payload' } })])

    const result = await registerPendingDestinations(USER, 'cust_1')

    expect(result.failed[0]!.reason).toBe('clabe_undecryptable')
    expect(createExternalAccount).not.toHaveBeenCalled()
  })

  it('is a no-op when nothing is pending', async () => {
    tables([])
    const result = await registerPendingDestinations(USER, 'cust_1')
    expect(result).toEqual({ registered: 0, failed: [] })
    expect(createExternalAccount).not.toHaveBeenCalled()
  })

  it('guards the write on the ref still being null, so a racing caller wins cleanly', async () => {
    tables([pendingRow()])
    createExternalAccount.mockResolvedValue({ id: 'ext_1' })

    await registerPendingDestinations(USER, 'cust_1')

    const chain = update.mock.results[0]!.value as {
      eq: ReturnType<typeof vi.fn>
      is: ReturnType<typeof vi.fn>
    }
    expect(chain.eq).toHaveBeenCalledWith('id', 'dest-1')
    expect(chain.is).toHaveBeenCalledWith('provider_account_ref', null)
  })
})
