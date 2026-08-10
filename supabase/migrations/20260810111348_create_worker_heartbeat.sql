-- Migration: worker_heartbeat — liveness proof for the pg-boss cron dispatcher
-- Created: 20260810111348
--
-- On 2026-08-02 20:04 UTC the staging worker stopped creating jobs and did not
-- resume until 08-03 18:29 — ~22.4 hours with every cron dead. Sentry captured
-- ZERO events; the process stayed up, so the worker's health endpoint
-- (worker.ts, deliberately decoupled from pg-boss readiness so a slow boot
-- isn't killed inside Railway's 30s check window) reported ok the whole time.
-- Railway never restarted it. The outage was found by accident five days later,
-- via a missing reconciliation_runs row — i.e. the daily reconciliation was the
-- de facto liveness check for the entire worker, and it cannot report its own
-- absence.
--
-- This table is the other half of that signal. The `worker.heartbeat` cron
-- upserts its row every 5 minutes; a Sentry cron monitor alerts when the
-- check-in stops, and the ops page reads the row. The handler writes a row
-- rather than merely checking in because BOTH cron dispatch and database access
-- were implicated on 08-02: a beat proves the dispatcher dispatched AND that
-- the worker could still reach the database.
--
-- Keyed by logical worker, NOT by process instance. pg-boss cron dispatch is
-- cluster-wide — the timekeeper enqueues one job per tick and whichever worker
-- polls first runs it. Two replicas of the same service therefore SHARE one row
-- (either one beating proves the dispatcher lives); a per-replica row would go
-- stale simply for losing the poll race and would alarm on a healthy worker. A
-- second worker SERVICE with its own queue set is a genuinely separate
-- dispatcher and adds its own row here with no migration.
--
-- updated_at is the beat, and it is written by the DATABASE via the moddatetime
-- trigger below — never by the worker. A worker with a skewed clock would
-- otherwise be able to report itself recently alive while dead, which is the
-- one direction this signal must never fail in.
--
-- Upsert-in-place, so this is the OPPOSITE posture from reconciliation_runs:
-- deliberately no ledger_forbid_mutation trigger and no revoke of update. This
-- is the current state of the world, not an audit record.
--
-- No index, deliberately: the only access paths are the primary-key upsert and
-- a full scan of a table that holds one row (low single digits even if a second
-- worker service appears). An index on updated_at would be pure write
-- amplification on the most-frequently-updated row in the schema.
--
-- Rollback:
--   drop table public.worker_heartbeat;  -- takes its policy and trigger with it
--   (moddatetime is shared with other tables — leave the extension in place)

create extension if not exists moddatetime schema extensions;

-- ---------------------------------------------------------------------------
-- worker_heartbeat — one row per logical worker service, upserted in place
-- ---------------------------------------------------------------------------

create table public.worker_heartbeat (
  -- The logical dispatcher, not the process: 'worker' is the Railway worker
  -- service that owns every cron in worker.ts. A literal on the app side,
  -- deliberately not derived from the Railway service name — renaming the
  -- service would orphan the old row, which then goes stale forever and alarms
  -- the ops page about a worker that no longer exists.
  worker     text primary key check (char_length(worker) between 1 and 64),
  -- Which build last beat (the deploy's short commit sha). Diagnostic only,
  -- never on the ops wire. It is also the non-key column that makes the upsert
  -- a genuine UPDATE, which is what fires the trigger below. Nullable: local
  -- dev injects no such value.
  instance   text check (instance is null or char_length(instance) <= 200),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

comment on table public.worker_heartbeat is
  'Liveness proof for the pg-boss cron dispatcher (worker.heartbeat, every 5 min). One row per logical worker service, upserted in place. A stale updated_at means job dispatch or database access stopped.';

comment on column public.worker_heartbeat.updated_at is
  'The beat. Database-generated via moddatetime so a worker with a skewed clock cannot report itself alive.';

create trigger handle_worker_heartbeat_updated_at
  before update on public.worker_heartbeat
  for each row execute procedure extensions.moddatetime(updated_at);

alter table public.worker_heartbeat enable row level security;

-- Infrastructure telemetry: no client access at all. The worker writes and the
-- ops API reads, both via service_role.
create policy "worker_heartbeat_deny_all" on public.worker_heartbeat
  for all using (false);
