-- Migration: provider fee accrual + the Bridge invoice record
-- Created: 20260911190000
--
-- WHY (2026-09-11, first real Bridge invoice INV19341, $10.30):
-- ledger-rules.md assumed Bridge's explicit fees would arrive as per-transfer
-- receipt line items and book to `provider_fees` inside the transfer's own
-- posting. They do not. Bridge's receipts stay all-zero and the fees arrive as
-- a MONTHLY INVOICE, out of band — so `provider_fees` had 0 entries in prod
-- while a real $10.30 bill existed, and per-transfer P&L understated cost by
-- roughly $2 per send (dominated by the flat $1.00 SPEI fee per payout).
-- Nothing in the book or the daily reconciliation would ever have noticed.
--
-- This migration adds the three pieces the accrual model needs:
--
--   1. `bridge_fees_payable` (liability) — Bridge fees accrued at payout
--      submission but not yet invoiced, plus invoiced amounts not yet paid.
--      Deliberately Bridge-specific, not a generic `provider_fees_payable`:
--      the reconciliation check's whole job is comparing ONE provider's
--      accrual stream against ONE provider's invoice, and a shared payable
--      would make that sum meaningless. A second invoiced provider gets its
--      own account code and its own invoice rows — `provider_invoices`
--      carries `payable_account_code` precisely so that costs a seed row,
--      not a migration of history. (Stripe is NOT such a provider: its fees
--      are netted out of settlement, never billed.)
--
--   2. `provider_onboarding_fees` (expense) — the one-time-per-customer lines
--      (Individual Compliance $2.00, Wallet $0.25). These are ACQUISITION
--      cost, not transfer cost. Booking them into `provider_fees` would
--      amortize a customer's whole onboarding bill into whichever transfer
--      happened to be posting that month and make unit economics unreadable
--      (on the first invoice they were $6.50 of a $10.30 bill — 63%).
--
--   3. `provider_invoices` — the invoice itself, so the daily reconciliation
--      has something to compare accruals against. Invoices arrive as PDFs by
--      email; an operator records one via
--      `apps/api/scripts/record-provider-invoice.ts`.
--
-- The accrual postings themselves are in services/payouts.ts (SUBMITTED
-- batch); the invoice postings in services/provider-fees.ts.
--
-- Rollback:
--   drop function public.provider_fee_accrued_in_period(text, date, date);
--   drop function public.reconcile_provider_fee_unbilled(text);
--   drop function public.reconcile_provider_fee_accrual();
--   drop table public.provider_invoices;
--   drop index public.ledger_transactions_posted_at_idx;
--   delete from public.ledger_accounts where code in ('bridge_fees_payable', 'provider_onboarding_fees');
--   -- (the delete only succeeds while those accounts have no entries — an
--   --  accrual already posted means rolling back needs correcting entries,
--   --  not a drop.)

-- ---------------------------------------------------------------------------
-- chart of accounts: two new buckets (docs/ledger-rules.md is authoritative)
-- ---------------------------------------------------------------------------

insert into public.ledger_accounts (code, name, type, normal_balance) values
  ('bridge_fees_payable',      'Bridge fees accrued/invoiced, unpaid',       'liability', 'credit'),
  ('provider_onboarding_fees', 'One-time per-customer provider fees',        'expense',   'debit')
on conflict (code) do nothing;

-- ---------------------------------------------------------------------------
-- provider_invoices — one row per received provider invoice
-- ---------------------------------------------------------------------------
-- Amounts are integer minor units + explicit currency, like everything else
-- that touches money. `lines` keeps the invoice verbatim (label/qty/rate) so a
-- later pricing argument with the provider reads off our own record; the three
-- *_minor columns are the CLASSIFIED rollup the ledger actually books, and the
-- check constraint forces them to reconstruct the total exactly.

create table public.provider_invoices (
  id                    uuid primary key default gen_random_uuid(),
  provider              text not null check (provider in ('bridge')),
  invoice_number        text not null,
  -- Service period the invoice covers. Accruals are matched to it by the UTC
  -- date of their posting, so the window is timezone-deterministic.
  period_start          date not null,
  period_end            date not null,
  issued_at             date,
  due_at                date,
  currency              char(3) not null default 'USD' check (currency ~ '^[A-Z]{3}$'),
  total_minor           bigint not null check (total_minor >= 0),
  -- Classified rollup (services/provider-fees.ts classifyInvoiceLine):
  --   accruable  — per-send lines we accrue at SUBMITTED (SPEI, orchestration)
  --   onboarding — one-time per-customer lines (compliance, wallet)
  --   other      — real cost, but not derivable per transfer (ACH, gas)
  accruable_minor       bigint not null check (accruable_minor >= 0),
  onboarding_minor      bigint not null check (onboarding_minor >= 0),
  other_minor           bigint not null check (other_minor >= 0),
  lines                 jsonb not null,
  -- Which liability account this provider's accruals live in. Present so a
  -- second invoiced provider is a new account code + new rows, never a
  -- rewrite of the reconciliation query.
  payable_account_code  text not null default 'bridge_fees_payable'
                          references public.ledger_accounts(code),
  -- Set once the invoice is booked / paid. The *_at stamps are the authority
  -- on whether each step has happened; the transaction back-pointers are
  -- nullable even then, because an invoice whose accrual already matched to
  -- the cent (no onboarding lines, no unaccrued lines, zero variance) has
  -- nothing left to post — the payable already carries it. Keying "is this
  -- booked?" on the transaction id would have made that clean case look
  -- permanently unbooked.
  --
  -- Deliberately NOT foreign keys to ledger_transactions. The authoritative
  -- link is the deterministic idempotency key (`provider_invoice:<id>:booked`
  -- / `:paid`), which finds the posting without a constraint; the ledger is
  -- append-only, so in production the target can never disappear. What the FK
  -- would actually buy is nothing, and what it costs is real: it makes
  -- `truncate ledger_transactions` — the fixture reset a dozen db tests run
  -- between cases — fail, or silently delete invoice rows under CASCADE.
  booked_at             timestamptz,
  booked_transaction_id uuid,
  paid_at               timestamptz,
  paid_transaction_id   uuid,
  recorded_by           text not null,
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now(),

  constraint provider_invoices_period_ordered check (period_end >= period_start),
  -- The classified buckets must reconstruct the invoice exactly. A line the
  -- classifier does not recognize cannot be silently dropped into nothing.
  constraint provider_invoices_classification_totals
    check (accruable_minor + onboarding_minor + other_minor = total_minor),
  -- A posting back-pointer without its stamp is a half-written record.
  constraint provider_invoices_booked_stamped
    check (booked_transaction_id is null or booked_at is not null),
  constraint provider_invoices_paid_stamped
    check (paid_transaction_id is null or paid_at is not null),
  -- Paying an invoice that was never booked would debit a payable the book
  -- never recognized.
  constraint provider_invoices_paid_after_booked
    check (paid_at is null or booked_at is not null)
);

comment on table public.provider_invoices is
  'Received provider invoices (Bridge, monthly). The source the daily provider_fee_accrual reconciliation check compares booked accruals against — see docs/ledger-rules.md "FX & provider economics" and docs/runbooks/reconciliation.md.';

create unique index provider_invoices_provider_number_key
  on public.provider_invoices (provider, invoice_number);

create index provider_invoices_period_idx
  on public.provider_invoices (provider, period_start);

alter table public.provider_invoices enable row level security;

-- Financial-ops data: no client access, service_role only (same posture as
-- the ledger tables and reconciliation_runs).
create policy "provider_invoices_deny_all" on public.provider_invoices
  for all using (false);

create trigger handle_provider_invoices_updated_at
  before update on public.provider_invoices
  for each row execute procedure extensions.moddatetime(updated_at);

-- Once an invoice has been BOOKED, its financial facts are ledger history: the
-- postings were computed from these numbers and the ledger cannot be edited.
-- Editing the invoice afterwards would leave the two permanently disagreeing
-- with nothing to show it happened. Correct a wrong invoice the way the ledger
-- corrects anything — record the provider's credit note as its own row.
create or replace function public.provider_invoices_forbid_booked_edit()
returns trigger
language plpgsql
as $$
begin
  if old.booked_at is not null
     and (new.total_minor      is distinct from old.total_minor
       or new.accruable_minor  is distinct from old.accruable_minor
       or new.onboarding_minor is distinct from old.onboarding_minor
       or new.other_minor      is distinct from old.other_minor
       or new.lines            is distinct from old.lines
       or new.period_start     is distinct from old.period_start
       or new.period_end       is distinct from old.period_end
       or new.invoice_number   is distinct from old.invoice_number
       or new.booked_at             is distinct from old.booked_at
       or new.booked_transaction_id is distinct from old.booked_transaction_id)
  then
    raise exception 'provider invoice % is already booked to the ledger: its amounts and period are immutable — record a credit note as a new invoice instead', old.invoice_number;
  end if;
  return new;
end;
$$;

create trigger provider_invoices_booked_immutable
  before update on public.provider_invoices
  for each row execute function public.provider_invoices_forbid_booked_edit();

-- ---------------------------------------------------------------------------
-- the accrual window scan needs posted_at ordering
-- ---------------------------------------------------------------------------

create index ledger_transactions_posted_at_idx
  on public.ledger_transactions (posted_at);

-- ---------------------------------------------------------------------------
-- provider_fee_accrued_in_period — the same sum, for a period not yet recorded
-- ---------------------------------------------------------------------------
-- reconcile_provider_fee_accrual() can only measure an invoice that already
-- exists. The recorder's DRY RUN has to show the true-up it WOULD post before
-- anything is written — a dry run that cannot show the postings is half a dry
-- run — so the windowing logic is factored here and both callers share it.
-- Identical exclusion rule: invoice postings are not accruals.

create or replace function public.provider_fee_accrued_in_period(
  p_account_code text,
  p_from         date,
  p_to           date
)
returns bigint
language sql
stable
set search_path = public
as $$
  select coalesce(sum(e.amount_minor), 0)::bigint
    from public.ledger_entries e
    join public.ledger_transactions t on t.id = e.ledger_transaction_id
    join public.ledger_accounts a on a.id = e.account_id
   where a.code = p_account_code
     and e.direction = 'credit'
     and t.idempotency_key not like 'provider_invoice:%'
     and (t.posted_at at time zone 'UTC')::date between p_from and p_to;
$$;

-- ---------------------------------------------------------------------------
-- reconcile_provider_fee_accrual — accrued vs invoiced, per recorded invoice
-- ---------------------------------------------------------------------------
-- `accrued_minor` sums the CREDITS to the provider's payable account posted
-- inside the invoice's service period, EXCLUDING the invoice postings
-- themselves (idempotency key `provider_invoice:…`) — otherwise booking an
-- invoice would inflate the very number it is being compared against.
--
-- `variance_minor` = invoiced accruable − accrued. Positive means we
-- under-accrued (the provider charged more than our model predicted); the job
-- decides what size of variance is worth paging about.

create or replace function public.reconcile_provider_fee_accrual()
returns table (
  invoice_id       uuid,
  invoice_number   text,
  provider         text,
  period_start     date,
  period_end       date,
  total_minor      bigint,
  accruable_minor  bigint,
  onboarding_minor bigint,
  other_minor      bigint,
  accrued_minor    bigint,
  variance_minor   bigint,
  booked           boolean,
  paid             boolean
)
language sql
stable
set search_path = public
as $$
  select i.id,
         i.invoice_number,
         i.provider,
         i.period_start,
         i.period_end,
         i.total_minor,
         i.accruable_minor,
         i.onboarding_minor,
         i.other_minor,
         coalesce(accrued.amount_minor, 0)::bigint as accrued_minor,
         (i.accruable_minor - coalesce(accrued.amount_minor, 0))::bigint as variance_minor,
         i.booked_at is not null as booked,
         i.paid_at is not null as paid
    from public.provider_invoices i
    left join lateral (
      select public.provider_fee_accrued_in_period(
               i.payable_account_code, i.period_start, i.period_end
             ) as amount_minor
    ) accrued on true
   order by i.period_start desc, i.invoice_number;
$$;

-- ---------------------------------------------------------------------------
-- reconcile_provider_fee_unbilled — accruals no recorded invoice covers
-- ---------------------------------------------------------------------------
-- The other half of the gap this migration closes. An invoice that never
-- arrives (or never gets recorded) is indistinguishable from one that
-- reconciled perfectly unless something watches for accrual days that no
-- invoice period covers. Returns the oldest such day so the job can apply a
-- grace window — the current month is always legitimately unbilled.

create or replace function public.reconcile_provider_fee_unbilled(p_account_code text)
returns table (
  earliest_day  date,
  latest_day    date,
  accrued_minor bigint,
  day_count     bigint
)
language sql
stable
set search_path = public
as $$
  with accrual_days as (
    select (t.posted_at at time zone 'UTC')::date as day,
           sum(e.amount_minor) as amount_minor
      from public.ledger_entries e
      join public.ledger_transactions t on t.id = e.ledger_transaction_id
      join public.ledger_accounts a on a.id = e.account_id
     where a.code = p_account_code
       and e.direction = 'credit'
       and t.idempotency_key not like 'provider_invoice:%'
     group by 1
  )
  select min(d.day),
         max(d.day),
         coalesce(sum(d.amount_minor), 0)::bigint,
         count(*)::bigint
    from accrual_days d
   where not exists (
     select 1
       from public.provider_invoices i
      where i.payable_account_code = p_account_code
        and d.day between i.period_start and i.period_end
   )
  having count(*) > 0;
$$;

-- ---------------------------------------------------------------------------
-- privileges: service-role only, like every ledger function
-- ---------------------------------------------------------------------------

revoke execute on function public.reconcile_provider_fee_accrual() from public, anon, authenticated;
revoke execute on function public.reconcile_provider_fee_unbilled(text) from public, anon, authenticated;
revoke execute on function public.provider_fee_accrued_in_period(text, date, date) from public, anon, authenticated;

grant execute on function public.reconcile_provider_fee_accrual() to service_role;
grant execute on function public.reconcile_provider_fee_unbilled(text) to service_role;
grant execute on function public.provider_fee_accrued_in_period(text, date, date) to service_role;
