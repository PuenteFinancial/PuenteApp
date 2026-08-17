import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

const from = vi.fn()

vi.mock('../services/supabase.js', () => ({
  supabaseAdmin: {
    from: (...args: unknown[]) => from(...args),
  },
}))

const { purgeExpiredOtpAttempts } = await import('./purge-otp-attempts.js')

function mockDelete(result: { count: number | null; error: unknown }) {
  const lt = vi.fn().mockResolvedValue(result)
  const del = vi.fn().mockReturnValue({ lt })
  from.mockReturnValue({ delete: del })
  return { del, lt }
}

beforeEach(() => {
  from.mockReset()
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(new Date('2026-08-17T12:00:00.000Z'))
})

afterEach(() => vi.useRealTimers())

describe('purgeExpiredOtpAttempts', () => {
  it('keeps two days, not one, and returns the count', async () => {
    const { del, lt } = mockDelete({ count: 12, error: null })

    const count = await purgeExpiredOtpAttempts()

    expect(count).toBe(12)
    expect(from).toHaveBeenCalledWith('otp_send_attempts')
    expect(del).toHaveBeenCalledWith({ count: 'exact' })
    // The widest rate-limit window is a rolling day; the extra day of margin is
    // what stops a missed run from silently shortening someone's daily budget.
    // Pruning at exactly 24h would race the very rows a check still needs.
    expect(lt).toHaveBeenCalledWith('created_at', '2026-08-15T12:00:00.000Z')
  })

  it('returns 0 when the count comes back null', async () => {
    mockDelete({ count: null, error: null })

    await expect(purgeExpiredOtpAttempts()).resolves.toBe(0)
  })

  it('throws when the delete fails, so the cron reports it', async () => {
    mockDelete({ count: null, error: { message: 'boom' } })

    await expect(purgeExpiredOtpAttempts()).rejects.toThrow(/otp attempt purge failed: boom/)
  })
})
