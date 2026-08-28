import { env } from '../../config/env.js'
import { StripeOnrampFundingProcessor } from './stripe-onramp.js'
import type { FundingClientSession, FundingInitiation } from './index.js'

// Embedded-components onramp rail (K4, KYC rehaul). The money machinery is
// the widget rail's, inherited verbatim — same webhook event type, same
// status→event mapping, same amount guard, same irreversibility posture
// (onramprefund_ refs, human-disbursed undo) — because the session object is
// the same Stripe object either way. What changes is WHO creates sessions and
// WHEN:
//
//   widget (stripe_onramp)  — confirm creates the session with the platform
//                             key; the sender pays inside Stripe's iframe.
//   embedded (stripe_crypto) — sessions are created at the PAY STEP, under
//                             the USER'S Link OAuth token, only after the SDK
//                             minted a payment token (cpt_). Confirm cannot
//                             create anything yet, so this processor defers
//                             initiation (see deferredInitiation) and the
//                             /v1/crypto onramp-session route does the mint.
export class StripeCryptoFundingProcessor extends StripeOnrampFundingProcessor {
  override readonly provider = 'stripe_crypto'

  // Confirm's contract switch: skip initiateFunding + the funding_payment_ref
  // persist. The transfer sits PENDING_PAYMENT with a null ref until the pay
  // step creates a session; the existing null-ref abandonment sweep already
  // treats such rows as dead (no ledger postings, no funds).
  readonly deferredInitiation = true as const

  override isConfigured(): boolean {
    return Boolean(
      super.isConfigured() &&
        env.STRIPE_CRYPTO_OAUTH_CLIENT_ID &&
        env.STRIPE_CRYPTO_OAUTH_CLIENT_SECRET,
    )
  }

  // K5 pay-step bootstrap: with a null ref (the normal deferred state) the
  // browser still needs the publishable key to initialize the embedded SDK —
  // it is deliberately NOT a NEXT_PUBLIC_ env (docs/decisions.md), so the
  // funding-session route serves it. Public-by-design material only.
  getDeferredClientBootstrap(): FundingClientSession {
    return {
      provider: this.provider,
      // superRefine guarantees the key under FUNDING_PROCESSOR=stripe_crypto;
      // the assertion guards direct construction, same as getClientSession.
      fields: { publishableKey: env.STRIPE_PUBLISHABLE_KEY! },
    }
  }

  override async initiateFunding(): Promise<FundingInitiation> {
    // Unreachable: confirm branches on deferredInitiation before calling.
    // Throwing (not a stub session) keeps a future code path from silently
    // minting an unauthenticated session where a user-scoped one belongs.
    throw new Error(
      'stripe_crypto defers initiation — sessions are created at the pay step (POST /v1/crypto/transfers/:id/onramp-session)',
    )
  }
}
