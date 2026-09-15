-- Migration: allow 'reconciliation_ack' and 'reconciliation_ack_revoke' as ops_actions actions
-- Created: 20260915105300
-- Rollback (safe only once no row carries either):
--   alter table public.ops_actions drop constraint ops_actions_action_check,
--     add constraint ops_actions_action_check
--       check (action in ('hold_release', 'refund', 'cancellation_resolve', 'manual_funding',
--                         'deposit_instructions_attach', 'deposit_landed', 'float_topup',
--                         'sender_freeze', 'sender_unfreeze', 'transfer_cancel'));

-- The provenance rows for scripts/acknowledge-finding.ts: an operator judged a reconciliation
-- finding understood, and silenced it until a stated date — or changed their mind and revoked it.
--
-- Why these belong in ops_actions at all, when reconciliation_acknowledgements already records
-- who and why: that table is STATE ("is this finding currently acknowledged?"), and its one
-- permitted edit is revocation. ops_actions is the append-only history. The pair is the same
-- split the repo already uses for transfers / transfer_transitions, and it is what makes
-- "who silenced this alarm, and when did they let it ring again" answerable from one table in
-- the order it happened.
--
-- TWO actions, not one with a before/after to squint at. Silencing a check and un-silencing it
-- are read for opposite questions — "what are we not being told right now" versus "what did we
-- decide to start watching again" — and an auditor scanning the action column should not have to
-- open jsonb to tell which happened.
--
-- transfer_id is null on both: a finding is keyed on (check_name, finding_key), and most checks
-- are not transfer-scoped at all (bridge_wallet_float, provider_fee_accrual). The finding's
-- identity lives in the ops_actions `before`/`after` payload and in the acknowledgement row.
--
-- Always human-initiated: actor is `ops:<operator uuid>` with a typed note. Nothing in the system
-- acknowledges a finding on its own, and nothing should — that is the entire point of the table.
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
        'sender_unfreeze',
        'transfer_cancel',
        'reconciliation_ack',
        'reconciliation_ack_revoke'
      )
    );
