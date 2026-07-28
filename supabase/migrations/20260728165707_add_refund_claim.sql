-- Migration: the refund claim (remittance MVP slice 7, PR 6b-0)
-- Created: 2026-07-28
-- Alters: transfers — refund_claimed_at, refund_claimed_by. Lifecycle columns,
--         deliberately NOT added to enforce_transfer_terms_frozen (same as
--         submit_attempted_at / refunded_at / funding_cleared).
-- Rollback:
--   alter table public.transfers
--     drop column refund_claimed_at,
--     drop column refund_claimed_by;

-- The PAYOUT_FAILED → REFUNDED tail (services/refunds.ts) gated its disbursement
-- on `refund_payment_ref is null` — a READ separated from its write, so two
-- concurrent runs (a poller re-drive and an operator's trigger-refund.ts, or two
-- webhook deliveries) both read null and both call the processor. Exactly-once
-- rested entirely on the processor's idempotency key, and the mock funding
-- processor ignores that key by design. These columns make the claim real.
--
-- refund_claimed_at: the atomic claim, sibling of submit_attempted_at. Set once
-- by the winning guarded UPDATE (... where refund_payment_ref is null and
-- refund_claimed_at is null) before the processor call.
--
-- It is DELIBERATELY ASYMMETRIC to submit_attempted_at, and the difference is
-- the whole point (see decisions.md 2026-07-28). A stale submit claim is
-- recovered by re-POSTing to Bridge, which dedupes on the key, so it cannot
-- double-pay. Nothing gives the funding seam that guarantee, so a stale refund
-- claim is NEVER retaken automatically: non-null here means a disbursement is in
-- flight OR died mid-flight, and after 30 minutes it becomes an ops decision
-- (runbooks/manual-refund.md, `--reclaim`).
--
-- Never cleared on success — the refund_payment_ref gate takes over from there,
-- and the stamp stays as the record of when the money left. Cleared in exactly
-- one place: releaseStaleRefundClaim, guarded to only-if-abandoned.
--
-- refund_claimed_by: who took it, in the transfer_transitions.actor vocabulary
-- ('worker:payment-event' | 'ops:<id>'). A crashed attempt never reaches the
-- transition, so without this column an abandoned claim leaves NO record of who
-- may have moved the sender's money — which is the judgment an operator has to
-- make before re-claiming. Not PII (an operator id, never a name or a phone).

alter table public.transfers
  add column refund_claimed_at timestamptz,
  add column refund_claimed_by text
               check (refund_claimed_by is null
                      or char_length(refund_claimed_by) between 1 and 100);
