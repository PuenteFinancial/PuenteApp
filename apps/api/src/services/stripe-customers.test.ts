import { describe, it, expect, vi, beforeEach } from 'vitest'

const from = vi.hoisted(() => vi.fn())
vi.mock('./supabase.js', () => ({ supabaseAdmin: { from: (...a: unknown[]) => from(...a) } }))

const { ensureStripeCustomer } = await import('./stripe-customers.js')

const USER = 'user-1'

/** users.select().eq().maybeSingle() and users.update().eq().is() */
function usersTable(reads: Array<{ stripe_customer_id: string | null } | null>, updateError: unknown = null) {
  let readIdx = 0
  const update = vi.fn()
  from.mockImplementation(() => {
    const b: Record<string, unknown> = {}
    for (const m of ['select', 'eq', 'is']) b[m] = () => b
    b['maybeSingle'] = async () => ({ data: reads[Math.min(readIdx++, reads.length - 1)] ?? null, error: null })
    b['update'] = (...args: unknown[]) => {
      update(...args)
      const u: Record<string, unknown> = {}
      u['eq'] = () => u
      u['is'] = async () => ({ error: updateError })
      return u
    }
    return b
  })
  return { update }
}

const fetchMock = vi.fn()
beforeEach(() => {
  from.mockReset()
  fetchMock.mockReset()
  vi.stubGlobal('fetch', fetchMock)
})

describe('ensureStripeCustomer', () => {
  it('reuses the customer the sender already has, without calling Stripe', async () => {
    usersTable([{ stripe_customer_id: 'cus_existing' }])

    expect(await ensureStripeCustomer({ userId: USER })).toBe('cus_existing')
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('mints one keyed on the user id, so a lost response cannot duplicate it', async () => {
    // Two Customers for one sender splits their saved methods invisibly, and
    // reads to them as "my bank disappeared".
    const t = usersTable([{ stripe_customer_id: null }, { stripe_customer_id: 'cus_new' }])
    fetchMock.mockResolvedValue({ ok: true, json: async () => ({ id: 'cus_new' }) })

    expect(await ensureStripeCustomer({ userId: USER, email: 'a@b.com' })).toBe('cus_new')

    const [, init] = fetchMock.mock.calls[0] as [string, { headers: Record<string, string>; body: URLSearchParams }]
    expect(init.headers['Idempotency-Key']).toBe(`customer_${USER}`)
    expect(init.body.get('metadata[user_id]')).toBe(USER)
    expect(t.update).toHaveBeenCalledWith({ stripe_customer_id: 'cus_new' })
  })

  it('returns null instead of throwing when Stripe is unreachable', async () => {
    // Saving is a convenience layered on a payment. A Stripe outage here must
    // never stop someone sending money.
    usersTable([{ stripe_customer_id: null }])
    fetchMock.mockRejectedValue(new Error('ECONNRESET'))

    await expect(ensureStripeCustomer({ userId: USER })).resolves.toBeNull()
  })

  it('returns null on a non-2xx rather than persisting a bad id', async () => {
    usersTable([{ stripe_customer_id: null }])
    fetchMock.mockResolvedValue({ ok: false, json: async () => ({}) })

    expect(await ensureStripeCustomer({ userId: USER })).toBeNull()
  })

  it('a racing confirm that persisted first keeps ITS customer', async () => {
    // The guarded update matches no rows; the re-read returns the winner's id,
    // which is the one the session must use or the methods split in two.
    const t = usersTable([{ stripe_customer_id: null }, { stripe_customer_id: 'cus_winner' }])
    fetchMock.mockResolvedValue({ ok: true, json: async () => ({ id: 'cus_loser' }) })

    expect(await ensureStripeCustomer({ userId: USER })).toBe('cus_winner')
    expect(t.update).toHaveBeenCalledWith({ stripe_customer_id: 'cus_loser' })
  })

  it('never sends the sender name to Stripe', async () => {
    usersTable([{ stripe_customer_id: null }, { stripe_customer_id: 'cus_new' }])
    fetchMock.mockResolvedValue({ ok: true, json: async () => ({ id: 'cus_new' }) })

    await ensureStripeCustomer({ userId: USER, email: 'a@b.com' })

    const [, init] = fetchMock.mock.calls[0] as [string, { body: URLSearchParams }]
    expect(init.body.get('name')).toBeNull()
  })
})
