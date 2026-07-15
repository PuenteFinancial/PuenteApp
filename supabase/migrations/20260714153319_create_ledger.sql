-- Migration: double-entry ledger core (remittance MVP slice 1)
-- Created: 20260714153319
--
-- Three tables per docs/erd.md + docs/ledger-rules.md:
--   ledger_accounts     — the chart of accounts (mutable reference data)
--   ledger_transactions — one row per financial event (append-only)
--   ledger_entries      — the debit/credit lines, 2+ per transaction (append-only)
--
-- Invariants enforced IN THE DATABASE (application code is the first line of
-- defense, these are the backstop that holds even for raw SQL):
--   * every transaction's entries net to zero per currency (deferred
--     constraint trigger, checked at COMMIT)
--   * every transaction has >= 2 entries
--   * posted rows are immutable — UPDATE/DELETE raise (append-only trigger;
--     REVOKE alone is not authoritative because local dev re-grants broadly
--     after `supabase db reset` — see docs/runbooks/local-dev.md)
--   * amounts are positive BIGINT minor units; direction carries the sign
--   * one posting per (transfer_id, transition) — partial unique index
--
-- post_ledger_transaction() is the only sanctioned write path: it inserts a
-- transaction + its entries atomically and is idempotent on idempotency_key
-- (a replay inserts nothing and returns the original row).
--
-- Rollback:
--   drop function public.post_ledger_transaction(text, text, jsonb, uuid, text);
--   drop function public.ledger_account_balance(text);
--   drop table public.ledger_entries;
--   drop table public.ledger_transactions;
--   drop table public.ledger_accounts;
--   drop function public.ledger_entries_check_balanced();
--   drop function public.ledger_transactions_check_balanced();
--   drop function public.ledger_assert_balanced(uuid);
--   drop function public.ledger_forbid_mutation();

create extension if not exists moddatetime schema extensions;

-- ---------------------------------------------------------------------------
-- ledger_accounts — chart of accounts (reference data; service-role only)
-- ---------------------------------------------------------------------------

create table public.ledger_accounts (
  id             uuid primary key default gen_random_uuid(),
  code           text not null unique,
  name           text not null,
  type           text not null check (type in ('asset', 'liability', 'revenue', 'expense')),
  normal_balance text not null check (normal_balance in ('debit', 'credit')),
  currency       char(3) not null default 'USD' check (currency ~ '^[A-Z]{3}$'),
  owner_scope    text not null default 'platform',
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);

comment on table public.ledger_accounts is
  'Chart of accounts (docs/ledger-rules.md). Company-level buckets; per-transfer attribution lives on ledger_transactions.transfer_id, never separate accounts.';

alter table public.ledger_accounts enable row level security;

create policy "ledger_accounts_deny_all" on public.ledger_accounts
  for all using (false);

create trigger handle_ledger_accounts_updated_at
  before update on public.ledger_accounts
  for each row execute procedure extensions.moddatetime(updated_at);

-- ---------------------------------------------------------------------------
-- ledger_transactions — one financial event (append-only, no updated_at)
-- ---------------------------------------------------------------------------

create table public.ledger_transactions (
  id              uuid primary key default gen_random_uuid(),
  -- nullable by design: batch events (wallet replenishment) have no transfer.
  -- No FK yet — the transfers table arrives in slice 4, which adds it.
  transfer_id     uuid,
  transition      text,
  idempotency_key text not null unique,
  description     text not null,
  posted_at       timestamptz not null default now(),
  created_at      timestamptz not null default now()
);

comment on table public.ledger_transactions is
  'Append-only posting batches. One per money-moving state transition, idempotent on idempotency_key (convention: {transfer_id}:{transition}).';

-- Belt-and-braces for the ledger-rules invariant, independent of the
-- idempotency-key convention: at most one posting per transfer transition.
create unique index ledger_transactions_transfer_transition_key
  on public.ledger_transactions (transfer_id, transition)
  where transfer_id is not null;

alter table public.ledger_transactions enable row level security;

create policy "ledger_transactions_deny_all" on public.ledger_transactions
  for all using (false);

-- ---------------------------------------------------------------------------
-- ledger_entries — the debit/credit lines (append-only, no updated_at)
-- ---------------------------------------------------------------------------

create table public.ledger_entries (
  id                    uuid primary key default gen_random_uuid(),
  -- no ON DELETE CASCADE: a delete path out of an append-only table is a bug
  ledger_transaction_id uuid not null references public.ledger_transactions(id),
  account_id            uuid not null references public.ledger_accounts(id),
  direction             text not null check (direction in ('debit', 'credit')),
  amount_minor          bigint not null check (amount_minor > 0),
  currency              char(3) not null check (currency ~ '^[A-Z]{3}$'),
  created_at            timestamptz not null default now()
);

create index ledger_entries_transaction_idx on public.ledger_entries (ledger_transaction_id);
create index ledger_entries_account_idx on public.ledger_entries (account_id);

-- full old-row images in logical replication / audit tooling
alter table public.ledger_entries replica identity full;

alter table public.ledger_entries enable row level security;

create policy "ledger_entries_deny_all" on public.ledger_entries
  for all using (false);

-- ---------------------------------------------------------------------------
-- append-only enforcement (authoritative control; REVOKE below is extra)
-- ---------------------------------------------------------------------------

create or replace function public.ledger_forbid_mutation()
returns trigger
language plpgsql
as $$
begin
  raise exception 'ledger is append-only: % on % is not allowed; post a correcting transaction instead',
    tg_op, tg_table_name;
end;
$$;

create trigger ledger_transactions_append_only
  before update or delete on public.ledger_transactions
  for each row execute function public.ledger_forbid_mutation();

create trigger ledger_entries_append_only
  before update or delete on public.ledger_entries
  for each row execute function public.ledger_forbid_mutation();

-- ---------------------------------------------------------------------------
-- net-zero + minimum-entries enforcement (deferred to COMMIT so the posting
-- function can insert the whole batch first; a raw unbalanced insert fails
-- at its statement's implicit commit)
-- ---------------------------------------------------------------------------

create or replace function public.ledger_assert_balanced(p_tx_id uuid)
returns void
language plpgsql
as $$
declare
  v_count    int;
  v_currency char(3);
  v_net      bigint;
begin
  select count(*) into v_count
    from public.ledger_entries
   where ledger_transaction_id = p_tx_id;

  if v_count < 2 then
    raise exception 'ledger transaction % must have at least 2 entries (has %)', p_tx_id, v_count;
  end if;

  select e.currency,
         sum(case when e.direction = 'debit' then e.amount_minor else -e.amount_minor end)
    into v_currency, v_net
    from public.ledger_entries e
   where e.ledger_transaction_id = p_tx_id
   group by e.currency
  having sum(case when e.direction = 'debit' then e.amount_minor else -e.amount_minor end) <> 0
   limit 1;

  if found then
    raise exception 'ledger transaction % does not net to zero for currency % (net % minor units)',
      p_tx_id, v_currency, v_net;
  end if;
end;
$$;

create or replace function public.ledger_entries_check_balanced()
returns trigger
language plpgsql
as $$
begin
  perform public.ledger_assert_balanced(new.ledger_transaction_id);
  return null;
end;
$$;

create or replace function public.ledger_transactions_check_balanced()
returns trigger
language plpgsql
as $$
begin
  perform public.ledger_assert_balanced(new.id);
  return null;
end;
$$;

create constraint trigger ledger_entries_net_zero
  after insert on public.ledger_entries
  deferrable initially deferred
  for each row execute function public.ledger_entries_check_balanced();

-- catches a transaction row inserted with zero entries (no entry trigger
-- would ever fire for it)
create constraint trigger ledger_transactions_min_entries
  after insert on public.ledger_transactions
  deferrable initially deferred
  for each row execute function public.ledger_transactions_check_balanced();

-- ---------------------------------------------------------------------------
-- post_ledger_transaction — the atomic, idempotent write path
-- ---------------------------------------------------------------------------

create or replace function public.post_ledger_transaction(
  p_idempotency_key text,
  p_description     text,
  p_entries         jsonb,
  p_transfer_id     uuid default null,
  p_transition      text default null
) returns public.ledger_transactions
language plpgsql
set search_path = public
as $$
declare
  v_tx      public.ledger_transactions;
  v_entry   jsonb;
  v_account public.ledger_accounts;
begin
  insert into public.ledger_transactions (transfer_id, transition, idempotency_key, description)
  values (p_transfer_id, p_transition, p_idempotency_key, p_description)
  on conflict (idempotency_key) do nothing
  returning * into v_tx;

  if v_tx.id is null then
    -- replay: the key already posted; insert nothing, return the original.
    select * into v_tx
      from public.ledger_transactions
     where idempotency_key = p_idempotency_key;
    return v_tx;
  end if;

  for v_entry in select * from jsonb_array_elements(p_entries) loop
    select * into v_account
      from public.ledger_accounts
     where code = v_entry->>'account_code';

    if not found then
      raise exception 'unknown ledger account code: %', v_entry->>'account_code';
    end if;

    if (v_entry->>'currency') is distinct from (v_account.currency)::text then
      raise exception 'entry currency % does not match account % currency %',
        v_entry->>'currency', v_account.code, v_account.currency;
    end if;

    insert into public.ledger_entries
      (ledger_transaction_id, account_id, direction, amount_minor, currency)
    values
      (v_tx.id, v_account.id, v_entry->>'direction',
       (v_entry->>'amount_minor')::bigint, v_entry->>'currency');
  end loop;

  -- the deferred constraint triggers validate net-zero + min entries at
  -- COMMIT; a failure aborts everything including the transaction row, so a
  -- failed post never burns the idempotency key.
  return v_tx;
end;
$$;

-- ---------------------------------------------------------------------------
-- ledger_account_balance — derived balance, signed by normal_balance
-- ---------------------------------------------------------------------------

create or replace function public.ledger_account_balance(p_account_code text)
returns table (amount_minor bigint, currency char(3))
language plpgsql
stable
set search_path = public
as $$
declare
  v_account public.ledger_accounts;
begin
  select * into v_account
    from public.ledger_accounts a
   where a.code = p_account_code;

  if not found then
    raise exception 'unknown ledger account code: %', p_account_code;
  end if;

  return query
    select coalesce(sum(
             case when e.direction = v_account.normal_balance
                  then e.amount_minor
                  else -e.amount_minor end
           ), 0)::bigint,
           v_account.currency
      from public.ledger_entries e
     where e.account_id = v_account.id;
end;
$$;

-- ---------------------------------------------------------------------------
-- privileges: service-role only; clients never touch the ledger
-- ---------------------------------------------------------------------------

revoke update, delete on public.ledger_transactions from anon, authenticated, service_role;
revoke update, delete on public.ledger_entries from anon, authenticated, service_role;

revoke execute on function public.post_ledger_transaction(text, text, jsonb, uuid, text)
  from public, anon, authenticated;
revoke execute on function public.ledger_account_balance(text)
  from public, anon, authenticated;
revoke execute on function public.ledger_assert_balanced(uuid)
  from public, anon, authenticated;

grant execute on function public.post_ledger_transaction(text, text, jsonb, uuid, text)
  to service_role;
grant execute on function public.ledger_account_balance(text)
  to service_role;
-- the constraint triggers run as the inserting role, which must be able to
-- call the assertion helper
grant execute on function public.ledger_assert_balanced(uuid)
  to service_role;

-- ---------------------------------------------------------------------------
-- seed: the 10-account chart (docs/ledger-rules.md is authoritative)
-- ---------------------------------------------------------------------------

insert into public.ledger_accounts (code, name, type, normal_balance) values
  ('cash_clearing',         'Cash clearing (Stripe/bank balance)',          'asset',     'debit'),
  ('bridge_wallet_float',   'Bridge treasury wallet float (USDC at par)',   'asset',     'debit'),
  ('funding_receivable',    'Funding receivable (ACH initiated, uncleared)','asset',     'debit'),
  ('due_from_bridge',       'Due from Bridge (payout in transit)',          'asset',     'debit'),
  ('transfer_payable',      'Transfer payable (obligation to deliver)',     'liability', 'credit'),
  ('refunds_payable',       'Refunds payable',                              'liability', 'credit'),
  ('fee_revenue',           'Puente fee revenue',                           'revenue',   'credit'),
  ('provider_fees',         'Provider fees (Stripe funding, Bridge bps)',   'expense',   'debit'),
  ('fx_slippage',           'FX slippage vs quoted rate',                   'expense',   'debit'),
  ('loss_funding_reversed', 'Losses from post-delivery funding reversals',  'expense',   'debit')
on conflict (code) do nothing;
