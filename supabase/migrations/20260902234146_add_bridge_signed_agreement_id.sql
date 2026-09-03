-- Migration: users.bridge_signed_agreement_id (K6 — Bridge ToS pointer, KYC rehaul)
-- Created: 20260902234146
-- Rollback: alter table public.users drop column bridge_signed_agreement_id;
--
-- The Bridge ToS click-through returns a signed_agreement_id that the K6 relay
-- must present when it creates the Bridge customer. Acceptance itself is
-- evidenced by an append-only `consents` row (type bridge_tos) — but that row
-- is immutable, and a signed_agreement_id is single-use at Bridge: if a
-- customer create fails in a way that consumes it, the sender re-accepts and
-- gets a NEW id. This column is the mutable pointer to the latest one so a
-- re-acceptance can never be locked out by the first row's evidence.
--
-- Written by POST /v1/users/me/bridge-tos (latest wins), read by
-- POST /v1/users/me/bridge-customer, cleared in the same guarded update that
-- persists bridge_customer_id (the id is consumed at that point). Opaque
-- Bridge identifier, not PII. Nullable: null = no unconsumed acceptance.

alter table public.users add column bridge_signed_agreement_id text;

comment on column public.users.bridge_signed_agreement_id is
  'Latest Bridge ToS signed_agreement_id awaiting customer creation (K6). Cleared once bridge_customer_id is set. Evidence of acceptance lives in consents (type bridge_tos).';
