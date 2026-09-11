-- Migration: users.stripe_customer_id — the merchant-scoped Stripe Customer a sender's saved payment methods hang off
-- Created: 20260911180000
-- Rollback: alter table public.users drop column stripe_customer_id;

-- Saving a payment method for reuse requires a stable Stripe Customer. Until
-- now the Checkout rail passed `customer_email` only — a prefill, not an
-- identity — so every send started from an empty payment sheet and a returning
-- sender re-linked their bank through Financial Connections every single time.
-- That is the most painful thing we ask a repeat sender to redo, and ACH is the
-- rail whose economics we actually want them on.
--
-- MERCHANT-SCOPED on purpose. This is OUR customer record, not Link's global
-- network identity: methods saved here are visible to Puente and nobody else,
-- and enabling it does not drag Link's phone-number step back into the pay
-- step (the reason `wallets: { link: 'never' }` is set on the Payment Element).
--
-- UNIQUE because the mapping is one-to-one in both directions and a duplicate
-- would silently split one sender's saved methods across two Stripe Customers,
-- which presents as "my bank disappeared" and is invisible server-side.
--
-- Nullable with no default: a user has no Stripe Customer until their first
-- funding session, and most rows never will (waitlist). It is minted lazily and
-- then never changes.
--
-- NOT PII by itself (an opaque `cus_` handle), but it joins to a Stripe record
-- that holds the sender's email and payment instruments, so it is read
-- server-side only and never returned to a client.
alter table public.users
  add column stripe_customer_id text unique;
