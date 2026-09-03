-- Migration: otp_verify_attempts — per-phone brute-force bound on OTP verification (K7a)
-- Created: 20260903170100
--
-- POST /v1/auth/otp/verify is public and unauthenticated. The send leg has had
-- a per-phone budget since #188 (otp_send_attempts) because every send costs
-- money; the verify leg had NONE, so a six-digit code could be guessed at the
-- global per-IP limiter's pace (100/min per IP, trivially spread) for as long
-- as it lived. This table is the missing bound. Same construction as
-- otp_send_attempts — an append-only log of ADMITTED attempts keyed by a
-- peppered HMAC of the phone, counted over rolling windows — kept as its own
-- table rather than a `kind` column on the send log so the proven send path
-- is untouched and each table's shape stays self-describing.
--
-- No cooldown, unlike the send leg: a user types the code straight after it
-- arrives, and a gap would only punish the happy path. A short window and a
-- day are what matter here — the window bounds guesses per code (5 in 10^6
-- at the defaults), the day bounds guesses across re-sends.
--
-- Not cleared on success on purpose. Clearing would be one more write on the
-- sign-in path for no security gain, and the defaults leave a legitimate user
-- who mistypes several times still well inside the budget.
--
-- Retention is the same daily prune (jobs/purge-otp-attempts.ts).
--
-- Rollback:
--   drop function public.otp_verify_admit(text, integer, integer, integer);
--   drop table public.otp_verify_attempts;  -- takes its policy and index with it

create table public.otp_verify_attempts (
  id         bigint generated always as identity primary key,
  -- HMAC-SHA256 of the phone number, hex. Same pepper and construction as
  -- otp_send_attempts.phone_hash (services/otp-rate-limit.ts); never a raw number.
  phone_hash text not null check (phone_hash ~ '^[0-9a-f]{64}$'),
  created_at timestamptz not null default now()
);

comment on table public.otp_verify_attempts is
  'Append-only log of admitted OTP verification attempts, keyed by a peppered HMAC of the phone number. Backs the per-phone brute-force bound on POST /v1/auth/otp/verify. Never stores a phone number.';

comment on column public.otp_verify_attempts.phone_hash is
  'HMAC-SHA256(pepper, phone) as hex. Peppered, not a bare digest: an unkeyed hash of a 10-digit number is trivially reversible.';

create index otp_verify_attempts_phone_hash_created_at_idx
  on public.otp_verify_attempts (phone_hash, created_at desc);

alter table public.otp_verify_attempts enable row level security;

-- Auth-path infrastructure: no client access at all. The API reads and writes
-- via service_role, which bypasses RLS.
create policy "otp_verify_attempts_deny_all" on public.otp_verify_attempts
  for all using (false);

-- Explicit, not ambient (see otp_send_attempts for why). No UPDATE: rows are
-- append-only. DELETE only because the retention prune needs it.
grant select, insert, delete on public.otp_verify_attempts to service_role;

-- ---------------------------------------------------------------------------
-- otp_verify_admit — check both windows and record the attempt, atomically
-- ---------------------------------------------------------------------------
--
-- Serialised per number by a transaction-scoped advisory lock for the same
-- reason as otp_attempt_admit: a data-modifying CTE still evaluates under its
-- own snapshot, so two concurrent guesses would both read "under the limit"
-- and both be admitted. Here that is the whole attack — a burst of parallel
-- guesses is how a per-window cap gets multiplied by the concurrency factor —
-- so the lock is the control, not a nicety. Seeded differently from the send
-- lock so a send and a verify on the same number never contend.
--
-- ADMISSION, NOT FAILURE ACCOUNTING. The row is written when the attempt is
-- admitted, before GoTrue is asked. Counting only failures would leave the
-- check-then-verify gap open to exactly the parallel burst above. The cost is
-- that a correct code also consumes one unit of budget — which is fine, the
-- budget is sized for many.
--
-- A refused attempt is NOT recorded, so being limited cannot extend the
-- window that is limiting you.
create or replace function public.otp_verify_admit(
  p_phone_hash     text,
  p_window_seconds integer,
  p_max_window     integer,
  p_max_day        integer
)
returns table (allowed boolean, retry_after_seconds integer)
language plpgsql
set search_path = pg_catalog, public
as $$
begin
  perform pg_advisory_xact_lock(hashtextextended(p_phone_hash, 1));

  return query
  with w as (
    select
      count(*) filter (
        where created_at > now() - make_interval(secs => p_window_seconds)
      ) as win_ct,
      -- The enclosing where clause already bounds this to a day.
      count(*) as day_ct,
      min(created_at) filter (
        where created_at > now() - make_interval(secs => p_window_seconds)
      ) as win_first,
      min(created_at) as day_first
    from public.otp_verify_attempts
    where phone_hash = p_phone_hash
      and created_at > now() - interval '1 day'
  ),
  ins as (
    insert into public.otp_verify_attempts (phone_hash)
    select p_phone_hash
    from w
    where w.win_ct < p_max_window
      and w.day_ct < p_max_day
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
        -- Soonest a retry could succeed: when the LAST binding window clears,
        -- i.e. when its oldest counted attempt ages out. Floored at 1.
        greatest(
          1,
          ceil(
            extract(
              epoch from greatest(
                case
                  when w.win_ct >= p_max_window
                  then w.win_first + make_interval(secs => p_window_seconds) - now()
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

comment on function public.otp_verify_admit(text, integer, integer, integer) is
  'Decides whether an OTP verification attempt is within the per-phone budget and records it if so, serialised per number by a transaction-scoped advisory lock. Returns allowed plus a Retry-After hint. Refused attempts are not recorded.';

revoke execute on function public.otp_verify_admit(text, integer, integer, integer)
  from public, anon, authenticated;
grant execute on function public.otp_verify_admit(text, integer, integer, integer)
  to service_role;
