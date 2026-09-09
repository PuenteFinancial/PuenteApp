-- Migration: ops_actions — append-only record of every operator action taken from the ops board
--            (ops board slice 1 / O-B; audit 2026-09-02 corner "no durable actor record for
--            non-transition money ops")
-- Created: 20260908171500
-- Rollback: drop table public.ops_actions;
--
-- Why a table: transfer_transitions carries the actor of a STATE CHANGE, and the audit plugin
-- logs that a request hit — but neither records the operator's stated reason or note, nor the
-- before/after the operator saw, and a hold release changes no state at all. Until now a
-- release was a SQL statement in the Supabase editor whose only trace was query history. This
-- table is the durable "who did what, why, and what did they see" for every ops write.
--
-- Shape: one row per action. `actor` is the same vocabulary as transfer_transitions.actor
-- ('ops:<admin user id>'). `action` is CHECK-pinned to the routes that exist — the five
-- pre-existing ops writes plus the two O-B adds — so an unknown action is a migration, not a
-- typo. `reason` is MACHINE vocabulary only (the hold reason released, the decision, the
-- outcome); the operator's free text lives in `note`, bounded, and never enters
-- transfer_transitions.reason. `before`/`after` are built from fixed keys by each caller —
-- never a row spread — which is the PII guard for the two jsonb columns. `request_id` is the
-- Fastify request id, so a row joins to the audit-plugin log line for the same click.
--
-- Written best-effort by the API (services/ops-actions.ts): the state change, the ledger, and
-- the transition actor remain the PRIMARY record; a failed secondary write pages Sentry rather
-- than turning a completed money movement into a 500 that invites a retry. Nothing reads this
-- table yet. No backfill: prior ops actions live in transfer_transitions (actor ops:*) and logs.
--
-- Retention: nothing here deletes or ages out rows (append-only, RESTRICT on the transfer), so
-- the table meets any retention floor by default. A written retention policy (BSA/AML examiners
-- expect ≥ 5 years for operator-intervention records) is a counsel item before the pilot, not a
-- schema change — compliance review 2026-09-08.

create table public.ops_actions (
  id          uuid primary key default gen_random_uuid(),
  actor       text not null check (char_length(actor) between 1 and 100),
  action      text not null check (
    action in (
      'hold_release',
      'refund',
      'cancellation_resolve',
      'manual_funding',
      'deposit_instructions_attach',
      'deposit_landed',
      'float_topup'
    )
  ),
  -- RESTRICT: an action taken on a transfer with financial history survives.
  -- Null only for treasury-level actions (float_topup has no transfer).
  transfer_id uuid references public.transfers(id) on delete restrict,
  reason      text check (reason is null or char_length(reason) between 1 and 100),
  note        text check (note is null or char_length(note) between 1 and 500),
  before      jsonb not null default '{}'::jsonb check (jsonb_typeof(before) = 'object'),
  after       jsonb not null default '{}'::jsonb check (jsonb_typeof(after) = 'object'),
  request_id  text check (request_id is null or char_length(request_id) between 1 and 200),
  created_at  timestamptz not null default now()
);

-- The read patterns: one transfer's action history, and "what happened today".
create index ops_actions_transfer_created_idx
  on public.ops_actions (transfer_id, created_at desc);
create index ops_actions_created_idx
  on public.ops_actions (created_at desc);

-- Append-only, same guard as consents / kyc_verifications / transfer_transitions.
create trigger forbid_ops_actions_mutation
  before update or delete on public.ops_actions
  for each row execute procedure public.forbid_mutation();

alter table public.ops_actions enable row level security;

-- Service-role only: operator provenance is not client data. No client role may read or
-- write a row.
create policy "ops_actions_deny_all" on public.ops_actions
  for all using (false);
