import type { StripeOnramp } from '@stripe/crypto'

// Mirror of lib/stripe.ts for the crypto onramp SDK (#213). Memoized per
// publishable key; DYNAMIC import so the crypto-js.stripe.com loader script is
// only ever requested when an onramp session actually renders — mock/manual
// environments and CI never touch it. A rejected load (network, blocked
// script) rejects the promise AND clears the cache entry so a retry
// re-attempts the load instead of replaying the cached failure.
const cache = new Map<string, Promise<StripeOnramp | null>>()

export function getStripeOnramp(publishableKey: string): Promise<StripeOnramp | null> {
  let entry = cache.get(publishableKey)
  if (!entry) {
    entry = import('@stripe/crypto').then(({ loadStripeOnramp }) =>
      loadStripeOnramp(publishableKey),
    )
    entry.catch(() => cache.delete(publishableKey))
    cache.set(publishableKey, entry)
  }
  return entry
}
