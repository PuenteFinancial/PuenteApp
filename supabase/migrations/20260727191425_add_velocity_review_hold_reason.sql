-- Migration: allow 'velocity_review' as a payout_hold_reason
-- Created: 20260727191425
-- Rollback (safe only once no row holds 'velocity_review'):
--   alter table public.transfers drop constraint transfers_payout_hold_reason_check,
--     add constraint transfers_payout_hold_reason_check
--       check (payout_hold_reason in ('fx_drift', 'payability', 'submit_error'));

-- Slice-7 PR5 adds the per-user velocity backstop at FUNDED -> SUBMITTED: an
-- over-limit funded transfer is parked on a 'velocity_review' hold for ops to
-- release or refund (docs/runbooks/payout-holds.md), NOT self-healed — a per-user
-- tally doesn't drain like the aggregate float ceiling. Extend the
-- payout_hold_reason CHECK to admit it alongside the slice-5 reasons.
-- Postgres has no ALTER CONSTRAINT for a CHECK, so drop and re-add.
alter table public.transfers
  drop constraint transfers_payout_hold_reason_check,
  add constraint transfers_payout_hold_reason_check
    check (payout_hold_reason in ('fx_drift', 'payability', 'submit_error', 'velocity_review'));
