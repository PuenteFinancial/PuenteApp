-- Migration: allow 'funding_disputed' and 'sender_suspended' as payout_hold_reason values
-- Created: 20260910180000
-- Rollback (safe only once no row holds either value):
--   alter table public.transfers drop constraint transfers_payout_hold_reason_check,
--     add constraint transfers_payout_hold_reason_check
--       check (payout_hold_reason in ('fx_drift', 'payability', 'submit_error', 'velocity_review', 'sender_kyc_pending'));

-- The FUNDING_REVERSED loss path needs two new ways to refuse a payout.
--
-- 'funding_disputed' — a dispute or ACH return arrived for a transfer whose
-- pesos have NOT left yet. The money we collected is being clawed back, so the
-- payout must stop; nothing is booked, because nothing was lost (see
-- docs/ledger-rules.md — the loss batch belongs to the post-delivery case
-- only). Operator-releasable: winning the dispute is a human judgement, and
-- releasing is how the payout resumes.
--
-- 'sender_suspended' — the sender is frozen (users.status = 'suspended'), so
-- none of their OTHER payouts may leave either. Derived from user state rather
-- than from this transfer, which is why releasing it without unfreezing the
-- user simply re-holds the row on the next sweep. That is safe and
-- self-correcting, and the runbook says to unfreeze first.
--
-- Postgres has no ALTER CONSTRAINT for a CHECK, so drop and re-add. Must apply
-- before the code that places either value.
alter table public.transfers
  drop constraint transfers_payout_hold_reason_check,
  add constraint transfers_payout_hold_reason_check
    check (
      payout_hold_reason in (
        'fx_drift',
        'payability',
        'submit_error',
        'velocity_review',
        'sender_kyc_pending',
        'funding_disputed',
        'sender_suspended'
      )
    );
