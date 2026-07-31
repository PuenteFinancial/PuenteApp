import type { Stripe } from '@stripe/stripe-js'

// Memoized per publishable key (multiple keys never happen in one session, but
// a Map is the honest shape). DYNAMIC import so the js.stripe.com loader
// script is only ever requested when a stripe session actually renders —
// mock-provider environments and CI never touch it. A rejected load (network,
// blocked script) rejects the promise AND clears the cache entry so a retry
// re-attempts the load instead of replaying the cached failure.
const cache = new Map<string, Promise<Stripe | null>>()

export function getStripe(publishableKey: string): Promise<Stripe | null> {
  let entry = cache.get(publishableKey)
  if (!entry) {
    entry = import('@stripe/stripe-js').then(({ loadStripe }) => loadStripe(publishableKey))
    entry.catch(() => cache.delete(publishableKey))
    cache.set(publishableKey, entry)
  }
  return entry
}
