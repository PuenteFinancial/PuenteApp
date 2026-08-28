-- Migration: stripe_link_tokens + users crypto columns (K3 — Link OAuth, KYC rehaul)
-- Created: 20260827150124
-- Rollback: drop table public.stripe_link_tokens;
--   alter table public.users drop column stripe_crypto_customer_id,
--     drop column stripe_kyc_tier, drop column stripe_kyc_tier_status;
--
-- Per-user Link OAuth state for the Stripe embedded-components onramp.
-- The refresh token is a live credential (90-day TTL, rotates on every use):
-- encrypted at the APPLICATION layer with AES-256-GCM before insert
-- (utils/encryption.ts, AAD = user_id so a ciphertext moved onto another row
-- fails authentication). Deliberate deviation from the plan's pgcrypto
-- sketch: app-side encryption keeps the key off the DB server entirely,
-- matching the payout_destinations CLABE precedent. Access tokens (1h TTL)
-- are never persisted anywhere — memory only.
--
-- auth_intent_id (lai_…) is stored for the WEB reuse rule: creating a fresh
-- LinkAuthIntent on every page load forces the user through OTP again (SA
-- doc), so a still-valid intent is reused. lai_expires_at mirrors the
-- intent's expires_at so reuse can check validity without a network call.

create table public.stripe_link_tokens (
  -- One Link identity per user; RESTRICT (not cascade) matches transfers:
  -- a row holding a live credential should never vanish as a side effect.
  user_id           uuid primary key references public.users(id),
  -- Nullable on purpose: a row exists from the first LinkAuthIntent (for the
  -- web reuse rule) but holds no credential until the user consents and the
  -- exchange stores one. NULL = "no token" — never an empty-string sentinel.
  refresh_token_enc text,
  auth_intent_id    text,
  lai_expires_at    timestamptz,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);

create trigger handle_stripe_link_tokens_updated_at
  before update on public.stripe_link_tokens
  for each row execute procedure extensions.moddatetime(updated_at);

alter table public.stripe_link_tokens enable row level security;

-- Deny-all: credentials never leave the API's service role. No policy at all
-- means anon/authenticated see nothing and can write nothing.

-- ── users: crypto customer + KYC tier cache ────────────────────────────────
-- stripe_crypto_customer_id (crc_…): learned from the SDK's authenticate
-- callback at first send (K5) — the client persists it via the API.
-- stripe_kyc_tier / stripe_kyc_tier_status: a CACHE of the customers poll
-- (GET /v1/crypto/customers/:id), refreshed on every read path that calls
-- Stripe. Deliberately unconstrained text: they mirror a private-preview
-- API whose enum can drift; a new Stripe status must not 500 our poll.
-- Stripe remains the source of truth — these exist for display and for
-- routing hints, never for authorization decisions.

alter table public.users
  add column stripe_crypto_customer_id text unique,
  add column stripe_kyc_tier           text,
  add column stripe_kyc_tier_status    text;
