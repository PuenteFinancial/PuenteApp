---
name: migration
description: Create a Supabase database migration
---

When creating a new migration:

## File location
`apps/api/migrations/<timestamp>_<description>.sql`
Generate timestamp with: `date +%Y%m%d%H%M%S`

## Rules
- Always include `up` logic (and comment what the rollback would be)
- Add Row Level Security (RLS) policy for every new table
- Never store PII in plaintext — use pgcrypto or note encryption requirement
- Add audit timestamps: `created_at`, `updated_at` on every table
- Index foreign keys

## Template
```sql
-- Migration: <description>
-- Created: <timestamp>

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
