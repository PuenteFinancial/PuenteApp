-- Migration: otp_send_attempts — per-phone admission control for OTP sends
-- Created: 20260817104102
--
-- POST /v1/auth/otp/send is public, unauthenticated, and spends money: every
-- call is a billed Twilio SMS. Until now the only control was a global 100
-- req/min PER IP (server.ts), which does nothing against one user tapping
-- Resend and little against a distributed caller. The client-side 30s cooldown
-- is cosmetic — it lives in the client.
--
-- This table is the server-side budget. It is an append-only log of admitted
-- send attempts, counted over rolling windows.
--
-- WHY A HASH, AND WHY NOT A BARE ONE. The bucket key is
-- HMAC-SHA256(pepper, phone) computed in the API (services/otp-rate-limit.ts).
-- A phone number is PII and must never be stored here in plaintext. A plain
-- SHA-256 would not be enough either: NANP numbers are a ~10^10 space, so an
-- unkeyed digest of one is brute-forced back to the number in seconds. The
-- pepper is what makes this column non-reversible, and therefore what makes
-- this table compatible with the no-PII rule rather than a quiet violation of
-- it. NB this is deliberately NOT the same construction as the `phoneKey`
-- helper in routes/v1/waitlist.ts — that is a truncated bare digest used to
-- correlate two log lines, a different job with a different threat model.
--
-- NO updated_at, deviating from the house new-table template on purpose: rows
-- here are inserted and never modified. An updated_at would be a column that
-- can only ever equal created_at, and a moddatetime trigger firing on writes
-- that do not exist. The append-only shape is what makes the rolling-window
-- counts meaningful.
--
-- Retention is a daily prune (jobs/otp-attempt-prune.ts) — the widest window is
-- a day, so nothing older than that can affect a verdict.
--
-- Rollback:
--   drop function public.otp_attempt_admit(text, integer, integer, integer);
--   drop table public.otp_send_attempts;  -- takes its policy and index with it

-- ---------------------------------------------------------------------------
-- otp_send_attempts — append-only log of admitted sends, one row per attempt
-- ---------------------------------------------------------------------------

create table public.otp_send_attempts (
  id         bigint generated always as identity primary key,
  -- HMAC-SHA256 of the phone number, hex. 64 chars, fixed — the check is a
  -- cheap guard against a caller ever writing a raw number into this column.
  phone_hash text not null check (phone_hash ~ '^[0-9a-f]{64}$'),
  created_at timestamptz not null default now()
);

comment on table public.otp_send_attempts is
  'Append-only log of admitted OTP send attempts, keyed by a peppered HMAC of the phone number. Backs the per-phone rate limit on POST /v1/auth/otp/send. Never stores a phone number.';

comment on column public.otp_send_attempts.phone_hash is
  'HMAC-SHA256(pepper, phone) as hex. Peppered, not a bare digest: an unkeyed hash of a 10-digit number is trivially reversible.';

-- Every read is "rows for this hash, newer than X", so the composite in this
-- order serves all three windows from one index.
create index otp_send_attempts_phone_hash_created_at_idx
  on public.otp_send_attempts (phone_hash, created_at desc);

alter table public.otp_send_attempts enable row level security;

-- Auth-path infrastructure: no client access at all, ever. The API writes and
-- reads via service_role, which bypasses RLS.
create policy "otp_send_attempts_deny_all" on public.otp_send_attempts
  for all using (false);

-- Explicit, rather than leaning on the schema's default privileges. Those are
-- ambient and environment-dependent — a local `supabase start` grants this role
-- only Dxtm on a new table, which is why docs/runbooks/local-dev.md carries a
-- manual GRANT step. A table the auth path cannot function without should not
-- depend on that having been remembered.
--
-- Least privilege, and it happens to encode the table's shape: no UPDATE,
-- because rows are append-only; DELETE only because the retention prune needs
-- it. Nothing for anon or authenticated, which is stricter than the schema
-- default and matches the deny-all policy above.
grant select, insert, delete on public.otp_send_attempts to service_role;

-- ---------------------------------------------------------------------------
-- otp_attempt_admit — check every window and record the attempt, atomically
-- ---------------------------------------------------------------------------
--
-- SERIALISED PER NUMBER BY AN ADVISORY LOCK, and that is load-bearing.
--
-- Reading the counts and then inserting is a time-of-check/time-of-use race:
-- two concurrent requests for the same number both read "under the limit" and
-- both send, which is exactly the burst the cooldown exists to prevent.
--
-- Folding the check and the insert into one statement is NOT sufficient, which
-- is worth stating because it looks like it should be. A data-modifying CTE
-- still runs under the statement's own snapshot, and at READ COMMITTED two
-- concurrent transactions take separate snapshots: both evaluate the counts
-- against a world where the other's row does not exist yet, both pass, and both
-- insert. There is no unique constraint for them to collide on — the table is
-- an append-only log by design. So the guard has to be explicit.
--
-- pg_advisory_xact_lock keyed on the phone hash makes the whole check-and-admit
-- mutually exclusive for a given number, and only for that number: two
-- different callers never contend. It is transaction-scoped, so it releases on
-- commit or rollback with nothing to clean up. (A 64-bit hash collision between
-- two different numbers costs one needless serialisation and nothing else.)
--
-- ADMISSION CONTROL, NOT SUCCESS ACCOUNTING. The row is written when the
-- attempt is ADMITTED, before the API calls Twilio — not after a successful
-- send. Otherwise anyone able to induce provider errors spins for free, because
-- nothing would ever be counted. The cost of this choice is that a genuine
-- Twilio outage consumes a user's daily budget; for a spend control that is the
-- right side to err on.
--
-- A refused attempt is NOT recorded. Being rate limited must not extend the
-- window that is limiting you, or a user tapping Resend could lock themselves
-- out for the rest of the day.
create or replace function public.otp_attempt_admit(
  p_phone_hash       text,
  p_cooldown_seconds integer,
  p_max_hour         integer,
  p_max_day          integer
)
returns table (allowed boolean, retry_after_seconds integer)
language plpgsql
-- Pinned rather than inherited. Not strictly required — every table reference
-- below is schema-qualified and every function called lives in pg_catalog,
-- which is always searched — but an unpinned search_path on a function is what
-- Supabase's database linter flags as function_search_path_mutable, and the
-- cheapest time to not have that warning is before it exists.
set search_path = pg_catalog, public
as $$
begin
  -- Everything below reads and then writes the same number's history, so take
  -- the lock before the first read. Held to end of transaction.
  perform pg_advisory_xact_lock(hashtextextended(p_phone_hash, 0));

  return query
  with w as (
    select
      count(*) filter (
        where created_at > now() - make_interval(secs => p_cooldown_seconds)
      ) as cool_ct,
      count(*) filter (where created_at > now() - interval '1 hour') as hour_ct,
      -- The enclosing where clause already bounds this to a day.
      count(*) as day_ct,
      max(created_at) filter (
        where created_at > now() - make_interval(secs => p_cooldown_seconds)
      ) as cool_last,
      min(created_at) filter (where created_at > now() - interval '1 hour') as hour_first,
      min(created_at) as day_first
    from public.otp_send_attempts
    where phone_hash = p_phone_hash
      and created_at > now() - interval '1 day'
  ),
  ins as (
    insert into public.otp_send_attempts (phone_hash)
    select p_phone_hash
    from w
    where w.cool_ct = 0
      and w.hour_ct < p_max_hour
      and w.day_ct  < p_max_day
    returning 1
  ),
  verdict as (
    select exists (select 1 from ins) as allowed
  )
  select
    v.allowed,
    case
      when v.allowed then 0
      else
        -- The soonest a retry could succeed is when the LAST binding window
        -- clears, hence greatest(). A window clears when its oldest counted
        -- attempt ages out of it. Floored at 1 so Retry-After is never 0.
        greatest(
          1,
          ceil(
            extract(
              epoch from greatest(
                case
                  when w.cool_ct > 0
                  then w.cool_last + make_interval(secs => p_cooldown_seconds) - now()
                  else interval '0'
                end,
                case
                  when w.hour_ct >= p_max_hour
                  then w.hour_first + interval '1 hour' - now()
                  else interval '0'
                end,
                case
                  when w.day_ct >= p_max_day
                  then w.day_first + interval '1 day' - now()
                  else interval '0'
                end
              )
            )
          )::integer
        )
    end as retry_after_seconds
  from w, verdict v;
end;
$$;

comment on function public.otp_attempt_admit(text, integer, integer, integer) is
  'Decides whether an OTP send is within the per-phone budget and records it if so, serialised per number by a transaction-scoped advisory lock. Returns allowed plus a Retry-After hint. Refused attempts are not recorded.';

-- Functions are executable by PUBLIC by default. This one writes to an
-- RLS-denied table on behalf of the caller, so the grant is narrowed to the
-- only role that is meant to reach it.
revoke execute on function public.otp_attempt_admit(text, integer, integer, integer)
  from public, anon, authenticated;
grant execute on function public.otp_attempt_admit(text, integer, integer, integer)
  to service_role;
