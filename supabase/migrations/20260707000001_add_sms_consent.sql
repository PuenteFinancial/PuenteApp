-- Migration: add TCPA SMS consent timestamp to public.users
-- Created: 20260707000001
--
-- Recorded at OTP verification — the earliest moment the user row exists.
-- The consent itself is collected on the signup form (required checkbox)
-- before any SMS is sent; the API rejects OTP sends without smsConsent.
--
-- Rollback:
--   alter table public.users drop column sms_consent_at;

alter table public.users
  add column sms_consent_at timestamptz;
