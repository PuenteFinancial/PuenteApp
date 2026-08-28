import type { OnrampCoordinator } from '@stripe/crypto'

// Mirror of lib/stripeOnramp.ts for the embedded-components onramp SDK (K5).
// Memoized per publishable key; DYNAMIC import so the js.stripe.com loader
// script is only requested when the crypto pay step actually renders —
// mock/manual environments and CI never touch it. A rejected load (network,
// blocked script) rejects the promise AND clears the cache entry so a retry
// re-attempts the load instead of replaying the cached failure.
const cache = new Map<string, Promise<OnrampCoordinator | null>>()

export function getCryptoOnramp(publishableKey: string): Promise<OnrampCoordinator | null> {
  let entry = cache.get(publishableKey)
  if (!entry) {
    entry = import('@stripe/crypto').then(({ loadCryptoOnrampAndInitialize }) =>
      loadCryptoOnrampAndInitialize(publishableKey, { theme: 'stripe' }),
    )
    entry.catch(() => cache.delete(publishableKey))
    cache.set(publishableKey, entry)
  }
  return entry
}
