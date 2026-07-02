create extension if not exists moddatetime schema extensions;

create table public.users (
  id                 uuid primary key references auth.users(id) on delete cascade,
  phone              text unique not null,
  email              text,
  first_name         text,
  last_name          text,
  preferred_language text not null default 'en' check (preferred_language in ('en', 'es')),
  status             text not null default 'waitlist' check (status in ('waitlist', 'active', 'suspended')),
  fcra_consent_at    timestamptz,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now()
);

alter table public.users enable row level security;

create policy "users_select_own" on public.users
  for select using (auth.uid() = id);

create policy "users_update_own" on public.users
  for update using (auth.uid() = id);

create trigger handle_users_updated_at
  before update on public.users
  for each row execute procedure extensions.moddatetime(updated_at);

create or replace function public.handle_new_user()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  insert into public.users (id, phone, email)
  values (new.id, new.phone, new.email);
  return new;
end;
$$;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute procedure public.handle_new_user();
