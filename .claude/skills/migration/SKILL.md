---
name: migration
description: Create a Supabase database migration
---

When creating a new database migration:

## File location
`supabase/migrations/<timestamp>_<description>.sql`

Create with the Supabase CLI (correct name and place, guaranteed):
```bash
supabase migration new <description>
```
Or manually, generating the 14-digit timestamp with `date +%Y%m%d%H%M%S`.
Existing migrations use zeroed time (`20260707000000_add_bridge_kyc_fields.sql`) — both styles are valid; the CLI only requires the `YYYYMMDDHHMMSS_description.sql` shape. Files elsewhere (e.g. `apps/api/`) are invisible to `supabase db push`.

## Applying
Via Supabase CLI only — NEVER through the Supabase MCP, and never destructive SQL against a remote project.

```bash
supabase db push --dry-run                                            # preview pending migrations
supabase link --project-ref namdkmsmdkmdffgscqgd && supabase db push  # staging first
supabase link --project-ref goyfagidfkjyhyepsaup && supabase db push  # prod — requires Joshua's explicit approval
supabase link --project-ref namdkmsmdkmdffgscqgd                      # relink staging when done
```

## Rules
- Always include `up` logic, and a comment stating what the rollback would be
- `alter table` migrations skip the table template below but still need the rollback comment (see `supabase/migrations/20260707000000_add_bridge_kyc_fields.sql`)
- Add Row Level Security (RLS) policy for every new table
- Never store PII in plaintext — use pgcrypto or note encryption requirement
- Add audit timestamps: `created_at`, `updated_at` on every table
- Index foreign keys

## New-table template
```sql
-- Migration: <description>
-- Created: <timestamp>
-- Rollback: drop table <table_name>;

-- Create table
CREATE TABLE IF NOT EXISTS <table_name> (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  -- columns here
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- RLS
ALTER TABLE <table_name> ENABLE ROW LEVEL SECURITY;

CREATE POLICY "<table_name>_owner" ON <table_name>
  FOR ALL USING (auth.uid() = user_id);

-- Index
CREATE INDEX ON <table_name>(user_id);
```
