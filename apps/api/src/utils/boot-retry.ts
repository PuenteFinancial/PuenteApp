// Retries a boot sequence on failure — e.g. a transient EMAXCONNSESSION while
// Supavisor is still reaping a previous crashed attempt's sessions. Exists
// because the worker's top-level `await` boot sequence has no other recovery
// path: an unhandled rejection there crashes the process. Callers whose boot
// step is itself memoized (getBoss()/ensureQueues() in services/queue.ts
// clear their memo on rejection) get a fresh attempt each retry rather than
// reusing a poisoned promise.
export async function withBootRetry<T>(
  fn: () => Promise<T>,
  attempts = 5,
  baseDelayMs = 1000,
  onRetry: (attempt: number, delayMs: number, err: unknown) => void = () => {},
): Promise<T> {
  for (let i = 1; i <= attempts; i++) {
    try {
      return await fn()
    } catch (err) {
      if (i === attempts) throw err
      const delay = baseDelayMs * 2 ** (i - 1)
      onRetry(i, delay, err)
      await new Promise((resolve) => setTimeout(resolve, delay))
    }
  }
  throw new Error('unreachable')
}
