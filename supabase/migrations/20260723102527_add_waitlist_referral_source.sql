-- Migration: add referral_source fields to waitlist
-- Created: 20260723102527
--
-- referral_source: how the signup heard about Puente (fixed dropdown options,
--   enforced in the app layer, not a DB check constraint)
-- referral_source_other: free-text detail, populated only when
--   referral_source = 'Other'
--
-- Both nullable — the new 4-question waitlist form makes this required at the
-- app/API layer only, so historical rows (and any other future writer) are
-- never blocked by a DB-level constraint.
--
-- Rollback:
--   alter table waitlist
--     drop column referral_source,
--     drop column referral_source_other;

alter table waitlist
  add column referral_source       text,
  add column referral_source_other text;
