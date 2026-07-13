# Runbook — Database Migrations

**Date:** 2026-07-10 · **Status:** live process (pipeline shipped in PR #51)

Two Supabase projects: **`puente-staging`** (`namdkmsmdkmdffgscqgd`, dev + staging, no real data)
and **`PuenteApp`** (`goyfagidfkjyhyepsaup`, **PROD — live data**). Migrations flow staging → prod,
always through the pipeline, never by hand.

## Authoring

1. Use the `migration` skill / `supabase migration new <name>` → file in `supabase/migrations/`.
2. Follow `financial-schema-checklist` for any new table or RLS policy (RLS on, deny-by-default,
   money as `_amount_minor BIGINT` + `_currency TEXT`, audit columns).
3. Test locally: `supabase start` + `supabase db reset` replays the full migration history.
4. **Never** apply schema changes to a remote project via the Supabase MCP or dashboard SQL editor.
   Write a migration file; let the pipeline apply it. (MCP is for inspection only.)

## Pipeline (what happens when)

| Event | Action | Workflow |
|---|---|---|
| PR touching `supabase/migrations/**` | **Dry-run** against staging (catches drift/ordering before merge; fork PRs skipped) | `migrations.yml` |
| Merge to `main` | **Apply to staging** for real — staging DB always matches the staging app | `migrations.yml` |
| Promote workflow (approved) | **Apply to prod**, *before* the code fast-forward — schema lands before the code that needs it | `promote.yml` |
| Manual check | `workflow_dispatch` on Migrations = staging dry-run on demand | `migrations.yml` |

"Remote database is up to date" in the Promote log = no pending migrations; normal.

## Verifying a migration reached an environment

- **With DB password (Joshua only):** `supabase migration list` against the linked project.
- **Without password (any session):** REST probe for the migration's artifacts:
  `GET {SUPABASE_URL}/rest/v1/<table>?select=<new_col>&limit=1` with the service key →
  `200` = applied · `404` = table missing · `400` = column missing.
  Staging service key via `supabase projects api-keys`; prod key is in `apps/api/.env`.
- Avoid running the supabase CLI repeatedly from sandboxed Claude sessions — each invocation
  re-reads the keychain token and spams macOS keychain prompts.

## Rules

- Applied migration files are immutable — fix-forward with a new migration, never edit/renumber.
- Local CLI quirk: locally-applied migrations lack DML grants — run
  `grant select, insert, update, delete on all tables in schema public to service_role, authenticated, anon;`
  via psql after `supabase db reset` (hosted projects unaffected). See `local-dev.md`.
- `supabase/.temp/linked-project.json` is linked to **staging** so stray CLI pushes can't hit prod.
  Keep it that way.
- DB passwords are write-only in Supabase (reset-only). The only consumers are the pipeline secrets
  (`STAGING_DB_URL` repo secret; `PROD_DB_URL` Production environment secret) — resetting a password
  means updating those, nothing else.
