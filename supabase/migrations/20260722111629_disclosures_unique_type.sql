-- Migration: disclosures (transfer_id, type) unique (remittance MVP slice 6, PR 3)
-- Created: 2026-07-22
-- Alters: disclosures — add UNIQUE (transfer_id, type). A transfer has at most one
--         disclosure of each type; this enables the idempotent receipt upsert
--         (ON CONFLICT (transfer_id, type) DO NOTHING) the payment-event.process
--         job uses when a transfer reaches COMPLETED.
-- Safe re: append-only — the forbid_disclosures_mutation trigger is BEFORE UPDATE
--         OR DELETE (create_transfers.sql), and ON CONFLICT DO NOTHING performs
--         neither on a duplicate (it skips the row), so a replayed receipt write
--         never trips the append-only guard.
-- Note: existing data has at most one 'prepayment' per transfer (inserted once by
--       create_transfer_from_quote) and no 'receipt' rows yet, so the constraint
--       adds cleanly with no backfill.
-- Rollback:
--   alter table public.disclosures drop constraint disclosures_transfer_type_key;

alter table public.disclosures
  add constraint disclosures_transfer_type_key unique (transfer_id, type);
