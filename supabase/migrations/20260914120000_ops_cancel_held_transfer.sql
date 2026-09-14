-- Migration: ops_cancel_held_transfer RPC — the sanctioned exit for a FUNDED
--            transfer whose payout can never leave
-- Created: 20260914120000
-- Alters: nothing. One new function; no column, constraint or index changes.
-- Rollback:
--   drop function public.ops_cancel_held_transfer(uuid, text, text, text, text, jsonb);
--
-- THE CORNER THIS CLOSES (staging cleanup 2026-09-14). A transfer is FUNDED and
-- parked on a `payability` hold whose cause can never resolve — a Bridge sandbox
-- destination with no SPEI endorsement, say. The money is collected, the payout
-- cannot leave, and NOTHING in the system can end it:
--
--   * POST /v1/ops/transfers/hold-release re-holds on the very next preflight —
--     payout-submit re-runs checkPayability and parks the row again;
--   * POST /v1/ops/transfers/refund wraps refundPayoutFailure, which refuses
--     anything that is not PAYOUT_FAILED;
--   * cancel_transfer (the SENDER's cancel) refuses on the Reg E window, which
--     closed 30 minutes after payment;
--   * scripts/reap-sandbox-transfers.ts only takes SUBMITTED / IN_FLIGHT;
--   * scripts/resolve-cancellation.ts only takes delivered UNDER_REVIEW rows.
--
-- So the row sat, the sender's money sat with it, and the only "exit" was a bare
-- UPDATE in the SQL editor — which moves the state without posting a ledger
-- batch and without returning a cent.
--
-- WHY A NEW FUNCTION rather than transition_transfer or cancel_transfer:
--
--   transition_transfer guards only `state = p_from_state`. The slice-6 contract
--   (docs/transfer-state-machine.md, "Contract for slice 6 — binding") requires
--   any FUNDED → CANCELED write to ALSO be guarded on `submit_attempted_at IS
--   NULL` in the same statement, because the submit job sets that column while
--   the state is still FUNDED. Without it a cancel can commit mid-Bridge-POST
--   and we pay a recipient for a transfer we just refunded.
--
--   cancel_transfer has that guard but also checks `now() <= cancelable_until`.
--   That window is the SENDER's statutory right under §1005.34 and it is right
--   that it expires. This is not that act: nobody is exercising a cancellation
--   right — we are admitting the payout is undeliverable and returning the
--   money. Widening cancel_transfer to serve both would have deleted the Reg E
--   check from the sender's path, which is the one place it must stay.
--
-- WHAT IS DIFFERENT HERE, and why each guard exists:
--
--   payout_hold_reason = p_hold_reason   THE MANDATE. This function can only
--     touch a row an operator is already holding, for exactly the reason they
--     confirmed (the same compare-and-swap the hold-release runbook uses). A
--     hold released, upgraded, or re-placed under another reason between the
--     operator's read and this call refuses rather than cancels. It also means
--     a live, healthy FUNDED transfer on its way to payout is unreachable from
--     here: no hold, no cancel.
--
--   submit_attempted_at IS NULL          the slice-6 race guard, verbatim.
--
--   provider_transfer_ref IS NULL        belt and braces on the same fact. If a
--     Bridge payout exists, cancelling is not ours to do — that row belongs to
--     the payout-failure tail (due_from_bridge is open and only bridge_return
--     closes it).
--
-- The hold is CLEARED by the same statement. A hold means "ops must look"
-- (services/payout-holds.ts); once the transfer is canceled nobody must, and a
-- canceled row still advertising a hold is a lie an operator would read under
-- time pressure. What it was is not lost: the reason goes into the transition's
-- metadata below and into the ops_actions row the caller writes.
--
-- The LEDGER BATCH is the caller's, not this function's, exactly as in
-- cancel_transfer and transition_transfer — and it is deliberately NOT the
-- sender-cancel reversal. See services/transfers.ts
-- (cancelRefundOwedLedgerEntries) and docs/ledger-rules.md, the CANCELED block
-- headed "ACH already in flight": a sender cancel happens inside 30 minutes, so
-- the pull is provably uncleared and reversing the FUNDED batch is correct;
-- these rows are days old with funding_cleared already posted, and that same
-- reversal would drive funding_receivable NEGATIVE while leaving the cash we
-- still hold unaccounted. Verified against both staging rows before writing
-- this.
--
-- Replay-safe: an already-CANCELED row returns as a no-op — no second
-- transition, no second posting (the partial UNIQUE(transfer_id, transition)
-- backs that up independently). Raise messages are the stable strings
-- services/transfers.ts maps to TransferRpcError codes; 'transfer_not_cancelable'
-- is reused rather than adding a code, because the caller re-reads and
-- classifies WHY for itself (services/ops-cancel.ts).

create function public.ops_cancel_held_transfer(
  p_transfer_id        uuid,
  p_actor              text,
  p_hold_reason        text,
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
  -- A null hold reason would make the compare-and-swap below vacuous in the
  -- wrong direction (`payout_hold_reason = null` is never true, so it would
  -- simply never match) — but refusing loudly beats a silent no-op that reads
  -- as "someone else got there first".
  if p_hold_reason is null then
    raise exception 'ops_cancel_held_transfer requires a hold reason';
  end if;

  update public.transfers
     set state              = 'CANCELED',
         payout_hold_reason = null,
         payout_held_at     = null
   where id = p_transfer_id
     and state = 'FUNDED'
     and submit_attempted_at is null
     and provider_transfer_ref is null
     and payout_hold_reason = p_hold_reason
  returning * into v_transfer;

  if not found then
    select state into v_current from public.transfers where id = p_transfer_id;
    if not found then
      raise exception 'transfer_not_found';
    elsif v_current = 'CANCELED' then
      -- Retry after a committed cancel: already there; nothing to append or post.
      select * into v_transfer from public.transfers where id = p_transfer_id;
      return v_transfer;
    else
      raise exception 'transfer_not_cancelable';
    end if;
  end if;

  -- The hold reason survives the clear above: this is the only durable record
  -- of WHY the payout could not leave, on the row that records the decision.
  insert into public.transfer_transitions (transfer_id, from_state, to_state, actor, reason, metadata)
  values (p_transfer_id, 'FUNDED', 'CANCELED', p_actor, p_reason,
          jsonb_build_object('payout_hold_reason', p_hold_reason));

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
revoke execute on function public.ops_cancel_held_transfer(uuid, text, text, text, text, jsonb)
  from public, anon, authenticated;

grant execute on function public.ops_cancel_held_transfer(uuid, text, text, text, text, jsonb)
  to service_role;
