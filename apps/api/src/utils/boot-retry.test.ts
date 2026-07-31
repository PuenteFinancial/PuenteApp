import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { withBootRetry } from './boot-retry.js'

describe('withBootRetry', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('resolves immediately when the first attempt succeeds', async () => {
    const fn = vi.fn().mockResolvedValue('ok')
    await expect(withBootRetry(fn)).resolves.toBe('ok')
    expect(fn).toHaveBeenCalledTimes(1)
  })

  it('retries with exponential backoff and resolves once fn succeeds', async () => {
    const fn = vi
      .fn()
      .mockRejectedValueOnce(new Error('boom 1'))
      .mockRejectedValueOnce(new Error('boom 2'))
      .mockResolvedValueOnce('ok')
    const onRetry = vi.fn()

    const promise = withBootRetry(fn, 5, 1000, onRetry)
    await vi.advanceTimersByTimeAsync(1000) // 1st retry delay (1000 * 2^0)
    await vi.advanceTimersByTimeAsync(2000) // 2nd retry delay (1000 * 2^1)

    await expect(promise).resolves.toBe('ok')
    expect(fn).toHaveBeenCalledTimes(3)
    expect(onRetry).toHaveBeenNthCalledWith(1, 1, 1000, new Error('boom 1'))
    expect(onRetry).toHaveBeenNthCalledWith(2, 2, 2000, new Error('boom 2'))
  })

  it('rejects with the last error once attempts are exhausted, without an extra delay', async () => {
    const err = new Error('always fails')
    const fn = vi.fn().mockRejectedValue(err)

    const promise = withBootRetry(fn, 3, 10)
    promise.catch(() => {}) // avoid an unhandled-rejection warning while timers advance
    await vi.advanceTimersByTimeAsync(10) // 1st retry delay (10 * 2^0)
    await vi.advanceTimersByTimeAsync(20) // 2nd retry delay (10 * 2^1)

    await expect(promise).rejects.toBe(err)
    expect(fn).toHaveBeenCalledTimes(3)
  })
})
