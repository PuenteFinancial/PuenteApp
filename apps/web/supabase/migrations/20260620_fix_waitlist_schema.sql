-- Add missing columns that the waitlist route inserts but were never migrated
alter table waitlist
  add column if not exists remit_frequency text,
  add column if not exists remit_years     text;

-- These columns were NOT NULL in the original migration but the form treats them
-- as optional — signups where users skip these steps were failing on insert
alter table waitlist
  alter column monthly_send_amount   drop not null,
  alter column destination_country   drop not null,
  alter column remittance_provider   drop not null;

-- Rollback:
-- alter table waitlist drop column remit_frequency, drop column remit_years;
-- alter table waitlist alter column monthly_send_amount set not null,
--   alter column destination_country set not null, alter column remittance_provider set not null;
