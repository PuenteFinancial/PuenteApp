-- Migration: deposit_instructions (#199 — store the out-of-band deposit details)
-- Created: 2026-08-18
-- Rollback: drop table public.deposit_instructions;

-- Where the sender's money must go, per transfer, under FUNDING_PROCESSOR=manual.
-- The instructions live on a Bridge onramp transfer created out of band; until
-- now they reached the sender by text message and the pay step could only say
-- "the instructions our team shared with you" (#195). This table makes them a
-- first-class fact the app can render.
--
-- These are PUENTE'S receiving bank coordinates at Bridge (bank name, routing,
-- account, reference code) — payment-routing data for our own account, not
-- sender PII, so plaintext columns are appropriate. The reference code
-- (deposit_message) is the load-bearing field: Bridge matches the incoming
-- deposit to the onramp transfer by it, so rendering it verbatim is what makes
-- in-app instructions safer than hand-typed messages.
--
-- One row per transfer (unique FK). Attached and re-attachable by the ops
-- action only — re-attach OVERWRITES via upsert, because the operator recreating
-- the Bridge onramp (e.g. the first one expired or was canceled) must be able to
-- swap in the new coordinates. History of prior attachments is the audit log's
-- job, not this table's.

create extension if not exists moddatetime schema extensions;

create table public.deposit_instructions (
  id                  uuid primary key default gen_random_uuid(),
  -- One set of instructions per transfer. No cascade: transfers are undeletable
  -- (RESTRICT on users), and instructions should never outlive their transfer.
  transfer_id         uuid not null unique references public.transfers(id),
  -- The Bridge onramp transfer these instructions came from — the audit tie
  -- back to the object at Bridge, and the same id the funding assertion later
  -- names as its external ref.
  bridge_transfer_ref text not null check (char_length(bridge_transfer_ref) between 1 and 100),
  currency            text not null check (currency = 'USD'),
  -- Expected deposit amount in minor units — denormalized from the transfer so
  -- the rendering never does arithmetic (Money convention: integer minor).
  amount_minor        bigint not null check (amount_minor > 0),
  payment_rail        text not null check (payment_rail in ('ach', 'wire', 'fednow')),
  bank_name           text not null check (char_length(bank_name) between 1 and 200),
  bank_routing_number text not null check (bank_routing_number ~ '^[0-9]{9}$'),
  bank_account_number text not null check (char_length(bank_account_number) between 1 and 34),
  -- Bridge's beneficiary fields — who the account belongs to on paper.
  bank_beneficiary_name text check (char_length(bank_beneficiary_name) between 1 and 200),
  -- The reference code Bridge matches the deposit by. Rendering this verbatim
  -- is the whole point of the table.
  deposit_message     text not null check (char_length(deposit_message) between 1 and 200),
  -- Operator provenance: who attached these (scripts write no audit-plugin
  -- rows, so this column is the durable record on the break-glass path).
  attached_by         uuid not null,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now()
);

alter table public.deposit_instructions enable row level security;

-- Owner READS their transfer's instructions (the pay step renders them);
-- ALL writes go through the service role (ops route / script). No
-- insert/update/delete policies on purpose.
create policy "deposit_instructions_select_own" on public.deposit_instructions
  for select using (
    exists (
      select 1 from public.transfers t
      where t.id = transfer_id and t.user_id = auth.uid()
    )
  );

create trigger handle_deposit_instructions_updated_at
  before update on public.deposit_instructions
  for each row execute procedure extensions.moddatetime(updated_at);

-- The unique constraint on transfer_id doubles as the FK index; no extra
-- index needed for the one lookup pattern (by transfer).
