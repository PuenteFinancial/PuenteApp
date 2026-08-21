-- Migration: add transfers.payment_claimed_at (funding-ops slice 4 — sender payment claim)
-- Created: 20260821081652
-- Rollback: alter table public.transfers drop column payment_claimed_at;
--
-- Lifecycle column: when the sender tapped "I've sent the payment" on the pay
-- step. Set-once by the API (update ... where payment_claimed_at is null); a
-- claim is a signal to ops, never a state change. Mutable under
-- enforce_transfer_terms_frozen because that trigger denylists the frozen
-- terms columns — lifecycle columns are writable by default.
-- Unrelated to refund_claimed_at/refund_claimed_by, which are a worker lease.

alter table public.transfers
  add column payment_claimed_at timestamptz;
