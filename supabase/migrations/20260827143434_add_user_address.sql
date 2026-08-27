-- Migration: add sender address columns to users (K2 — profile expansion, KYC rehaul)
-- Created: 20260827143434
-- Rollback: alter table public.users
--   drop column address_line1, drop column address_line2, drop column address_city,
--   drop column address_state, drop column address_postal_code, drop column address_country;
--
-- Onboarding becomes information + consents (2026-08-27 decision); the address
-- is the information half. Stored per the ratified PII custody posture:
-- address is operational-need/low-sensitivity and lives here in plaintext —
-- unlike DOB/SSN, which are never held or relayed. Never logged, never in URL
-- params (CLAUDE.md PII rules).
--
-- All columns nullable: existing rows predate the address step and the web
-- router bounces them to the profile form on their next visit (same rollout
-- pattern as K1's consent gate). Senders are US-only for the MVP, so country
-- is pinned by CHECK — widening it later is a deliberate one-line migration.
--
-- DB checks are the loose backstop (shape, not membership); the real US-state
-- list is enforced in the API against US_STATES in packages/shared.

alter table public.users
  add column address_line1       text,
  add column address_line2       text,
  add column address_city        text,
  add column address_state       text check (address_state is null or address_state ~ '^[A-Z]{2}$'),
  add column address_postal_code text check (address_postal_code is null or address_postal_code ~ '^[0-9]{5}(-[0-9]{4})?$'),
  add column address_country     text not null default 'US' check (address_country = 'US');
