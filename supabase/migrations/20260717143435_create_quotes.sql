-- Migration: quotes (remittance MVP slice 3)
-- Created: 2026-07-17
-- Rollback: drop table public.quotes; drop function public.enforce_quote_terms_frozen();

create extension if not exists moddatetime schema extensions;

-- ── quotes ─────────────────────────────────────────────────────────────────
-- Puente's firm, time-boxed USD→MXN offer (the Reg E disclosure in slice 4 is
-- built from these numbers). Bridge offers no rate lock, so the quote is OUR
-- commitment: fx_rate = Bridge buy_rate (source_rate) minus our buffer, and
-- execution variance books to fx_slippage at SUBMITTED. Quotes post nothing
-- to the ledger; the MXN side is display/Reg E metadata, never a position.
-- Single-use: consumed by transfer creation (slice 4) or expired, never reused.

create table public.quotes (
  id                    uuid primary key default gen_random_uuid(),
  user_id               uuid not null references public.users(id) on delete cascade,
  -- Nullable in schema for future rate-browsing; the v1 API requires it.
  -- No cascade: destinations only disappear via the user cascade, which
  -- removes these rows through user_id in the same statement.
  payout_destination_id uuid references public.payout_destinations(id),
  -- Corridor is fixed USD→MXN for MVP; widening is a deliberate migration.
  send_amount_minor     bigint not null check (send_amount_minor > 0),
  send_currency         text not null check (send_currency = 'USD'),
  receive_amount_minor  bigint not null check (receive_amount_minor > 0),  -- display/Reg E, never ledgered
  receive_currency      text not null check (receive_currency = 'MXN'),
  fee_amount_minor      bigint not null check (fee_amount_minor >= 0),
  fee_currency          text not null check (fee_currency = 'USD'),
  fx_rate               numeric(12,4) not null check (fx_rate > 0),   -- customer-facing: source minus buffer
  source_rate           numeric(18,8) not null check (source_rate > 0), -- Bridge buy_rate at fetch (reconciliation)
  fx_rate_at            timestamptz not null,                         -- when we observed the rate
  provider_quote_ref    text,  -- always null today: Bridge gives no lock id; reserved for a provider that does
  status                text not null default 'active' check (status in ('active', 'expired', 'consumed')),
  expires_at            timestamptz not null,
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now(),
  check (expires_at > created_at)
);

comment on column public.quotes.fx_rate is
  'Customer-facing rate, fixed scale 4. Computed in integer arithmetic from source_rate minus
   QUOTE_FX_BUFFER_BPS, quantized down. Serialized to clients as a 4-dp decimal string.';

-- ── terms immutability ─────────────────────────────────────────────────────
-- An issued quote is a firm offer: its terms are frozen. Only the status
-- lifecycle (active → expired | consumed) may change; any other column update
-- is a bug, rejected at the database even for the service role.

create function public.enforce_quote_terms_frozen()
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

create trigger enforce_quotes_terms_frozen
  before update on public.quotes
  for each row execute procedure public.enforce_quote_terms_frozen();

alter table public.quotes enable row level security;

-- Owner reads own rows; ALL writes go through the API service role (which
-- bypasses RLS). No insert/update/delete policies on purpose.
create policy "quotes_select_own" on public.quotes
  for select using (auth.uid() = user_id);

create trigger handle_quotes_updated_at
  before update on public.quotes
  for each row execute procedure extensions.moddatetime(updated_at);

-- Serves the owner-scoped lookups and future keyset pagination.
create index quotes_user_id_created_at_idx
  on public.quotes (user_id, created_at desc, id desc);

-- Index the FK for the slice-4 transfer join and destination lookups.
create index quotes_payout_destination_id_idx
  on public.quotes (payout_destination_id);
