import { cookies } from 'next/headers'
import { redirect } from 'next/navigation'
import { KYC_NEXT_COOKIE, validKycNext } from '@/lib/kycReturn'

// Stripe's return_url for the Checkout Sessions rail (CHECKOUT_RETURN_URL_BASE
// must point here, not bare /dashboard). Only reached when a payment method
// redirects away and back — 3DS step-up, some bank flows; 'if_required' keeps
// every other method on CheckoutPayStep and never visits this page. Nested
// under /dashboard on purpose: DashboardShell's chrome, including the way
// back to /dashboard, renders here the same as everywhere else in the
// signed-in app, so this page needs no chrome or dashboard link of its own.
//
// Ignores Stripe's `session_id` query param entirely: CheckoutPayStep stashes
// the transfer id in kyc_next before calling confirm(), the same cookie
// CheckoutIdentityStep's Bridge/Persona redirect already sets and for the
// same reason (see lib/kycReturn.ts) — a redirect chain through a third party
// can't be trusted to carry a query param home, so the cookie is the one
// mechanism every hosted-flow return leg on this app shares.
export default async function CheckoutReturnPage() {
  const rawNext = (await cookies()).get(KYC_NEXT_COOKIE)?.value
  redirect(validKycNext(rawNext) ?? '/dashboard')
}
