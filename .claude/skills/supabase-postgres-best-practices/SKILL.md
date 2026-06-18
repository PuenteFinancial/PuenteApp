---
name: supabase-postgres-best-practices
description: Postgres patterns for financial data — RLS, constraints, indexes, audit columns
---

Apply these patterns to every new table in a migration. Financial tables have stricter requirements than typical app tables.

## RLS — who can read/write what

All tables must have RLS enabled. The right policy depends on the table type:

**User-owned data** (profiles, consent records, preferences):
```sql
ALTER TABLE <table> ENABLE ROW LEVEL SECURITY;
-- Users can only see their own rows
CREATE POLICY "<table>_owner" ON <table>
  FOR ALL USING (auth.uid() = user_id);
```

**Financial / ledger tables** — NO direct client access. Service role only:
```sql
ALTER TABLE ledger_entries ENABLE ROW LEVEL SECURITY;
-- Deny all client access — the API uses service_role which bypasses RLS
CREATE POLICY "ledger_entries_deny_all" ON ledger_entries
  FOR ALL USING (false);
```

**Read-only reference data** (credit tiers, FX rates):
```sql
CREATE POLICY "<table>_public_read" ON <table>
  FOR SELECT USING (true);
-- No INSERT/UPDATE/DELETE policy = blocked for non-service-role
```

## Amount columns — always constrain
```sql
amount_minor  BIGINT NOT NULL CHECK (amount_minor > 0),
currency      CHAR(3) NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
```
Use `BIGINT` not `INTEGER` — amounts can exceed 2B minor units over a ledger's lifetime.

## Idempotency keys table (create once, reference from all money-moving routes)
```sql
CREATE TABLE idempotency_keys (
  key         UUID PRIMARY KEY,
  response    JSONB NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at  TIMESTAMPTZ NOT NULL
);
CREATE INDEX ON idempotency_keys (expires_at);  -- for cleanup job
-- Purge expired keys nightly via pg_cron or a scheduled function
```

## Audit columns — every table
```sql
created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
```
Add the trigger that keeps `updated_at` current:
```sql
CREATE OR REPLACE FUNCTION set_updated_at()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN NEW.updated_at = NOW(); RETURN NEW; END;
$$;

CREATE TRIGGER set_updated_at
  BEFORE UPDATE ON <table>
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
```

## Indexes — always index these
```sql
CREATE INDEX ON <table> (user_id);               -- every table with user_id
CREATE INDEX ON <table> (created_at DESC);        -- for time-ordered queries
CREATE INDEX ON <table> (status) WHERE status != 'completed';  -- partial index for open records
```

## Ledger tables — additional requirements
```sql
-- Link entries to their transaction
transaction_id  UUID NOT NULL,
-- Prevent balance drift: derive balances via SUM, never store mutable balance
-- Add a constraint linking paired entries in app logic, not DB (too complex for CHECK)

-- Full replica identity so logical replication captures all columns for audit
ALTER TABLE ledger_entries REPLICA IDENTITY FULL;
```

## PII — never plaintext in DB
- SSN, DOB: encrypt at application layer before insert (use `pgcrypto` or app-side encryption)
- Phone, email: fine in plaintext but never in URL params or logs
- Never SELECT * on tables with PII — always name columns explicitly

## Rollback comment (required on every migration)
```sql
-- Rollback: DROP TABLE <table>; (or specific ALTER/DROP statements)
```

## Checklist
- [ ] RLS enabled and correct policy for table type
- [ ] `amount_minor` is BIGINT with CHECK > 0
- [ ] `currency` is CHAR(3) with uppercase regex check
- [ ] `created_at` / `updated_at` with trigger
- [ ] Indexes on user_id, created_at, and any filtered status column
- [ ] Rollback comment present
- [ ] No plaintext SSN or DOB
