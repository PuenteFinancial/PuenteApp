-- Migration: ops_transfer_state_counts() — transfers-by-state for the ops page (slice 8.5-v1)
-- Created: 20260801171303
--
-- The read-only ops overview (GET /v1/ops/overview, docs/api-contract.md) needs
-- "all transfers grouped by state". A TS-side count over a bounded select is
-- dishonest here: terminal states (COMPLETED, REFUNDED, …) grow without bound,
-- so the ROW_BOUND loud-throw convention would 500 the page exactly when the
-- business succeeds. GROUP BY in SQL is one query and drift-proof — it returns
-- whatever states exist, so a future state can never be silently uncounted.
--
-- Service-role only, same posture as the reconcile_* functions
-- (20260731180123): counts carry no PII but they are money-ops data.
--
-- Rollback:
--   drop function public.ops_transfer_state_counts();

create or replace function public.ops_transfer_state_counts()
returns table (state text, count bigint)
language sql
stable
set search_path = public
as $$
  select t.state, count(*) as count
    from public.transfers t
   group by t.state
   order by t.state;
$$;

revoke execute on function public.ops_transfer_state_counts() from public, anon, authenticated;
grant execute on function public.ops_transfer_state_counts() to service_role;
