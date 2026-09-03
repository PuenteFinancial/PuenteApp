-- Migration: kyc_verifications — append-only provider verdict log (K6; audit 2026-09-02 corner 2)
-- Created: 20260902234926
-- Rollback: drop table public.kyc_verifications;
--
-- Until now KYC was one text verdict per user (users.kyc_status, written only
-- by the Bridge customer webhook) plus a deliberately non-authoritative
-- Stripe tier cache (users.stripe_kyc_tier / _status). K6 is the moment two
-- providers verify the same sender — Stripe (L1/L2 in our UI) and Bridge (the
-- Customers API relay) — and a single mutable column cannot say WHO said
-- WHAT, WHEN, or FROM WHERE. This log can.
--
-- Shape follows the ERD's deferred kyc_records sketch: minimal result + the
-- provider reference, never documents, never identity numbers. `reasons`
-- holds provider reason codes/labels only (jsonb array; the API caps and
-- sanitizes it). `status` is OUR vocabulary; `provider_status` keeps the raw
-- word beside it because both upstream vocabularies are preview-grade and
-- drift. `provider` is unconstrained on purpose: a third verifier is a new
-- row value, not a migration (same reasoning as transfers.funding_processor).
--
-- Reversal: drop the table and the three best-effort insert sites. Nothing
-- reads it yet — users.kyc_status / stripe_kyc_tier* stay the derived
-- "current" caches, so no reader changes; a later slice can derive current
-- state from this log instead.

create table public.kyc_verifications (
  id              uuid primary key default gen_random_uuid(),
  -- RESTRICT: verification history for a user with financial history survives.
  user_id         uuid not null references public.users(id) on delete restrict,
  -- 'stripe_crypto' | 'bridge' today; deliberately no CHECK (see header).
  provider        text not null,
  -- crc_… for Stripe, the customer uuid for Bridge. Opaque, not PII.
  provider_ref    text,
  status          text not null check (status in ('pending', 'verified', 'rejected', 'review')),
  provider_status text,
  -- Stripe tier (L1/L2) or a Bridge endorsement name; free-form on purpose.
  tier            text,
  reasons         jsonb not null default '[]'::jsonb check (jsonb_typeof(reasons) = 'array'),
  -- 'relay' | 'webhook' | 'poll' — which path observed this verdict.
  source          text not null,
  occurred_at     timestamptz not null default now(),
  created_at      timestamptz not null default now()
);

-- The only read pattern: a user's history, newest first.
create index kyc_verifications_user_created_idx
  on public.kyc_verifications (user_id, created_at desc);

-- Append-only, same guard as consents/disclosures.
create trigger forbid_kyc_verifications_mutation
  before update or delete on public.kyc_verifications
  for each row execute procedure public.forbid_mutation();

alter table public.kyc_verifications enable row level security;

-- Service-role only: verification verdicts are the most sensitive non-document
-- KYC data we hold. No client role may read or write a row.
create policy "kyc_verifications_deny_all" on public.kyc_verifications
  for all using (false);
