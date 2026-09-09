import type { Stripe, StripeElementLocale } from '@stripe/stripe-js'

// Memoized per (publishable key, locale). DYNAMIC import so the js.stripe.com
// loader script is only ever requested when a stripe session actually renders
// — mock-provider environments and CI never touch it. A rejected load
// (network, blocked script) rejects the promise AND clears the cache entry so
// a retry re-attempts the load instead of replaying the cached failure.
//
// LOCALE IS PART OF THE KEY because it is fixed at load time and cannot be
// changed afterwards. The Payment Intents rail passes `locale` to <Elements>
// per mount, but the Checkout Sessions SDK options carry no locale field at
// all — `loadStripe(key, { locale })` is the only place to set it, and
// leaving it unset falls back to 'auto' (the BROWSER's language). A sender
// reading the app in Spanish on an English-locale laptop would then get an
// English payment form. Two locales means at most two cached loads.
const cache = new Map<string, Promise<Stripe | null>>()

export function getStripe(
  publishableKey: string,
  locale?: StripeElementLocale,
): Promise<Stripe | null> {
  const cacheKey = `${publishableKey}|${locale ?? 'auto'}`
  let entry = cache.get(cacheKey)
  if (!entry) {
    entry = import('@stripe/stripe-js').then(({ loadStripe }) =>
      loadStripe(publishableKey, locale ? { locale } : undefined),
    )
    entry.catch(() => cache.delete(cacheKey))
    cache.set(cacheKey, entry)
  }
  return entry
}
