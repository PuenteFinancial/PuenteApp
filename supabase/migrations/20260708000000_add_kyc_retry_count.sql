-- Migration: add kyc_retry_count to public.users
-- Created: 20260708000000
--
-- kyc_retry_count: number of self-serve KYC retries the user has consumed
-- after a rejection. The 3-retry ceiling is enforced in the API, not here,
-- so an admin reset is just `set kyc_retry_count = 0`.
--
-- Rollback:
--   alter table public.users
--     drop column kyc_retry_count;

alter table public.users
  add column kyc_retry_count integer not null default 0
                             check (kyc_retry_count >= 0);
