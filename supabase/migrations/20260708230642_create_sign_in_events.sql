-- Migration: create sign_in_events — durable per-sign-in record (risk substrate)
-- One row per successful OTP verify. No UI, no client access; queryable base
-- for later risk work (new-device flags, velocity checks, impossible travel).
-- Append-only immutable events: no updated_at column or trigger on purpose.
-- Rollback: drop table public.sign_in_events;

create table public.sign_in_events (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references public.users(id) on delete cascade,
  created_at  timestamptz not null default now(),
  ip          inet,
  user_agent  text,
  auth_method text not null default 'sms_otp'
);

alter table public.sign_in_events enable row level security;

-- No client access ever — the API writes via service_role, which bypasses
-- RLS. IP + UA must never reach the client.
create policy "sign_in_events_deny_all" on public.sign_in_events
  for all using (false);

create index on public.sign_in_events (user_id, created_at desc); -- per-user risk queries
create index on public.sign_in_events (created_at);               -- retention purge

comment on table public.sign_in_events is
  'One row per successful sign-in. Risk substrate; no UI. Retention: purge rows older than 13 months (manual until ops tooling exists — delete from sign_in_events where created_at < now() - interval ''13 months''). IP/UA live only here, never in client responses.';
