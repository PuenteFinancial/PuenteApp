create table if not exists waitlist (
  id                    uuid default gen_random_uuid() primary key,
  created_at            timestamptz default now(),
  first_name            text not null,
  phone                 text not null,
  email                 text,
  monthly_send_amount   text not null,
  destination_country   text not null,
  remittance_provider   text not null,
  language_preference   text default 'en',
  utm_source            text,
  utm_medium            text,
  utm_campaign          text,
  user_agent            text,
  ip_country            text
);

alter table waitlist enable row level security;

create policy "service_role_insert" on waitlist
  for insert to service_role with check (true);
