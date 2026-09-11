-- Migration: allow 'sender_unfreeze' as an ops_actions action
-- Created: 20260910200100
-- Rollback (safe only once no row carries it):
--   alter table public.ops_actions drop constraint ops_actions_action_check,
--     add constraint ops_actions_action_check
--       check (action in ('hold_release', 'refund', 'cancellation_resolve', 'manual_funding',
--                         'deposit_instructions_attach', 'deposit_landed', 'float_topup',
--                         'sender_freeze'));

-- The freeze got provenance in 20260910181500. The UNFREEZE had none: nothing set users.status
-- back to 'active' at all, and the runbook's only answer was a SQL UPDATE in the Supabase editor
-- whose sole trace was query history. That is the worse half of the pair — a freeze that appears
-- from nowhere is a mystery, but a freeze that DISAPPEARS from nowhere is the one an examiner
-- asks about, because someone chose to let a suspected-fraud account transact again.
--
-- Deliberately its own action rather than a second 'sender_freeze' row with an inverted
-- before/after: the two are read for different questions ("why is this account stopped" vs "who
-- decided it was safe"), and an action vocabulary that needs before/after inspection to tell a
-- stop from a start is one an operator will misread under time pressure.
--
-- Unlike the freeze, this one is always human-initiated: actor is `ops:<operator uuid>` and the
-- writer requires a typed note (apps/api/scripts/unfreeze-sender.ts). A defaulted actor is
-- worthless in an audit trail, which is why the CLI refuses to run without --operator.
--
-- Postgres has no ALTER CONSTRAINT for a CHECK, so drop and re-add. Must apply before the code
-- that writes it.
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
        'sender_unfreeze'
      )
    );
