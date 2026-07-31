-- Migration: reconciliation_runs + the daily reconciliation check functions (slice-8 O2)
-- Created: 20260731180123
--
-- The `ledger.reconcile` worker cron (docs/runbooks/reconciliation.md) runs a
-- registry of checks and persists ONE row per run for audit + the future ops
-- page (8.5-v1). The SQL-side checks live here as service-role functions
-- because they need GROUP BY / joins PostgREST cannot express:
--
--   reconcile_ledger_net_zero()     — transactions whose entries don't net to
--                                     zero per currency (should be impossible:
--                                     the deferred constraint triggers enforce
--                                     it; this is the independent audit)
--   reconcile_ledger_min_entries()  — transactions with < 2 entries (same)
--   reconcile_state_postings()      — transfers whose state disagrees with the
--                                     ledger postings the state machine says
--                                     must (or must not) exist
--   reconcile_account_balances()    — every account's derived balance in one
--                                     pass (run-row snapshot + negative-balance
--                                     findings in the job)
--
-- A failed self-check is a code bug, never data to "fix" — the job pages at
-- highest severity and a human investigates (corrections are new transactions;
-- the ledger is append-only).
--
-- Rollback:
--   drop function public.reconcile_account_balances();
--   drop function public.reconcile_state_postings();
--   drop function public.reconcile_ledger_min_entries();
--   drop function public.reconcile_ledger_net_zero();
--   drop table public.reconciliation_runs;

-- ---------------------------------------------------------------------------
-- reconciliation_runs — one row per completed run (append-only audit record)
-- ---------------------------------------------------------------------------

create table public.reconciliation_runs (
  id             uuid primary key default gen_random_uuid(),
  started_at     timestamptz not null,
  finished_at    timestamptz not null,
  -- pass: every check ran clean; findings: >=1 check found discrepancies;
  -- error: >=1 check could not complete (its findings are unknown, not zero)
  status         text not null check (status in ('pass', 'findings', 'error')),
  findings_count integer not null default 0 check (findings_count >= 0),
  -- per-check results: [{ name, status, findings_count, summary, error? }, …]
  -- Counts and refs only — never PII, never provider payloads.
  checks         jsonb not null,
  -- snapshot of every ledger account's derived balance at run time
  -- ({ code: { amount_minor, currency }, … }) — the ops page's
  -- "state of the world" input, and the trend line for drift.
  balances       jsonb not null default '{}'::jsonb,
  created_at     timestamptz not null default now()
);

comment on table public.reconciliation_runs is
  'Daily ledger.reconcile cron output (slice-8 O2). One append-only row per run; per-check summaries in `checks`. Findings are investigated by a human — nothing here auto-adjusts money.';

-- Written once at run end, then immutable — same posture as the ledger tables
-- (an audit record that can be edited is not an audit record).
create trigger reconciliation_runs_append_only
  before update or delete on public.reconciliation_runs
  for each row execute function public.ledger_forbid_mutation();

alter table public.reconciliation_runs enable row level security;

-- Financial-ops data: no client access; the worker/API use service_role.
create policy "reconciliation_runs_deny_all" on public.reconciliation_runs
  for all using (false);

-- The ops page reads "latest run(s)" — time-ordered access path.
create index reconciliation_runs_created_at_idx
  on public.reconciliation_runs (created_at desc);

revoke update, delete on public.reconciliation_runs from anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- reconcile_ledger_net_zero — entries must net to zero per (transaction, currency)
-- ---------------------------------------------------------------------------

create or replace function public.reconcile_ledger_net_zero()
returns table (ledger_transaction_id uuid, currency char(3), net_minor bigint)
language sql
stable
set search_path = public
as $$
  select e.ledger_transaction_id,
         e.currency,
         sum(case when e.direction = 'debit' then e.amount_minor else -e.amount_minor end) as net_minor
    from public.ledger_entries e
   group by e.ledger_transaction_id, e.currency
  having sum(case when e.direction = 'debit' then e.amount_minor else -e.amount_minor end) <> 0;
$$;

-- ---------------------------------------------------------------------------
-- reconcile_ledger_min_entries — every transaction needs >= 2 entries
-- ---------------------------------------------------------------------------

create or replace function public.reconcile_ledger_min_entries()
returns table (ledger_transaction_id uuid, entry_count bigint)
language sql
stable
set search_path = public
as $$
  select t.id as ledger_transaction_id, count(e.id) as entry_count
    from public.ledger_transactions t
    left join public.ledger_entries e on e.ledger_transaction_id = t.id
   group by t.id
  having count(e.id) < 2;
$$;

-- ---------------------------------------------------------------------------
-- reconcile_state_postings — the book must agree with the state machine
-- ---------------------------------------------------------------------------
-- Postings are keyed (transfer_id, transition) — ledger_transactions.transition —
-- so presence/absence per state is checkable exactly. Rules mirror the posting
-- code (services/transfers.ts batch builders + services/payouts.ts):
--
--   * PENDING_PAYMENT / PAYMENT_FAILED: no postings may exist at all (the
--     FUNDED batch never ran; reconcile-pending documents these as dead rows)
--   * every state past funding (FUNDED…UNDER_REVIEW): the FUNDED posting exists
--   * SUBMITTED / IN_FLIGHT / COMPLETED: the SUBMITTED posting exists
--   * COMPLETED: the COMPLETED posting exists
--   * CANCELED: the CANCELED posting exists
--   * REFUNDED: the REFUNDED posting exists UNLESS the transfer came through
--     CANCELED (CANCELED→REFUNDED posts nothing — the CANCELED reversal already
--     zeroed the books), so one of the two postings must exist
--
-- UNDER_REVIEW and FUNDING_REVERSED get only the FUNDED-posting rule: their
-- open positions depend on the entry path (transfer_transitions), which is a
-- human investigation, not a mechanical rule.

create or replace function public.reconcile_state_postings()
returns table (transfer_id uuid, state text, problem text)
language sql
stable
set search_path = public
as $$
  with posted as (
    select lt.transfer_id, array_agg(lt.transition) as transitions
      from public.ledger_transactions lt
     where lt.transfer_id is not null
     group by lt.transfer_id
  )
  select t.id, t.state, p.problem
    from public.transfers t
    left join posted on posted.transfer_id = t.id
    cross join lateral (
      select unnest(array_remove(array[
        case when t.state in ('PENDING_PAYMENT', 'PAYMENT_FAILED')
              and posted.transfer_id is not null
             then 'unexpected_postings_before_funding' end,
        case when t.state in ('FUNDED', 'SUBMITTED', 'IN_FLIGHT', 'COMPLETED', 'CANCELED',
                              'PAYOUT_FAILED', 'REFUNDED', 'FUNDING_REVERSED', 'UNDER_REVIEW')
              and not (coalesce(posted.transitions, '{}') @> array['FUNDED'])
             then 'missing_FUNDED_posting' end,
        case when t.state in ('SUBMITTED', 'IN_FLIGHT', 'COMPLETED')
              and not (coalesce(posted.transitions, '{}') @> array['SUBMITTED'])
             then 'missing_SUBMITTED_posting' end,
        case when t.state = 'COMPLETED'
              and not (coalesce(posted.transitions, '{}') @> array['COMPLETED'])
             then 'missing_COMPLETED_posting' end,
        case when t.state = 'CANCELED'
              and not (coalesce(posted.transitions, '{}') @> array['CANCELED'])
             then 'missing_CANCELED_posting' end,
        case when t.state = 'REFUNDED'
              and not (coalesce(posted.transitions, '{}') && array['REFUNDED', 'CANCELED'])
             then 'missing_REFUNDED_or_CANCELED_posting' end
      ], null)) as problem
    ) p;
$$;

-- ---------------------------------------------------------------------------
-- reconcile_account_balances — every account's derived balance, one pass
-- ---------------------------------------------------------------------------
-- Same signing convention as ledger_account_balance (normal-balance-signed),
-- returned for ALL accounts at once so the run snapshot is a single query.

create or replace function public.reconcile_account_balances()
returns table (code text, amount_minor bigint, currency char(3))
language sql
stable
set search_path = public
as $$
  select a.code,
         coalesce(sum(
           case when e.direction = a.normal_balance
                then e.amount_minor
                else -e.amount_minor end
         ), 0)::bigint as amount_minor,
         a.currency
    from public.ledger_accounts a
    left join public.ledger_entries e on e.account_id = a.id
   group by a.code, a.currency
   order by a.code;
$$;

-- ---------------------------------------------------------------------------
-- privileges: service-role only, like every ledger function
-- ---------------------------------------------------------------------------

revoke execute on function public.reconcile_ledger_net_zero() from public, anon, authenticated;
revoke execute on function public.reconcile_ledger_min_entries() from public, anon, authenticated;
revoke execute on function public.reconcile_state_postings() from public, anon, authenticated;
revoke execute on function public.reconcile_account_balances() from public, anon, authenticated;

grant execute on function public.reconcile_ledger_net_zero() to service_role;
grant execute on function public.reconcile_ledger_min_entries() to service_role;
grant execute on function public.reconcile_state_postings() to service_role;
grant execute on function public.reconcile_account_balances() to service_role;
