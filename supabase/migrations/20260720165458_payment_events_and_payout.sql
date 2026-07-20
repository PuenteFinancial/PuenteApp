-- Migration: payment_events + payout lifecycle (remittance MVP slice 5, PR 1)
-- Created: 2026-07-20
-- Table: payment_events — provider event inbox (webhook + poll), service-role only
-- Alters: transfers + payout hold/claim lifecycle columns; FUNDED sweep index
-- RPC: transition_transfer recreated (v2) with p_provider_transfer_ref appended
-- Rollback:
--   drop function public.transition_transfer(uuid, text, text, text, text, jsonb, text, jsonb, timestamptz, timestamptz, text, text);
--   -- then recreate the 11-arg v1 exactly as in 20260717164026_create_transfers.sql
--   -- (function body + revoke from public/anon/authenticated + grant to service_role)
--   drop index public.transfers_funded_created_at_idx;
--   alter table public.transfers
--     drop column payout_hold_reason,
--     drop column payout_held_at,
--     drop column submit_attempted_at;
--   drop table public.payment_events;

-- ── payment_events ─────────────────────────────────────────────────────────
-- Single inbox for provider transfer events regardless of arrival path:
-- 'bridge' (webhook), 'bridge_poll' (synthesized by the polling fallback,
-- external_event_id = '{bridgeTransferId}:{state}'), 'funding' (funding
-- processor). UNIQUE (source, external_event_id) is the dedupe line — the
-- ingest path inserts with ON CONFLICT DO NOTHING, so webhook redelivery and
-- poll re-synthesis collapse to one row and one processing attempt.
--
-- payload holds the RAW provider payload (service-role only, never logged by
-- the app — application logs carry only event id / event_type / transfer_id).
-- Retention/redaction policy deferred to a compliance pass; reversible via an
-- ingest change + redaction UPDATE.

create table public.payment_events (
  id                uuid primary key default gen_random_uuid(),
  source            text not null check (source in ('bridge', 'bridge_poll', 'funding')),
  external_event_id text not null,
  event_type        text not null,
  -- nullable: an event can arrive before we can resolve it to a transfer
  -- (unknown client_reference_id, out-of-order delivery); processing fills it
  transfer_id       uuid references public.transfers(id),
  provider_ref      text,             -- provider-side transfer id, when present
  payload           jsonb not null,   -- raw provider payload — see header note
  status            text not null default 'received'
                      check (status in ('received', 'processed', 'ignored', 'failed')),
  processed_at      timestamptz,
  error             text,
  -- received_at doubles as the creation stamp (no separate created_at)
  received_at       timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  unique (source, external_event_id)
);

-- status mutates (received → processed/ignored/failed), so updated_at moves
create trigger handle_payment_events_updated_at
  before update on public.payment_events
  for each row execute procedure extensions.moddatetime(updated_at);

alter table public.payment_events enable row level security;
-- No policies on purpose: service-role only (same pattern as
-- transfer_transitions) — raw provider payloads are invisible to clients.

-- The sweep re-enqueue scan: 'received' rows older than N minutes
create index payment_events_received_pending_idx
  on public.payment_events (received_at) where status = 'received';

create index payment_events_transfer_id_idx
  on public.payment_events (transfer_id);

-- ── transfers: payout hold + claim lifecycle ───────────────────────────────
-- Lifecycle columns, deliberately NOT added to enforce_transfer_terms_frozen:
-- they are mutated by service-role guarded UPDATEs (the submit job's claim,
-- hold placement, runbook release), same pattern as funding_cleared.
--
-- payout_hold_reason: set when the submit job refuses to submit — ops releases
-- via runbook SQL, the sweep then resubmits. 'float_ceiling' is deliberately
-- NOT a hold reason: a tripped float ceiling leaves the transfer FUNDED with
-- no hold, and the sweep retries as the aggregate balance drains (self-healing
-- backpressure — plan decision 4).
--
-- submit_attempted_at: the atomic claim. Set once by the winning guarded
-- UPDATE (... where state = 'FUNDED' and payout_hold_reason is null and
-- submit_attempted_at is null); non-null means a Bridge submission may exist,
-- so crash recovery re-POSTs idempotently instead of re-running the guards.

alter table public.transfers
  add column payout_hold_reason  text
               check (payout_hold_reason in ('fx_drift', 'payability', 'submit_error')),
  add column payout_held_at      timestamptz,
  add column submit_attempted_at timestamptz;

-- The payout sweep scan: FUNDED rows awaiting (re-)submission
create index transfers_funded_created_at_idx
  on public.transfers (created_at) where state = 'FUNDED';

-- ── transition_transfer v2 ─────────────────────────────────────────────────
-- THE single transition function: guarded state update + transition append +
-- optional ledger batch, all in one transaction. A replay (state already at
-- p_to_state) is a no-op returning the row — no second transition, no second
-- ledger posting (the partial UNIQUE(transfer_id, transition) backs this up).
--
-- v2 appends p_provider_transfer_ref so the FUNDED→SUBMITTED transition can
-- record the Bridge transfer id atomically with the state move (coalesce
-- pattern: null leaves any existing ref untouched, including on replay).
-- Postgres treats a changed signature as a new function, so v1 is dropped
-- explicitly and the grants are restated against the 12-arg list.

drop function public.transition_transfer(uuid, text, text, text, text, jsonb, text, jsonb, timestamptz, timestamptz, text);

create function public.transition_transfer(
  p_transfer_id           uuid,
  p_from_state            text,
  p_to_state              text,
  p_actor                 text,
  p_reason                text default null,
  p_metadata              jsonb default '{}'::jsonb,
  p_ledger_description    text default null,
  p_ledger_entries        jsonb default null,
  p_payment_at            timestamptz default null,
  p_cancelable_until      timestamptz default null,
  p_funding_payment_ref   text default null,
  p_provider_transfer_ref text default null
) returns public.transfers
language plpgsql
set search_path = public
as $$
declare
  v_transfer public.transfers;
  v_current  text;
begin
  update public.transfers
     set state                 = p_to_state,
         payment_at            = coalesce(p_payment_at, payment_at),
         cancelable_until      = coalesce(p_cancelable_until, cancelable_until),
         funding_payment_ref   = coalesce(p_funding_payment_ref, funding_payment_ref),
         provider_transfer_ref = coalesce(p_provider_transfer_ref, provider_transfer_ref),
         completed_at          = case when p_to_state = 'COMPLETED' then now() else completed_at end
   where id = p_transfer_id and state = p_from_state
  returning * into v_transfer;

  if not found then
    select state into v_current from public.transfers where id = p_transfer_id;
    if not found then
      raise exception 'transfer_not_found';
    elsif v_current = p_to_state then
      -- webhook replay: already there; nothing to append, nothing to post
      select * into v_transfer from public.transfers where id = p_transfer_id;
      return v_transfer;
    else
      raise exception 'transition_conflict';
    end if;
  end if;

  insert into public.transfer_transitions (transfer_id, from_state, to_state, actor, reason, metadata)
  values (p_transfer_id, p_from_state, p_to_state, p_actor, p_reason, p_metadata);

  if p_ledger_entries is not null then
    perform public.post_ledger_transaction(
      p_transfer_id::text || ':' || p_to_state,  -- matches ledger.ts key convention
      coalesce(p_ledger_description, 'transfer ' || p_to_state),
      p_ledger_entries,
      p_transfer_id,
      p_to_state);
  end if;

  return v_transfer;
end;
$$;

-- Service-role only (slice-1 lesson: every function in the call chain needs
-- the grant; post_ledger_transaction already has it).

revoke execute on function public.transition_transfer(uuid, text, text, text, text, jsonb, text, jsonb, timestamptz, timestamptz, text, text)
  from public, anon, authenticated;

grant execute on function public.transition_transfer(uuid, text, text, text, text, jsonb, text, jsonb, timestamptz, timestamptz, text, text)
  to service_role;
