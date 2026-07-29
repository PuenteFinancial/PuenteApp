-- Migration: cancellation_requests (remittance MVP slice 7, PR 6b)
-- Created: 2026-07-28
-- Table:  cancellation_requests — the sender's post-submission cancel ask
-- Alters: transfers — cancellation_requested_at (lifecycle column)
-- RPC:    record_cancellation_request
-- Seeds:  ledger account loss_cancellation_correction
-- Rollback:
--   revoke/drop function public.record_cancellation_request(uuid, uuid, text);
--   alter table public.transfers drop column cancellation_requested_at;
--   drop table public.cancellation_requests;
--   delete from public.ledger_accounts where code = 'loss_cancellation_correction';
--     (safe only while no entry references it — ledger rows are append-only)

create extension if not exists moddatetime schema extensions;

-- ── cancellation_requests ──────────────────────────────────────────────────
-- A cancel tapped at SUBMITTED / IN_FLIGHT (or FUNDED post-claim) cannot be
-- honoured on the spot: the payout is already with Bridge. Before this table
-- the API answered a bare 202 telling the sender to contact support and wrote
-- NOTHING — no evidence they asked, when they asked, or that a statutory clock
-- had started. This is that evidence.
--
-- It is NOT a disputes table. §1005.34 cancellation is not §1005.33 error
-- resolution (docs/transfer-state-machine.md, docs/decisions.md 2026-07-28);
-- the two have different clocks, different remedies and different lawful
-- denials. A disputes table, if it ever exists, is a separate thing.
--
-- The obligation is state-keyed: a TIMELY cancel at SUBMITTED/IN_FLIGHT owes a
-- full refund once the payout resolves. If the payout fails, the existing
-- refund tail already makes the sender whole. If it COMPLETES, we owe a refund
-- anyway — an accepted, bounded double-pay booked as a correction payment.

create table public.cancellation_requests (
  id              uuid primary key default gen_random_uuid(),
  transfer_id     uuid not null references public.transfers(id),
  user_id         uuid not null references public.users(id) on delete cascade,

  -- The statutory clock. Separate from created_at on purpose: created_at is a
  -- row-audit fact, this is the legally operative moment the sender asked.
  requested_at    timestamptz not null default now(),

  -- Which 202 branch produced it. FUNDED here means FUNDED-post-claim (the
  -- submit job set submit_attempted_at while state still read FUNDED), which
  -- is why FUNDED is admissible alongside the two submitted states.
  requested_state text not null check (requested_state in ('FUNDED','SUBMITTED','IN_FLIGHT')),

  -- Timeliness, evaluated ONCE against cancelable_until at record time and then
  -- frozen. The 202 fires on state alone and never consults the window, so a
  -- cancel tapped on a transfer stalled at IN_FLIGHT for days gets one too.
  -- Recording that without the timeliness fact would manufacture an automatic
  -- full-refund obligation the law does not require. Computed inside the RPC so
  -- it cannot drift from the row it was derived from.
  within_window   boolean not null,

  status          text not null default 'pending'
                    check (status in ('pending','resolved_refunded','resolved_denied')),

  -- Resolution is append-once in practice; the columns stay nullable because a
  -- pending request legitimately has none of them.
  resolution      text,
  resolved_at     timestamptz,
  resolved_by     text check (resolved_by is null or char_length(resolved_by) between 1 and 100),

  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),

  -- A pending request has no resolution moment; a resolved one always does.
  -- Application code cannot produce the bad row (the RPC insert sets none of
  -- the resolution fields; resolveCancellationRequest sets them atomically) —
  -- this guards the residual writer, the by-hand SQL the runbooks contemplate.
  constraint cancellation_requests_resolution_consistency
    check ((status = 'pending') = (resolved_at is null))
);

-- ONE open request per transfer. Partial so a resolved request never blocks a
-- later one, and so a second cancel tap (a fresh idempotency key, another tab)
-- resolves to the existing row instead of opening a duplicate clock.
create unique index cancellation_requests_one_pending_idx
  on public.cancellation_requests (transfer_id) where status = 'pending';

-- The ops scan: every unresolved ask, oldest first (the deadline is per-request).
create index cancellation_requests_pending_requested_at_idx
  on public.cancellation_requests (requested_at) where status = 'pending';

create index cancellation_requests_user_id_requested_at_idx
  on public.cancellation_requests (user_id, requested_at desc, id desc);

alter table public.cancellation_requests enable row level security;

-- Owner reads own rows via the transfers join (the disclosures_select_own
-- idiom); ALL writes go through the service role. No insert/update/delete
-- policies on purpose.
create policy "cancellation_requests_select_own" on public.cancellation_requests
  for select using (
    exists (
      select 1 from public.transfers t
      where t.id = transfer_id and t.user_id = auth.uid()
    )
  );

create trigger handle_cancellation_requests_updated_at
  before update on public.cancellation_requests
  for each row execute procedure extensions.moddatetime(updated_at);

-- ── transfers.cancellation_requested_at ────────────────────────────────────
-- Denormalized flag so the transfer read path (and the tracker banner) needs no
-- join. A LIFECYCLE column: deliberately NOT added to
-- enforce_transfer_terms_frozen, same as submit_attempted_at / refunded_at /
-- refund_claimed_at. It is a FLAG ORTHOGONAL TO STATE, not a state: the payout
-- keeps advancing while a request is pending.
alter table public.transfers
  add column cancellation_requested_at timestamptz;

-- ── record_cancellation_request ────────────────────────────────────────────
-- Inserts the request AND stamps transfers.cancellation_requested_at in one
-- transaction. An RPC rather than two PostgREST calls because the two must not
-- drift (a stamped transfer with no request, or the reverse, is unexplainable
-- to an auditor), PostgREST cannot span two tables, and every transfer write in
-- this codebase already goes through an RPC.
--
-- within_window is computed HERE, from the row being recorded, so timeliness is
-- evaluated atomically with the record rather than read separately by a caller
-- whose view may already be stale.
--
-- Idempotent: a second call while a request is pending returns the existing row
-- and writes nothing new (the partial unique index is the enforcement; the
-- explicit pre-check is what turns a would-be constraint violation into a
-- normal return). Safe under the 24h idempotency replay cache and under a
-- second cancel tap that mints a fresh key.
create function public.record_cancellation_request(
  p_transfer_id uuid,
  p_user_id     uuid,
  p_state       text
) returns public.cancellation_requests
language plpgsql
set search_path = public
as $$
declare
  v_request  public.cancellation_requests;
  v_transfer public.transfers;
begin
  select * into v_transfer
    from public.transfers
   where id = p_transfer_id and user_id = p_user_id
   for update;

  if not found then
    raise exception 'transfer_not_found';
  end if;

  -- Already open → return it. The clock started when they FIRST asked; a second
  -- tap must never restart it or open a competing deadline.
  select * into v_request
    from public.cancellation_requests
   where transfer_id = p_transfer_id and status = 'pending';

  if found then
    return v_request;
  end if;

  insert into public.cancellation_requests
    (transfer_id, user_id, requested_state, within_window)
  values
    (p_transfer_id, p_user_id, p_state,
     -- No cancelable_until recorded → treat as in-window. The column is set on
     -- every transfer at creation; a null would mean we never disclosed a
     -- deadline, and we must not deny a right we failed to bound.
     v_transfer.cancelable_until is null or now() <= v_transfer.cancelable_until)
  returning * into v_request;

  -- Stamp the transfer. coalesce keeps the FIRST ask's timestamp if a prior
  -- request was resolved and a new one opened — the column marks "has ever
  -- asked" for the read path; cancellation_requests holds the per-ask truth.
  update public.transfers
     set cancellation_requested_at = coalesce(cancellation_requested_at, v_request.requested_at)
   where id = p_transfer_id;

  return v_request;
end;
$$;

-- Service-role only (slice-1 lesson: every function in the call chain needs the
-- grant). The record path is reached from an authenticated route, but the route
-- runs as the service role and does its own owner-scoping.
revoke execute on function public.record_cancellation_request(uuid, uuid, text)
  from public, anon, authenticated;

grant execute on function public.record_cancellation_request(uuid, uuid, text)
  to service_role;

-- ── loss_cancellation_correction ───────────────────────────────────────────
-- The COMPLETED-tail correction payment books here, NOT to loss_funding_reversed.
-- The two are economically different and the ledger should be able to answer
-- "what did Reg E cost us" without a per-transfer join: loss_funding_reversed is
-- a credit/fraud loss (an ACH return after we delivered), while this is a
-- compliance cost (we honoured a timely cancellation on a transfer that had
-- already been delivered, knowingly paying twice). ledger-rules.md already
-- allowed for "a dedicated correction-expense account" — this is it.
insert into public.ledger_accounts (code, name, type, normal_balance) values
  ('loss_cancellation_correction',
   'Reg E cancellation corrections (post-delivery refunds)', 'expense', 'debit')
on conflict (code) do nothing;
