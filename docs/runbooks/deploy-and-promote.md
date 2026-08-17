# Runbook — Deploy & Promote to Production

**Date:** 2026-07-10 · **Status:** live process (verified end-to-end 2026-07-10, PRs #50/#51)

## The model in one line

`main` **is** the staging pipeline; the `production` branch **is** what's live. Vercel prod
(www.puentefinancial.com) and Railway prod both track `production` — merging to `main` cannot touch
production. The only action that moves production is the **Promote** workflow.

```
feature/* ──PR──▶ main ──auto──▶ staging (Railway + Vercel main-branch + staging DB migrations)
                    │
         Promote workflow (workflow_dispatch + approval)
                    │  1. prod DB migrations   2. fast-forward production → main
                    ▼
               production (Railway prod + Vercel prod)
```

## Ship to staging

1. PR into `main`. Required checks: `Typecheck, Lint, Test` + `Gitleaks`; if the PR touches
   `supabase/migrations/**`, the Migrations workflow dry-runs it against staging.
2. Merge (squash/rebase — linear history enforced). Automatically:
   - Railway builds + health-check-gated cutover of `puenteapi-staging.up.railway.app`
   - Vercel deploys `landingpage-git-main-puente-financial.vercel.app` (behind Vercel
     Authentication — anonymous requests get an SSO 302; automation needs a Protection Bypass
     token, not yet generated)
   - Migrations workflow applies pending migrations to the **staging** DB for real

## Promote to production

1. Actions → **Promote to Production** → Run workflow (from `main`). `gh` alternative:
   `gh workflow run promote.yml`.
2. Approve the run (GitHub `production` environment protection — Joshua is required reviewer).
   The run summary shows exactly which commits ship (`production..main` log).
3. The job then, in order:
   - **applies pending prod DB migrations** (`supabase db push` with `PROD_DB_URL` — a Production
     *environment* secret only this approval-gated job can read). Schema lands before code.
   - **fast-forward-only** pushes `production` to `main`. If production diverged, it fails loudly
     rather than rewriting history.
4. Railway prod + Vercel prod pick up the `production` branch move and deploy together.

**Failure semantics (proven live):** if the migration step fails, the promote stops — the branch is
unmoved and prod code untouched. Any migrations that applied before the failure stay applied;
re-running is safe (`db push` only applies what's still pending). `concurrency: promote-production`
means never two promotes in flight.

## Worker service (Railway, slice 5)

Slice 5 added a **second Railway service** in the same repo — the pg-boss background worker (payout
submit/sweep/poll, payment-event processing, housekeeping crons). Its Settings → Config File Path
points at `railway.worker.toml` (config-as-code overrides dashboard settings; without it the
service would inherit `railway.toml` and boot the API instead):

- **Build:** `pnpm turbo build --filter=@puente/api` (same as the API).
- **Start:** `node apps/api/dist/worker.js` (the API starts `dist/server.js`).
- **Healthcheck:** `/health` — **not** `/v1/health` (the API's path).
- **Tracks:** the `production` branch + Doppler `prd_main`, same as the API service.

**The prod worker is live as of 2026-08-17** (`puente-worker`, prod project), stood up alongside
out-of-band funding — the first thing that gives prod a real path to `FUNDED`, and therefore the
first thing that needs a worker to carry a transfer past it. Both environments now run both
services, and a Promote cuts over API + worker + Vercel.

Standing it up, in the order that matters (the first two must precede the first build):

1. **Source:** connect the repo, then set the branch to `production`. A worker tracking `main`
   would run unpromoted code against the prod database.
2. **Config File Path:** `railway.worker.toml`. Left at the default it boots `dist/server.js` — a
   second API that passes health checks, serves nothing, and runs zero jobs. Nothing looks wrong.
3. **Variables:** a second Doppler sync from the same `prd_main` config (not a new config) —
   `DATABASE_URL`, `BRIDGE_TREASURY_WALLET_ID`, `FLOAT_CEILING_MINOR` must all be present.
   `FLOAT_CEILING_MINOR` is the quiet one: no default, and it throws at *payout* time rather than
   at boot, so a worker missing it looks perfectly healthy until the first payout fails.
4. **Redeploy explicitly** after the sync — Railway does not restart on every var change.
5. **Leave it unexposed.** A worker needs no public domain; `/health` is for Railway's internal check.

Do NOT set `FUNDING_PROCESSOR` on the worker (or the API) to a value the *deployed* code's enum
doesn't know. `config/env.ts` `process.exit(1)`s on an unknown value, the healthcheck never
answers, and the deploy fails — cost us two failed deploys on 2026-08-17. Order is always: merge →
promote → then flip the var.

## Post-deploy verification drill

- **Staging API:** `curl -s https://puenteapi-staging.up.railway.app/v1/health` (+ CORS headers) — public, no auth.
- **Staging DB write path:** insert a marked waitlist row through the site, confirm in `puente-staging`.
- **www identity:** confirm the live deployment's `meta.githubCommitRef == "production"` (Vercel MCP
  `get_deployment` or dashboard). Don't trust "it looks deployed."
- **Prod API:** `curl -s https://puenteapi-production.up.railway.app/v1/health`.
- **Worker (both environments):** the healthcheck is `/health`, **not** `/v1/health` — but it
  returns 200 unconditionally and therefore proves only that a process exists. The real check is a
  fresh `worker_heartbeat.updated_at` (one row, `worker = 'worker'`; the beat is written by a
  database trigger, and the cron ticks on `*/5`, so allow up to 5 minutes after a deploy). Green in
  Railway is exactly what the dashboard showed throughout the 22.4-hour August outage.
- After anything touching rate limiting / IPs: check a staging audit-log row records a real client
  IP (bump `TRUST_PROXY_HOPS` if not).

## Rollback

- **Prod code:** Railway dashboard → redeploy the previous deployment (fastest), or revert the bad
  commit on `main` and run Promote again (keeps branch history truthful — preferred unless www is
  actively broken). Never force-push `production`.
- **Vercel:** promote the previous production deployment from the Vercel dashboard.
- **Migrations don't roll back automatically.** Write a new forward migration that undoes the
  change; never edit or delete an applied migration file.

## Gotchas (each cost us time once)

- Vercel Environments → Production → Branch Tracking has its **own Save button**; unsaved = merges
  to main still deploy to www.
- DB URLs in CI are **session pooler** strings (GitHub runners are IPv4-only; the direct `db.<ref>`
  host is IPv6).
- Vercel sensitive env vars are write-only — verify by overwriting, not reading.
- zsh: `!` in passwords inside double quotes triggers history expansion — use single quotes.
