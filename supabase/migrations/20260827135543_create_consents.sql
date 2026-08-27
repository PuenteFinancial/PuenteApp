-- Migration: create consents (K1 — consent foundation, KYC rehaul plan 2026-08-27)
-- Created: 20260827135543
-- Rollback: drop table public.consents;
--
-- Append-only record of user assent to versioned legal documents. Replaces the
-- deferred 2026-07-13 ERD sketch (tos|privacy|esign|tcpa_sms with revoked_at):
-- types are namespaced to the K-lane set, and revocation is NOT an update —
-- the row is immutable evidence of what was agreed to and when. A future
-- withdrawal flow would append its own record, never touch this one.
--
-- `version` is the exact document version presented (the doc's "Last updated"
-- date, e.g. '2026-07-21'). Required versions live in code
-- (packages/shared/src/types/consent.ts); a counsel-reviewed doc bump (K7)
-- changes that constant, the router demands re-consent, and a new row lands
-- here — (user_id, type, version) unique makes re-consent to the SAME version
-- an idempotent no-op instead of duplicate evidence.
--
-- `evidence` carries e-consent context (ip, user_agent — no extra PII);
-- bridge_tos rows (written at first send, K4/K5) will carry
-- signed_agreement_id here. `locale` records which language was presented,
-- same as disclosures.
--
-- No updated_at / moddatetime on purpose: mutation is forbidden outright
-- (forbid_mutation trigger, shared with disclosures/transitions), so an
-- update timestamp is a contradiction in terms.

create table public.consents (
  id           uuid primary key default gen_random_uuid(),
  -- RESTRICT on purpose (matches transfers): consent evidence for a user with
  -- financial history must survive as long as the user row does.
  user_id      uuid not null references public.users(id),
  type         text not null check (type in ('esign', 'puente_tos', 'puente_privacy', 'bridge_tos')),
  version      text not null,
  locale       text not null check (locale in ('en', 'es')),
  evidence     jsonb not null default '{}'::jsonb,
  consented_at timestamptz not null default now(),
  created_at   timestamptz not null default now(),
  unique (user_id, type, version)
);

-- The unique constraint's index leads on user_id, so it also serves the
-- FK/user lookups — no separate user_id index needed.

create trigger forbid_consents_mutation
  before update or delete on public.consents
  for each row execute procedure public.forbid_mutation();

alter table public.consents enable row level security;

-- Owner reads own consent records (data-subject access); all writes go
-- through the API's service role — no client insert/update/delete policy.
create policy "consents_select_own" on public.consents
  for select using (auth.uid() = user_id);
