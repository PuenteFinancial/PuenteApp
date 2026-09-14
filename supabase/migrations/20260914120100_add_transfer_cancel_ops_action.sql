-- Migration: allow 'transfer_cancel' as an ops_actions action
-- Created: 20260914120100
-- Rollback (safe only once no row carries it):
--   alter table public.ops_actions drop constraint ops_actions_action_check,
--     add constraint ops_actions_action_check
--       check (action in ('hold_release', 'refund', 'cancellation_resolve', 'manual_funding',
--                         'deposit_instructions_attach', 'deposit_landed', 'float_topup',
--                         'sender_freeze', 'sender_unfreeze'));

-- The provenance row for the new exit (scripts/cancel-held-transfer.ts,
-- services/ops-cancel.ts): an operator judged a held payout undeliverable,
-- canceled it, and returned the sender's money.
--
-- Deliberately NOT 'hold_release' with a different note. A release says "this
-- payout may now go"; this says "this payout never will". They are read for
-- opposite questions and an action vocabulary that needs before/after
-- inspection to tell one from the other is one an operator will misread.
--
-- Deliberately NOT 'refund' either, even though a refund is half of what it
-- does. 'refund' means the PAYOUT_FAILED tail — Bridge had the principal and
-- sent it back — and an auditor reading a 'refund' row is entitled to assume a
-- bridge_return posting exists. Here nothing ever reached Bridge.
--
-- Always human-initiated: actor is `ops:<operator uuid>` with a typed note.
-- Nothing in the system writes this action on its own, and nothing should — an
-- undeliverable payout is a judgement, not an event.
--
-- Postgres has no ALTER CONSTRAINT for a CHECK, so drop and re-add. Must apply
-- before the code that writes it.
alter table public.ops_actions
  drop constraint ops_actions_action_check,
  add constraint ops_actions_action_check
    check (
      action in (
        'hold_release',
        'refund',
        'cancellation_resolve',
        'manual_funding',
        'deposit_instructions_attach',
        'deposit_landed',
        'float_topup',
        'sender_freeze',
        'sender_unfreeze',
        'transfer_cancel'
      )
    );
