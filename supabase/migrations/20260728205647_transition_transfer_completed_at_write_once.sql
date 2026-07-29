-- Migration: transition_transfer v3 — completed_at becomes write-once
-- Created: 2026-07-28 (slice 7, PR 6b — code-review blocker)
-- Replaces: public.transition_transfer(uuid, text, text, text, text, jsonb,
--           text, jsonb, timestamptz, timestamptz, text, text)  [same signature,
--           so CREATE OR REPLACE; ACLs persist, restated anyway]
-- Rollback: re-run the v2 body from 20260720165458_payment_events_and_payout.sql
--
-- One changed line. v2 stamped `completed_at = now()` on EVERY transition whose
-- target is COMPLETED. That was written when the only route into COMPLETED was
-- the forward payout path (IN_FLIGHT → COMPLETED, replays short-circuit before
-- the UPDATE), so the stamp could only ever be the first delivery moment.
--
-- PR6b makes a ROUND TRIP reachable: a timely pre-deposit cancellation routes
-- COMPLETED → UNDER_REVIEW, and a lawful denial returns UNDER_REVIEW →
-- COMPLETED. Under v2 that return trip silently rewrote completed_at to the
-- denial moment — falsifying the delivery date the Reg E receipt renders
-- ("Completed on {date}", apps/web ReceiptView reads live completedAt), with no
-- record of the original value anywhere (transfer_transitions carries states,
-- not this column).
--
-- completed_at now records the FIRST delivery only, same coalesce idiom as
-- payment_at / cancelable_until above it and cancellation_requested_at in
-- record_cancellation_request. No legitimate path re-completes a transfer:
-- delivery is once, and the correction flow never re-delivers.

create or replace function public.transition_transfer(
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
         -- write-once: the first delivery moment is the delivery moment
         completed_at          = case when p_to_state = 'COMPLETED' then coalesce(completed_at, now()) else completed_at end
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

-- CREATE OR REPLACE preserves existing ACLs; restated for auditability
-- (slice-1 lesson: every function in the call chain needs the grant).

revoke execute on function public.transition_transfer(uuid, text, text, text, text, jsonb, text, jsonb, timestamptz, timestamptz, text, text)
  from public, anon, authenticated;

grant execute on function public.transition_transfer(uuid, text, text, text, text, jsonb, text, jsonb, timestamptz, timestamptz, text, text)
  to service_role;
