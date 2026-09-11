-- Migration: sender_notices — the customer-facing notices the system owes a sender
-- Created: 20260910200000
-- Rollback: drop table public.sender_notices;
--
-- Why a table. The loss path freezes a sender automatically (users.status = 'suspended'), and
-- until now that freeze was SILENT: the sender learned about it the next time they tried to act,
-- as an error string. Compliance review 2026-09-10 classified proactive notice as strongly
-- advisable on a UDAAP-unfairness basis (substantial injury the consumer cannot reasonably avoid,
-- for a population that may lack alternative remittance options). "We told them" has to be
-- provable, in the language they chose, with the words we actually used.
--
-- Why it is not just a log line: the copy changes over time, so "what did we tell this person on
-- 2026-09-10" is only answerable if the rendered text is stored WITH the row.
--
-- NO AUTOMATED CHANNEL EXISTS TODAY, and that is why `channel` and `status` are here rather than
-- implied. The API cannot send SMS (config/env.ts: no TWILIO_* vars; GoTrue holds the credentials
-- and sends OTP only, and the approved A2P campaign is registered for that one verbatim template,
-- so a freeze notice would be unregistered traffic). No email provider is wired at all, and
-- account-lifecycle.md defers email infra deliberately so it is built once. So the only channel
-- is 'manual': the notice is rendered, stored, and paged to an operator who delivers it. When an
-- email channel lands it inserts with channel 'email' and status 'sent' or 'failed' — one adapter,
-- no migration.
--
-- APPEND-ONLY, like consents / kyc_verifications / ops_actions. `status` is the outcome of the
-- dispatch attempt AT THE MOMENT THE NOTICE WAS GENERATED, not a mutable delivery tracker; a
-- manual delivery afterwards is recorded in the freeze's ops trail, not by editing this row.
--
-- NO PII. `subject`/`body` are fixed copy per (kind, language) with nothing interpolated: no name,
-- no amount, no dispute detail. That is a compliance requirement in its own right (a notice must
-- not hand a fraudulent actor the specifics of the dispute) and it is what makes storing the
-- rendered text safe.
--
-- Retention: append-only, RESTRICT on both foreign keys, nothing ages rows out — so this meets any
-- retention floor by default, same posture as ops_actions.

create table public.sender_notices (
  id          uuid primary key default gen_random_uuid(),
  -- RESTRICT, not CASCADE: the record that we notified someone must survive their row.
  user_id     uuid not null references public.users(id) on delete restrict,
  -- The transfer whose clawback triggered the notice. Null leaves room for a
  -- future account-level notice with no transfer behind it.
  transfer_id uuid references public.transfers(id) on delete restrict,
  kind        text not null check (kind in ('account_frozen')),
  language    text not null check (language in ('en', 'es')),
  channel     text not null check (channel in ('manual')),
  status      text not null check (status in ('pending', 'sent', 'failed')),
  subject     text not null check (char_length(subject) between 1 and 200),
  body        text not null check (char_length(body) between 1 and 2000),
  created_at  timestamptz not null default now()
);

-- The read patterns: this sender's notice history, and "what is owed right now".
create index sender_notices_user_created_idx
  on public.sender_notices (user_id, created_at desc);
create index sender_notices_transfer_idx
  on public.sender_notices (transfer_id);
create index sender_notices_created_idx
  on public.sender_notices (created_at desc);

-- Append-only, same guard as consents / kyc_verifications / ops_actions.
create trigger forbid_sender_notices_mutation
  before update or delete on public.sender_notices
  for each row execute procedure public.forbid_mutation();

alter table public.sender_notices enable row level security;

-- Service-role only. The web tier has no direct Supabase access (every read goes through the
-- API), so there is no client role that needs a policy — and a notice a sender could read
-- directly is a surface nobody has designed yet.
create policy "sender_notices_deny_all" on public.sender_notices
  for all using (false);

-- EXPLICIT, because the default is not reliable and the failure is SILENT.
-- Every other table here inherited its grants from `alter default privileges`, which depends on
-- WHICH ROLE ran the migration. Applying this file with `supabase migration up --local` produced a
-- table with no privileges for service_role at all, and the API's first insert came back 42501 —
-- caught only by driving the real service against the local stack (2026-09-10). A missing notice
-- pages and is otherwise invisible, so this path must not depend on how the migration was applied.
--
-- service_role ONLY, and only what the code uses. anon and authenticated are deliberately absent:
-- elsewhere they hold table grants and are stopped by the deny-all policy above, which is a second
-- line of defence; here they have neither. UPDATE and DELETE are absent because the table is
-- append-only, so granting them would only offer the trigger something to refuse.
grant select, insert on public.sender_notices to service_role;
