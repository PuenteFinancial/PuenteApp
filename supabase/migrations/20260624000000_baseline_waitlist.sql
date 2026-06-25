create table if not exists waitlist (
  id                    uuid default gen_random_uuid() primary key,
  created_at            timestamptz default now(),
  first_name            text not null,
  phone                 text not null,
  email                 text,
  monthly_send_amount   text,
  destination_country   text,
  remittance_provider   text,
  language_preference   text default 'en',
  utm_source            text,
  utm_medium            text,
  utm_campaign          text,
  user_agent            text,
  ip_country            text,
  knows_credit_score    text,
  credit_score_range    text,
  remit_frequency       text,
  remit_years           text
);

alter table waitlist enable row level security;

do $$
begin
  if not exists (
    select 1 from pg_policies
    where schemaname = 'public'
      and tablename  = 'waitlist'
      and policyname = 'service_role_insert'
  ) then
    execute 'create policy "service_role_insert" on waitlist
             for insert to service_role with check (true)';
  end if;
end $$;
