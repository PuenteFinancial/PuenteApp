// Leaf module — no imports. Processor files (stripe-onramp.ts,
// stripe-crypto.ts) need this class by value, and index.ts also imports
// processor classes by value; if this lived in index.ts that made a
// circular value dependency that was harmless until stripe-crypto.ts added
// a top-level `extends` inside the cycle. Node's per-file ESM loader
// tolerates that ordering, but tsup/esbuild's code-split bundle (two
// entry points, server.ts + worker.ts, sharing a chunk) does not — it
// evaluated the subclass before its base class was initialized
// ("Class extends value undefined"). Keeping this error dependency-free
// removes the cycle instead of relying on bundler chunk ordering.

/**
 * A processor refused to START funding for reasons the sender needs to hear
 * about (#213) — not a transport fault, not a config bug on our side:
 *   unsupported — Stripe judged this customer un-onrampable (geo/profile via
 *                 customer_ip_address pre-check). Confirm maps it to a 403
 *                 with the stable code `funding_unsupported`.
 *   disabled    — Stripe's fraud kill switch shut session creation off
 *                 account-wide. Confirm maps it to the existing 503
 *                 `not_configured` (same sender experience as an unconfigured
 *                 processor: nothing they did, try later).
 * Seam-level so confirm can branch without importing processor internals;
 * adapters throw it ONLY from initiateFunding.
 */
export class FundingInitiationError extends Error {
  constructor(public readonly code: 'unsupported' | 'disabled') {
    super(`funding initiation refused: ${code}`)
    this.name = 'FundingInitiationError'
  }
}
