-- Migration: add Bridge KYC fields to public.users
-- Created: 20260707000000
--
-- bridge_customer_id: Bridge (bridge.xyz) customer UUID — identifier only, not PII
-- kyc_status: our KYC state machine, driven by Bridge webhooks
-- email_verified_at: set when Supabase email verification completes
--
-- Rollback:
--   alter table public.users
--     drop column bridge_customer_id,
--     drop column kyc_status,
--     drop column email_verified_at;

alter table public.users
  add column bridge_customer_id text unique,
  add column kyc_status         text not null default 'not_started'
                                check (kyc_status in ('not_started', 'pending', 'approved', 'rejected', 'manual_review')),
  add column email_verified_at  timestamptz;

-- Webhook handler looks users up by bridge_customer_id; the unique
-- constraint above already creates the index that serves that query.
