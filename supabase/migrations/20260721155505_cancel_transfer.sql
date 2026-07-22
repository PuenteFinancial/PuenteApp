-- Migration: cancel_transfer RPC + refund columns (remittance MVP slice 6, PR 1)
-- Created: 2026-07-21
-- Alters: transfers — refund_payment_ref, refunded_at. Undo-path lifecycle
--         columns, deliberately NOT added to enforce_transfer_terms_frozen: they
--         are mutated by the cancel route's null-gated void step (a service-role
--         guarded UPDATE), same pattern as funding_cleared / submit_attempted_at.
--         One column holds the whole undo path — the void ref on the cancel path
--         (PR1) or the refund ref on payout-failure (PR2) — because a transfer
--         takes exactly one undo path. Null is the idempotency gate that stops a
--         retry from double-calling voidFunding()/refund().
-- RPC: cancel_transfer — the cancel side of the payout-vs-cancel race. One
--      transaction: guarded UPDATE (FUNDED + submit_attempted_at IS NULL + Reg E
--      window) → CANCELED → append transfer_transitions → post the FUNDED-batch
--      reversal keyed {id}:CANCELED. Grants to service_role only.
-- Rollback:
--   drop function public.cancel_transfer(uuid, text, text, text, jsonb);
--   alter table public.transfers drop column refunded_at, drop column refund_payment_ref;

alter table public.transfers
  add column refund_payment_ref text,   -- void ref (cancel) OR refund ref (payout-failure); one undo path per transfer
  add column refunded_at        timestamptz;

-- ── cancel_transfer ──────────────────────────────────────────────────────────
-- Mirrors transition_transfer, but the guarded UPDATE carries two extra
-- conditions that make it the cancel side of the race:
--   * submit_attempted_at IS NULL — THE race guard. The submit job sets
--     submit_attempted_at while state is still FUNDED (payout-submit.ts claim),
--     so a cancel guarded only on state = 'FUNDED' could win mid-Bridge-POST and
--     double-pay. Row locking serializes the two guarded UPDATEs: exactly one
--     matches a row, so a Bridge-payout-exists-but-CANCELED row is structurally
--     impossible. A claimed-but-not-yet-submitted row (submit_attempted_at set,
--     state still FUNDED after a submit crash) is therefore NOT cancelable — a
--     Bridge payout may already exist; the submit job's recovery re-POST owns it.
--   * cancelable_until window — the Reg E 30-min cancellation right, checked
--     customer-favorably (inclusive <=; a null window never blocks — defensive,
--     since the PENDING_PAYMENT → FUNDED transition always sets it).
-- Deliberately OMITS payout_hold_reason IS NULL: a held FUNDED transfer stays
-- cancelable, and the submit job skips held rows, so there is no contention.
-- Replay-safe: an already-CANCELED row returns as a no-op (no second transition,
-- no second ledger post — the partial UNIQUE(transfer_id, transition) also backs
-- the posting). NOT FOUND with any other current state → transfer_not_cancelable
-- (lost the race, window expired, or wrong state). Raise messages are the stable
-- strings services/transfers.ts maps to HTTP codes.

create function public.cancel_transfer(
  p_transfer_id        uuid,
  p_actor              text,
  p_reason             text default null,
  p_ledger_description text default null,
  p_ledger_entries     jsonb default null
) returns public.transfers
language plpgsql
set search_path = public
as $$
declare
  v_transfer public.transfers;
  v_current  text;
begin
  update public.transfers
     set state = 'CANCELED'
   where id = p_transfer_id
     and state = 'FUNDED'
     and submit_attempted_at is null
     and (cancelable_until is null or now() <= cancelable_until)
  returning * into v_transfer;

  if not found then
    select state into v_current from public.transfers where id = p_transfer_id;
    if not found then
      raise exception 'transfer_not_found';
    elsif v_current = 'CANCELED' then
      -- retry after a committed cancel: already there; nothing to append or post
      select * into v_transfer from public.transfers where id = p_transfer_id;
      return v_transfer;
    else
      raise exception 'transfer_not_cancelable';
    end if;
  end if;

  insert into public.transfer_transitions (transfer_id, from_state, to_state, actor, reason, metadata)
  values (p_transfer_id, 'FUNDED', 'CANCELED', p_actor, p_reason, '{}'::jsonb);

  if p_ledger_entries is not null then
    perform public.post_ledger_transaction(
      p_transfer_id::text || ':' || 'CANCELED',  -- matches ledger.ts key convention
      coalesce(p_ledger_description, 'transfer CANCELED'),
      p_ledger_entries,
      p_transfer_id,
      'CANCELED');
  end if;

  return v_transfer;
end;
$$;

-- Service-role only (slice-1 lesson: every function in the call chain needs the
-- grant; post_ledger_transaction already has it).
revoke execute on function public.cancel_transfer(uuid, text, text, text, jsonb)
  from public, anon, authenticated;

grant execute on function public.cancel_transfer(uuid, text, text, text, jsonb)
  to service_role;
