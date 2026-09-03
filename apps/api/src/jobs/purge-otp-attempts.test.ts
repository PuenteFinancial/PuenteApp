import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

const from = vi.fn()

vi.mock('../services/supabase.js', () => ({
  supabaseAdmin: {
    from: (...args: unknown[]) => from(...args),
  },
}))

const { purgeExpiredOtpAttempts } = await import('./purge-otp-attempts.js')

type DeleteResult = { count: number | null; error: unknown }

// One delete chain per table, dispensed by name — the prune sweeps both OTP
// logs, and a test must be able to say which one failed or returned what.
function mockDeletes(results: Record<string, DeleteResult>) {
  const chains: Record<string, { del: ReturnType<typeof vi.fn>; lt: ReturnType<typeof vi.fn> }> =
    {}
  from.mockImplementation((table: string) => {
    const result = results[table] ?? { count: 0, error: null }
    const lt = vi.fn().mockResolvedValue(result)
    const del = vi.fn().mockReturnValue({ lt })
    chains[table] = { del, lt }
    return { delete: del }
  })
  return chains
}

beforeEach(() => {
  from.mockReset()
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(new Date('2026-08-17T12:00:00.000Z'))
})

afterEach(() => vi.useRealTimers())

describe('purgeExpiredOtpAttempts', () => {
  it('sweeps both OTP logs, keeps two days, and returns the combined count', async () => {
    const chains = mockDeletes({
      otp_send_attempts: { count: 12, error: null },
      otp_verify_attempts: { count: 30, error: null },
    })

    const count = await purgeExpiredOtpAttempts()

    expect(count).toBe(42)
    for (const table of ['otp_send_attempts', 'otp_verify_attempts']) {
      expect(from).toHaveBeenCalledWith(table)
      expect(chains[table]!.del).toHaveBeenCalledWith({ count: 'exact' })
      // The widest rate-limit window on either leg is a rolling day; the extra
      // day of margin is what stops a missed run from silently shortening
      // someone's daily budget. Pruning at exactly 24h would race the very
      // rows a check still needs.
      expect(chains[table]!.lt).toHaveBeenCalledWith('created_at', '2026-08-15T12:00:00.000Z')
    }
  })

  it('returns 0 when the counts come back null', async () => {
    mockDeletes({
      otp_send_attempts: { count: null, error: null },
      otp_verify_attempts: { count: null, error: null },
    })

    await expect(purgeExpiredOtpAttempts()).resolves.toBe(0)
  })

  it('throws naming the table when a delete fails, so the cron reports it', async () => {
    mockDeletes({
      otp_send_attempts: { count: 3, error: null },
      otp_verify_attempts: { count: null, error: { message: 'boom' } },
    })

    await expect(purgeExpiredOtpAttempts()).rejects.toThrow(
      /otp attempt purge failed \(otp_verify_attempts\): boom/,
    )
  })
})
