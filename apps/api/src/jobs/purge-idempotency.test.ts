import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

const from = vi.fn()

vi.mock('../services/supabase.js', () => ({
  supabaseAdmin: {
    from: (...args: unknown[]) => from(...args),
  },
}))

const { purgeExpiredIdempotencyKeys } = await import('./purge-idempotency.js')

function mockDelete(result: { count: number | null; error: unknown }) {
  const lt = vi.fn().mockResolvedValue(result)
  const del = vi.fn().mockReturnValue({ lt })
  from.mockReturnValue({ delete: del })
  return { del, lt }
}

beforeEach(() => {
  from.mockReset()
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(new Date('2026-07-20T12:00:00.000Z'))
})

afterEach(() => vi.useRealTimers())

describe('purgeExpiredIdempotencyKeys', () => {
  it('deletes rows with expires_at strictly before now and returns the count', async () => {
    const { del, lt } = mockDelete({ count: 7, error: null })

    const count = await purgeExpiredIdempotencyKeys()

    expect(count).toBe(7)
    expect(from).toHaveBeenCalledWith('idempotency_keys')
    expect(del).toHaveBeenCalledWith({ count: 'exact' })
    expect(lt).toHaveBeenCalledWith('expires_at', '2026-07-20T12:00:00.000Z')
  })

  it('returns 0 when the count comes back null', async () => {
    mockDelete({ count: null, error: null })

    await expect(purgeExpiredIdempotencyKeys()).resolves.toBe(0)
  })

  it('throws when the delete fails', async () => {
    mockDelete({ count: null, error: { message: 'boom' } })

    await expect(purgeExpiredIdempotencyKeys()).rejects.toThrow(/purge failed: boom/)
  })
})
