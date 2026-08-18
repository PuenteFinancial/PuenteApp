-- Migration: margin_minor on quotes + transfers (#193 — merged FX rate)
-- Created: 2026-08-17
-- Rollback:
--   alter table public.quotes drop column margin_minor;
--   alter table public.transfers drop column margin_minor;
--   (then re-create enforce_quote_terms_frozen / enforce_transfer_terms_frozen /
--    create_transfer_from_quote from 20260717143435 / 20260717164026)
--
-- The margin is Puente's revenue on a transfer once the fee line is merged
-- into the displayed FX rate: quotes price send_amount_minor as the FULL
-- amount the customer pays, fee_amount_minor stays 0, and the ~1% take is
-- embedded in the customer rate. margin_minor records that take in USD minor
-- units so the FUNDED batch can still book it to fee_revenue — with a zero
-- fee and no margin column, the revenue line would silently vanish from the
-- books and the entire take would masquerade as fx_slippage (see #193).
--
-- default 0 backfills history correctly: pre-merge rows carried their revenue
-- in fee_amount_minor, so their margin genuinely was zero. Ledger builders
-- read revenue = fee + margin and principal = send − margin, which is exact
-- for both generations of rows.

-- ── columns ────────────────────────────────────────────────────────────────

alter table public.quotes
  add column margin_minor bigint not null default 0
    check (margin_minor >= 0);

-- transfer_payable books send − margin, and the ledger rejects non-positive
-- amounts — enforce margin < send where the terms are born (and snapshotted).
alter table public.quotes
  add constraint quotes_margin_lt_send check (margin_minor < send_amount_minor);

alter table public.transfers
  add column margin_minor bigint not null default 0
    check (margin_minor >= 0);

alter table public.transfers
  add constraint transfers_margin_lt_send check (margin_minor < send_amount_minor);

comment on column public.quotes.margin_minor is
  'Puente revenue embedded in the customer rate, USD minor units. Booked to
   fee_revenue at FUNDED. 0 on rows priced before the fee merged into the rate
   (their revenue lives in fee_amount_minor instead).';

comment on column public.transfers.margin_minor is
  'Snapshot of quotes.margin_minor at transfer creation — see that column.';

-- ── terms immutability: margin is an economic term, so it freezes ──────────

create or replace function public.enforce_quote_terms_frozen()
returns trigger
language plpgsql
as $$
begin
  if new.id                    is distinct from old.id
    or new.user_id               is distinct from old.user_id
    or new.payout_destination_id is distinct from old.payout_destination_id
    or new.send_amount_minor     is distinct from old.send_amount_minor
    or new.send_currency         is distinct from old.send_currency
    or new.receive_amount_minor  is distinct from old.receive_amount_minor
    or new.receive_currency      is distinct from old.receive_currency
    or new.fee_amount_minor      is distinct from old.fee_amount_minor
    or new.fee_currency          is distinct from old.fee_currency
    or new.margin_minor          is distinct from old.margin_minor
    or new.fx_rate               is distinct from old.fx_rate
    or new.source_rate           is distinct from old.source_rate
    or new.fx_rate_at            is distinct from old.fx_rate_at
    or new.provider_quote_ref    is distinct from old.provider_quote_ref
    or new.expires_at            is distinct from old.expires_at
    or new.created_at            is distinct from old.created_at
  then
    raise exception 'quote terms are immutable; only status may change';
  end if;
  return new;
end;
$$;

create or replace function public.enforce_transfer_terms_frozen()
returns trigger
language plpgsql
as $$
begin
  if new.id                        is distinct from old.id
    or new.user_id                   is distinct from old.user_id
    or new.payout_destination_id     is distinct from old.payout_destination_id
    or new.quote_id                  is distinct from old.quote_id
    or new.send_amount_minor         is distinct from old.send_amount_minor
    or new.send_currency             is distinct from old.send_currency
    or new.receive_amount_minor      is distinct from old.receive_amount_minor
    or new.receive_currency          is distinct from old.receive_currency
    or new.fee_amount_minor          is distinct from old.fee_amount_minor
    or new.fee_currency              is distinct from old.fee_currency
    or new.margin_minor              is distinct from old.margin_minor
    or new.fx_rate                   is distinct from old.fx_rate
    or new.fx_rate_at                is distinct from old.fx_rate_at
    or new.provider_fee_amount_minor is distinct from old.provider_fee_amount_minor
    or new.funding_source_type       is distinct from old.funding_source_type
    or new.idempotency_key           is distinct from old.idempotency_key
    or new.created_at                is distinct from old.created_at
  then
    raise exception 'transfer terms are immutable; only lifecycle columns may change';
  end if;
  return new;
end;
$$;

-- ── create_transfer_from_quote: snapshot the margin with the other terms ───
-- Body is 20260717164026's verbatim, plus margin_minor in the transfer insert.

create or replace function public.create_transfer_from_quote(
  p_quote_id                 uuid,
  p_user_id                  uuid,
  p_transfer_idempotency_key text,
  p_disclosure_locale        text,
  p_disclosure_content       jsonb
) returns jsonb
language plpgsql
set search_path = public
as $$
declare
  v_quote      public.quotes;
  v_transfer   public.transfers;
  v_disclosure public.disclosures;
begin
  -- conditional UPDATE is the row lock: the loser of a race sees 0 rows
  update public.quotes
     set status = 'consumed'
   where id = p_quote_id and user_id = p_user_id
     and status = 'active' and expires_at > now()
  returning * into v_quote;

  if not found then
    select * into v_quote from public.quotes
     where id = p_quote_id and user_id = p_user_id;
    if not found then
      raise exception 'quote_not_found';
    elsif v_quote.status = 'consumed' then
      raise exception 'quote_consumed';
    else
      -- lapsed (or already marked expired). NOTE: the row is deliberately NOT
      -- settled to 'expired' here — the raise aborts this transaction, so any
      -- such write would roll back with it. Derived-expiry on read (slice 3)
      -- and the slice-5 sweep own presentation/settling.
      raise exception 'quote_expired';
    end if;
  end if;

  insert into public.transfers
    (user_id, payout_destination_id, quote_id,
     send_amount_minor, send_currency, receive_amount_minor, receive_currency,
     fee_amount_minor, fee_currency, margin_minor, fx_rate, fx_rate_at, idempotency_key)
  values
    (p_user_id, v_quote.payout_destination_id, v_quote.id,
     v_quote.send_amount_minor, v_quote.send_currency,
     v_quote.receive_amount_minor, v_quote.receive_currency,
     v_quote.fee_amount_minor, v_quote.fee_currency,
     v_quote.margin_minor, v_quote.fx_rate, v_quote.fx_rate_at,
     p_transfer_idempotency_key)
  returning * into v_transfer;

  insert into public.transfer_transitions (transfer_id, from_state, to_state, actor, reason, metadata)
  values (v_transfer.id, null, 'PENDING_PAYMENT', 'user', 'created from quote',
          jsonb_build_object('quote_id', v_quote.id));

  insert into public.disclosures (transfer_id, type, locale, content)
  values (v_transfer.id, 'prepayment', p_disclosure_locale, p_disclosure_content)
  returning * into v_disclosure;

  return jsonb_build_object(
    'transfer', to_jsonb(v_transfer),
    'disclosure', to_jsonb(v_disclosure)
  );
end;
$$;

-- Grants: create or replace preserves existing ACLs, and the original
-- migration already revoked public/anon/authenticated and granted
-- service_role on this exact signature — nothing to re-state.
