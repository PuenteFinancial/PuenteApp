-- Migration: deposit_instructions.attached_by → nullable (funding-ops slice 3)
-- Created: 2026-08-20
-- Rollback: alter table public.deposit_instructions alter column attached_by set not null;
--           (only after deleting/reattributing null rows — system-attached rows violate not null)

-- Slice 3 attaches deposit instructions automatically at confirm (the
-- funding.onramp_prepare job). The column's meaning stays "which human vouched
-- for these coordinates": null = attached by the system, a uuid = the operator
-- who ran the ops action or break-glass script. No default — the writer states
-- its provenance explicitly either way.
alter table public.deposit_instructions
  alter column attached_by drop not null;

comment on column public.deposit_instructions.attached_by is
  'Operator provenance: which human vouched for these coordinates. '
  'null = attached by the system at confirm (funding.onramp_prepare).';
