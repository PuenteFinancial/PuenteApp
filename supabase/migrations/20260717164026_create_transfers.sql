-- Migration: transfers core (remittance MVP slice 4)
-- Created: 2026-07-17
-- Tables: transfers, transfer_transitions, disclosures, disputes, idempotency_keys
-- RPCs: create_transfer_from_quote, transition_transfer (the ONLY write paths
--       for transfer state — never a bare UPDATE; ledger batches post inside
--       the transition so state + transition log + ledger are all-or-nothing).
-- Note: the 30-min PENDING_PAYMENT reconciliation sweep is deferred to the
--       slice-5 worker. Safe: a stuck PENDING_PAYMENT row has no ledger
--       postings and no funds movement — a dead row, not lost money.
-- Rollback:
--   drop function public.transition_transfer(uuid, text, text, text, text, jsonb, text, jsonb, timestamptz, timestamptz, text);
--   drop function public.create_transfer_from_quote(uuid, uuid, text, text, jsonb);
--   alter table public.ledger_transactions drop constraint ledger_transactions_transfer_id_fkey;
--   drop table public.idempotency_keys; drop table public.disputes;
--   drop table public.disclosures; drop table public.transfer_transitions;
--   drop table public.transfers; drop function public.forbid_mutation();

create extension if not exists moddatetime schema extensions;

-- Generic append-only guard (ledger has its own ledger-specific twin).
create function public.forbid_mutation()
returns trigger
language plpgsql
as $$
begin
  raise exception 'append-only: % on % is not allowed', tg_op, tg_table_name;
end;
$$;

-- ── transfers ──────────────────────────────────────────────────────────────
-- The state-machine entity (docs/transfer-state-machine.md). Economic terms
-- are SNAPSHOTS copied from the quote at creation — immutable even if the
-- quote row changes; the disclosure is built from these exact numbers.

create table public.transfers (
  id                        uuid primary key default gen_random_uuid(),
  -- RESTRICT on purpose: a user with financial history is undeletable
  -- (deliberate divergence from quotes' cascade; retention policy TBD).
  user_id                   uuid not null references public.users(id),
  payout_destination_id     uuid not null references public.payout_destinations(id),
  quote_id                  uuid not null unique references public.quotes(id),  -- single-use backstop
  state                     text not null default 'PENDING_PAYMENT' check (state in (
                              'PENDING_PAYMENT','FUNDED','SUBMITTED','IN_FLIGHT','COMPLETED',
                              'PAYMENT_FAILED','CANCELED','PAYOUT_FAILED','REFUNDED',
                              'FUNDING_REVERSED','UNDER_REVIEW')),
  -- snapshotted terms (corridor fixed USD→MXN for MVP, same as quotes)
  send_amount_minor         bigint not null check (send_amount_minor > 0),
  send_currency             text not null check (send_currency = 'USD'),
  receive_amount_minor      bigint not null check (receive_amount_minor > 0),  -- display/Reg E, never ledgered
  receive_currency          text not null check (receive_currency = 'MXN'),
  fee_amount_minor          bigint not null check (fee_amount_minor >= 0),
  fee_currency              text not null check (fee_currency = 'USD'),
  fx_rate                   numeric(12,4) not null check (fx_rate > 0),
  fx_rate_at                timestamptz not null,
  provider_fee_amount_minor bigint not null default 0 check (provider_fee_amount_minor >= 0),
  -- lifecycle
  funding_source_type       text not null default 'ach' check (funding_source_type = 'ach'),
  funding_cleared           boolean not null default false,  -- recorded, not gated on (WAIT_FOR_CLEARING=false)
  disclosure_accepted_at    timestamptz,
  payment_at                timestamptz,                     -- starts the Reg E cancellation clock
  cancelable_until          timestamptz,                     -- payment_at + CANCEL_WINDOW_MINUTES
  idempotency_key           text not null unique,            -- the future Bridge-submission key (slice 5)
  provider_transfer_ref     text unique,                     -- Bridge transfer id (slice 5)
  funding_payment_ref       text,                            -- funding processor payment id
  completed_at              timestamptz,
  created_at                timestamptz not null default now(),
  updated_at                timestamptz not null default now()
);

-- Terms immutability: everything economic is frozen at creation; only the
-- lifecycle columns may change — and only through the RPCs below.
create function public.enforce_transfer_terms_frozen()
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

create trigger enforce_transfers_terms_frozen
  before update on public.transfers
  for each row execute procedure public.enforce_transfer_terms_frozen();

create trigger handle_transfers_updated_at
  before update on public.transfers
  for each row execute procedure extensions.moddatetime(updated_at);

alter table public.transfers enable row level security;

-- Owner reads own rows; ALL writes go through the service-role RPCs.
create policy "transfers_select_own" on public.transfers
  for select using (auth.uid() = user_id);

create index transfers_user_id_created_at_idx
  on public.transfers (user_id, created_at desc, id desc);

-- Pre-built for the slice-5 stale-PENDING_PAYMENT sweep.
create index transfers_pending_payment_created_at_idx
  on public.transfers (created_at) where state = 'PENDING_PAYMENT';

create index transfers_payout_destination_id_idx
  on public.transfers (payout_destination_id);

-- ── transfer_transitions ───────────────────────────────────────────────────
-- Append-only state log; one row per transition, from_state null on creation.

create table public.transfer_transitions (
  id          uuid primary key default gen_random_uuid(),
  transfer_id uuid not null references public.transfers(id),
  from_state  text check (from_state is null or from_state in (
                'PENDING_PAYMENT','FUNDED','SUBMITTED','IN_FLIGHT','COMPLETED',
                'PAYMENT_FAILED','CANCELED','PAYOUT_FAILED','REFUNDED',
                'FUNDING_REVERSED','UNDER_REVIEW')),
  to_state    text not null check (to_state in (
                'PENDING_PAYMENT','FUNDED','SUBMITTED','IN_FLIGHT','COMPLETED',
                'PAYMENT_FAILED','CANCELED','PAYOUT_FAILED','REFUNDED',
                'FUNDING_REVERSED','UNDER_REVIEW')),
  actor       text not null check (char_length(actor) between 1 and 100),  -- user | system | webhook:funding | webhook:bridge | ops:<id>
  reason      text,
  metadata    jsonb not null default '{}'::jsonb,
  created_at  timestamptz not null default now()
);

create trigger forbid_transfer_transitions_mutation
  before update or delete on public.transfer_transitions
  for each row execute procedure public.forbid_mutation();

alter table public.transfer_transitions enable row level security;
-- No policies on purpose: service-role only, invisible to clients.

create index transfer_transitions_transfer_id_created_at_idx
  on public.transfer_transitions (transfer_id, created_at);

-- ── disclosures ────────────────────────────────────────────────────────────
-- Reg E evidence, append-only. content JSONB carries the disclosed numbers
-- plus BOTH language renderings; locale records what was presented.

create table public.disclosures (
  id           uuid primary key default gen_random_uuid(),
  transfer_id  uuid not null references public.transfers(id),
  type         text not null check (type in ('prepayment', 'receipt')),
  locale       text not null check (locale in ('en', 'es')),
  content      jsonb not null,
  presented_at timestamptz not null default now(),
  created_at   timestamptz not null default now()
);

create trigger forbid_disclosures_mutation
  before update or delete on public.disclosures
  for each row execute procedure public.forbid_mutation();

alter table public.disclosures enable row level security;

create policy "disclosures_select_own" on public.disclosures
  for select using (
    exists (
      select 1 from public.transfers t
      where t.id = transfer_id and t.user_id = auth.uid()
    )
  );

create index disclosures_transfer_id_idx on public.disclosures (transfer_id);

-- ── disputes ───────────────────────────────────────────────────────────────
-- Table only in slice 4 (no routes/UI): Reg E error-resolution process is
-- pending counsel; ops handles by runbook. UNDER_REVIEW state pairs with this.

create table public.disputes (
  id          uuid primary key default gen_random_uuid(),
  transfer_id uuid not null references public.transfers(id),
  user_id     uuid not null references public.users(id),
  type        text not null check (type in ('non_delivery', 'wrong_amount', 'unauthorized', 'other')),
  description text,
  status      text not null default 'open' check (status in ('open', 'investigating', 'resolved')),
  resolution  text,
  opened_at   timestamptz not null default now(),
  resolved_at timestamptz,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

create trigger handle_disputes_updated_at
  before update on public.disputes
  for each row execute procedure extensions.moddatetime(updated_at);

alter table public.disputes enable row level security;

create policy "disputes_select_own" on public.disputes
  for select using (auth.uid() = user_id);

create index disputes_transfer_id_idx on public.disputes (transfer_id);

-- ── idempotency_keys ───────────────────────────────────────────────────────
-- Client-request idempotency for money-moving POSTs (distinct from the
-- Bridge-submission key on transfers and the ledger's posting key).

create table public.idempotency_keys (
  id              uuid primary key default gen_random_uuid(),
  key             text not null check (char_length(key) between 1 and 255),
  user_id         uuid not null references public.users(id) on delete cascade,
  endpoint        text not null check (char_length(endpoint) between 1 and 100),
  request_hash    text not null,
  response_status int,
  response_body   jsonb,
  created_at      timestamptz not null default now(),
  expires_at      timestamptz not null default now() + interval '24 hours',
  unique (user_id, endpoint, key)
);

alter table public.idempotency_keys enable row level security;
-- No policies on purpose: service-role only.

-- For the slice-5 purge job.
create index idempotency_keys_expires_at_idx on public.idempotency_keys (expires_at);

-- ── deferred FK from slice 1 ───────────────────────────────────────────────

alter table public.ledger_transactions
  add constraint ledger_transactions_transfer_id_fkey
  foreign key (transfer_id) references public.transfers(id);

-- ── create_transfer_from_quote ─────────────────────────────────────────────
-- Atomic: consume the quote, insert the transfer (terms snapshotted), the
-- creation transition, and the prepayment disclosure. Any failure rolls back
-- everything including the quote consumption, so a retry finds a clean quote.
-- Raise messages are stable strings the service maps to HTTP codes.

create function public.create_transfer_from_quote(
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
     fee_amount_minor, fee_currency, fx_rate, fx_rate_at, idempotency_key)
  values
    (p_user_id, v_quote.payout_destination_id, v_quote.id,
     v_quote.send_amount_minor, v_quote.send_currency,
     v_quote.receive_amount_minor, v_quote.receive_currency,
     v_quote.fee_amount_minor, v_quote.fee_currency,
     v_quote.fx_rate, v_quote.fx_rate_at, p_transfer_idempotency_key)
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

-- ── transition_transfer ────────────────────────────────────────────────────
-- THE single transition function: guarded state update + transition append +
-- optional ledger batch, all in one transaction. A replay (state already at
-- p_to_state) is a no-op returning the row — no second transition, no second
-- ledger posting (the partial UNIQUE(transfer_id, transition) backs this up).

create function public.transition_transfer(
  p_transfer_id         uuid,
  p_from_state          text,
  p_to_state            text,
  p_actor               text,
  p_reason              text default null,
  p_metadata            jsonb default '{}'::jsonb,
  p_ledger_description  text default null,
  p_ledger_entries      jsonb default null,
  p_payment_at          timestamptz default null,
  p_cancelable_until    timestamptz default null,
  p_funding_payment_ref text default null
) returns public.transfers
language plpgsql
set search_path = public
as $$
declare
  v_transfer public.transfers;
  v_current  text;
begin
  update public.transfers
     set state               = p_to_state,
         payment_at          = coalesce(p_payment_at, payment_at),
         cancelable_until    = coalesce(p_cancelable_until, cancelable_until),
         funding_payment_ref = coalesce(p_funding_payment_ref, funding_payment_ref),
         completed_at        = case when p_to_state = 'COMPLETED' then now() else completed_at end
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

-- ── grants ─────────────────────────────────────────────────────────────────
-- Both RPCs are service-role only (slice-1 lesson: every function in the call
-- chain needs the grant; post_ledger_transaction already has it).

revoke execute on function public.create_transfer_from_quote(uuid, uuid, text, text, jsonb)
  from public, anon, authenticated;
revoke execute on function public.transition_transfer(uuid, text, text, text, text, jsonb, text, jsonb, timestamptz, timestamptz, text)
  from public, anon, authenticated;

grant execute on function public.create_transfer_from_quote(uuid, uuid, text, text, jsonb)
  to service_role;
grant execute on function public.transition_transfer(uuid, text, text, text, text, jsonb, text, jsonb, timestamptz, timestamptz, text)
  to service_role;
