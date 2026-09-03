-- Migration: allow 'sender_kyc_pending' as a payout_hold_reason (K6)
-- Created: 20260902235829
-- Rollback (safe only once no row holds 'sender_kyc_pending'):
--   alter table public.transfers drop constraint transfers_payout_hold_reason_check,
--     add constraint transfers_payout_hold_reason_check
--       check (payout_hold_reason in ('fx_drift', 'payability', 'submit_error', 'velocity_review'));

-- K6 decision 8: under KYC-at-first-send the payout side must not pay on
-- behalf of a sender whose Bridge customer is not yet approved. payout-submit
-- parks such a FUNDED row on 'sender_kyc_pending' — the system's FIRST
-- auto-released hold: the Bridge approval webhook clears it and re-enqueues
-- the submit, no human in the loop (docs/runbooks/payout-holds.md). Extend the
-- payout_hold_reason CHECK to admit it. Postgres has no ALTER CONSTRAINT for a
-- CHECK, so drop and re-add. Must apply before the code that places it.
alter table public.transfers
  drop constraint transfers_payout_hold_reason_check,
  add constraint transfers_payout_hold_reason_check
    check (
      payout_hold_reason in ('fx_drift', 'payability', 'submit_error', 'velocity_review', 'sender_kyc_pending')
    );
