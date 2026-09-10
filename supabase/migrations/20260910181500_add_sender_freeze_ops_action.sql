-- Migration: allow 'sender_freeze' as an ops_actions action
-- Created: 20260910181500
-- Rollback (safe only once no row carries it):
--   alter table public.ops_actions drop constraint ops_actions_action_check,
--     add constraint ops_actions_action_check
--       check (action in ('hold_release', 'refund', 'cancellation_resolve', 'manual_funding',
--                         'deposit_instructions_attach', 'deposit_landed', 'float_topup'));

-- The loss path freezes a sender automatically (users.status = 'suspended') when a dispute or
-- ACH return lands. Without a row here, the ONLY evidence of that freeze is the users column
-- itself plus a Sentry event: an auditor reading `status = 'suspended'` could not say when it
-- happened, why, or what triggered it, and an unfreeze would leave no trail at all.
--
-- It is recorded as an ops_action even though no operator took it. That is deliberate: the
-- `actor` vocabulary already carries non-human writers ('webhook:bridge' — see the late
-- registration auto-release), the table is the append-only record of things DONE TO a transfer
-- and its sender, and splitting system-initiated account actions into a second table would mean
-- two places to look during the one investigation where time matters.
--
-- transfer_id is the DISPUTED transfer, which is the provenance that matters: it ties the frozen
-- account to the clawback that caused it.
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
        'sender_freeze'
      )
    );
