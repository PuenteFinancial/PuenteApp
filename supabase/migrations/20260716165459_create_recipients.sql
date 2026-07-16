-- Migration: recipients + payout_destinations (remittance MVP slice 2)
-- Created: 2026-07-16
-- Rollback: drop table public.payout_destinations; drop table public.recipients;

create extension if not exists moddatetime schema extensions;

-- ── recipients ─────────────────────────────────────────────────────────────
-- A sender's saved recipients ("Mom in Guadalajara"). Names are structured
-- (first/last, matching public.users), never a single full_name: Bridge and
-- SPEI need first/last verbatim and Mexican double surnames make any
-- split-heuristic wrong. Archive, never hard-delete.

create table public.recipients (
  id           uuid primary key default gen_random_uuid(),
  user_id      uuid not null references public.users(id) on delete cascade,
  first_name   text not null check (char_length(first_name) between 1 and 100),   -- recipient PII
  last_name    text not null check (char_length(last_name) between 1 and 100),    -- both surnames, verbatim
  relationship text not null check (char_length(relationship) between 1 and 100),
  country      text not null check (country ~ '^[A-Z]{2}$'),  -- ISO-3166 alpha-2
  status       text not null default 'active' check (status in ('active', 'archived')),
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);

alter table public.recipients enable row level security;

-- Owner reads own rows; ALL writes go through the API service role (which
-- bypasses RLS). No insert/update/delete policies on purpose.
create policy "recipients_select_own" on public.recipients
  for select using (auth.uid() = user_id);

create trigger handle_recipients_updated_at
  before update on public.recipients
  for each row execute procedure extensions.moddatetime(updated_at);

-- Serves both the owner-scoped list and keyset pagination
-- (order by created_at desc, id desc).
create index recipients_user_id_created_at_idx
  on public.recipients (user_id, created_at desc, id desc);

-- ── payout_destinations ────────────────────────────────────────────────────
-- One recipient → many ways to pay them. MVP supports (MX, bank_account)
-- via CLABE only; the method enum is the multi-corridor hook.

create table public.payout_destinations (
  id                   uuid primary key default gen_random_uuid(),
  recipient_id         uuid not null references public.recipients(id) on delete cascade,
  method               text not null check (method in ('bank_account', 'wallet', 'cash_pickup', 'debit_card')),
  currency             text not null check (currency ~ '^[A-Z]{3}$'),  -- display metadata, never ledgered
  details              jsonb not null,
  label                text check (label is null or char_length(label) between 1 and 100),
  status               text not null default 'active' check (status in ('active', 'archived')),
  provider_account_ref text unique,  -- Bridge external account id; UNIQUE allows multiple NULLs
  verification_status  text not null default 'unverified'
                         check (verification_status in ('unverified', 'verified', 'failed')),
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now()
);

comment on column public.payout_destinations.details is
  'JSONB, sensitive fields app-layer encrypted (AES-256-GCM, AAD = recipient_id). MX bank_account
   shape: { clabe_ciphertext: "v1.<iv>.<ct>.<tag>", clabe_last4: "1234" }. The full CLABE is never
   stored in plaintext and never returned by any endpoint.';

comment on column public.payout_destinations.verification_status is
  'Dormant at unverified: a Bridge 201 means REGISTERED, not verified — no real
   Verification-of-Payee exists for MXN CLABE. The slice-5 payout gate reads
   provider_account_ref IS NOT NULL AND status = ''active'', not this column.
   verified/failed are reserved for a future VoP signal.';

alter table public.payout_destinations enable row level security;

-- Owner-scoped via the parent recipient; writes are service-role only.
create policy "payout_destinations_select_own" on public.payout_destinations
  for select using (
    exists (
      select 1 from public.recipients r
      where r.id = recipient_id and r.user_id = auth.uid()
    )
  );

create trigger handle_payout_destinations_updated_at
  before update on public.payout_destinations
  for each row execute procedure extensions.moddatetime(updated_at);

create index payout_destinations_recipient_id_idx
  on public.payout_destinations (recipient_id);
