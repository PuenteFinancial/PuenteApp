-- Migration: reconciliation_acknowledgements — let a human record "I looked at this finding and
--            it is understood", so reconciliation stops paging on it until a stated date
-- Created: 20260915105200
-- Rollback: alter table public.reconciliation_runs drop column acknowledged_count;
--           drop table public.reconciliation_acknowledgements;
--           drop function public.reconciliation_acknowledgements_forbid_edit();
--
-- WHY THIS EXISTS. Every check in the registry is a pure diff between an external system and our
-- books, re-run on a fixed tick with no memory. A discrepancy that is real, understood, and
-- settled therefore pages every 6 hours until its own lookback window ages out — 60 days for
-- stripe_disputes. The three 2026-09-10 staging disputes are the worked example: they went
-- unrecorded because they PREDATE the loss path that records them (#310, #313), which is not a
-- defect and cannot be "fixed", yet they will page until 2026-11-09. An inbox that fills with
-- findings a human has already resolved is an inbox nobody reads, and that is how the one finding
-- that mattered gets missed. This table is the missing "acknowledged" state.
--
-- WHAT AN ACKNOWLEDGEMENT IS NOT. It is not a fix, and it is not a way to make a check quieter.
-- Three guards keep it from becoming one:
--
--   1. IT EXPIRES, ALWAYS. `expires_at` is NOT NULL and capped at 90 days past creation by CHECK.
--      There is no "forever" and no way to write one — a permanent acknowledgement is a permanent
--      blind spot, and the cap means the worst case of a bad judgement call is bounded and
--      self-healing. 90 days clears the 60-day dispute window with room to spare.
--   2. IT NAMES A HUMAN AND A REASON. `actor` and `note` are both NOT NULL, note at 10-500 chars.
--      A defaulted actor is worthless in an audit trail (trigger-refund.ts precedent), and an
--      acknowledgement with no stated reason is the row an examiner asks about.
--   3. FATAL CHECKS CANNOT BE ACKNOWLEDGED. Enforced in the runner and in the CLI, not here --
--      severity lives in the code registry, not in the database. A ledger that does not net to
--      zero is never "understood and fine".
--
-- SUPPRESSION IS ON THE KEY, NOT THE DETAIL. `finding_key` is the check's stable dedupe key (the
-- same string that forms the Sentry fingerprint), so an acknowledgement covers that finding even
-- if its detail later shifts — a dispute moving needs_response -> lost keeps the same key and stays
-- quiet. That is the deliberate trade: keying on detail would re-page on every incidental field
-- change and make acknowledgement useless in practice. `detail` snapshots what the finding looked
-- like when it was acknowledged, so the diff is reconstructable, and the expiry cap is what bounds
-- the trade. THE ESCAPE HATCH, if this bites: add a `detail_fingerprint` column and compare it in
-- the runner's filter — additive, no backfill, no change to any existing row.
--
-- NO UNIQUE INDEX ON (check_name, finding_key) ON PURPOSE. The natural partial index -- unique
-- where revoked_at is null -- would permanently block re-acknowledging a key whose earlier
-- acknowledgement merely EXPIRED, and a CHECK predicate cannot call now() to say otherwise.
-- "At most one active acknowledgement" is enforced by the CLI instead; a duplicate is harmless
-- (the runner suppresses on ANY active row) rather than a wedge with no way out.
--
-- NO updated_at, deliberately, against the financial-schema-checklist default: `revoked_at` is the
-- only mutation this table permits and it carries its own timestamp, so a second one would record
-- nothing the first does not.
--
-- Provenance: creating or revoking an acknowledgement also writes an ops_actions row
-- (see the companion migration) — that table stays the append-only "who did what, why".

create table public.reconciliation_acknowledgements (
  id          uuid primary key default gen_random_uuid(),
  -- The check's registry name (services/reconciliation.ts buildChecks). Text, not an enum: the
  -- registry is code, and a check added there must not need a migration to be acknowledgeable.
  check_name  text not null check (char_length(check_name) between 1 and 100),
  -- CheckFinding.key — ids and refs only by construction, so no PII lands here.
  finding_key text not null check (char_length(finding_key) between 1 and 200),
  -- Same vocabulary as ops_actions.actor / transfer_transitions.actor ('ops:<admin user id>').
  actor       text not null check (char_length(actor) between 1 and 100),
  -- What the operator verified. Required, never defaulted.
  note        text not null check (char_length(note) between 10 and 500),
  -- The finding's detail at acknowledgement time. Built by the caller from the finding itself;
  -- findings carry ids and refs only, which is what keeps this column PII-free.
  detail      jsonb not null default '{}'::jsonb check (jsonb_typeof(detail) = 'object'),
  -- Bounded by construction: after this instant the finding pages again, no action required.
  expires_at  timestamptz not null,
  revoked_at  timestamptz,
  created_at  timestamptz not null default now(),

  -- The cap, in the schema rather than only in the CLI: a direct INSERT cannot buy more than
  -- 90 days of silence either. Compares two stored columns, so it stays immutable.
  constraint reconciliation_acknowledgements_window_check
    check (expires_at > created_at and expires_at <= created_at + interval '90 days'),
  constraint reconciliation_acknowledgements_revoked_check
    check (revoked_at is null or revoked_at >= created_at)
);

-- The runner's read, once per run: every active acknowledgement.
create index reconciliation_acknowledgements_active_idx
  on public.reconciliation_acknowledgements (check_name, finding_key, expires_at)
  where revoked_at is null;
-- "What has been acknowledged lately" for review.
create index reconciliation_acknowledgements_created_idx
  on public.reconciliation_acknowledgements (created_at desc);

-- Near-append-only: the acknowledgement FACT is immutable, and revocation is the one permitted
-- edit — one way, null -> set. Everything else is a new row. Without this, "acknowledged until
-- the 20th" could be quietly rewritten to "until the 20th of next year" with nothing to show it.
create or replace function public.reconciliation_acknowledgements_forbid_edit()
returns trigger
language plpgsql
as $$
begin
  if new.id          is distinct from old.id
     or new.check_name  is distinct from old.check_name
     or new.finding_key is distinct from old.finding_key
     or new.actor       is distinct from old.actor
     or new.note        is distinct from old.note
     or new.detail      is distinct from old.detail
     or new.expires_at  is distinct from old.expires_at
     or new.created_at  is distinct from old.created_at
  then
    raise exception 'reconciliation acknowledgement % is immutable: revoke it and write a new one', old.id;
  end if;
  if old.revoked_at is not null and new.revoked_at is distinct from old.revoked_at then
    raise exception 'reconciliation acknowledgement % is already revoked at %', old.id, old.revoked_at;
  end if;
  return new;
end;
$$;

create trigger reconciliation_acknowledgements_immutable
  before update on public.reconciliation_acknowledgements
  for each row execute function public.reconciliation_acknowledgements_forbid_edit();

-- Deletion is never the answer: an acknowledgement that was a mistake is revoked, not erased.
create trigger reconciliation_acknowledgements_no_delete
  before delete on public.reconciliation_acknowledgements
  for each row execute procedure public.forbid_mutation();

alter table public.reconciliation_acknowledgements enable row level security;

-- Service-role only, like ops_actions: operator provenance is not client data.
create policy "reconciliation_acknowledgements_deny_all" on public.reconciliation_acknowledgements
  for all using (false);

-- ---------------------------------------------------------------------------
-- reconciliation_runs gains the count of what was suppressed
-- ---------------------------------------------------------------------------
-- A muzzled run must never be indistinguishable from a clean one. `findings_count` narrows to
-- mean UNACKNOWLEDGED (actionable) findings — the number a human should react to, and what the
-- run's status is computed from — while this column carries the ones that were suppressed.
-- Rows written before this migration have no acknowledgements by construction, so the default of
-- 0 is accurate history, not a filler value.
alter table public.reconciliation_runs
  add column acknowledged_count integer not null default 0
    check (acknowledged_count >= 0);
