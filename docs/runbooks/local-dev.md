# Runbook — Local Development

**Date:** 2026-07-20 · **Status:** live process (stack verified 2026-07-08)

Two supported setups. **Default: point local apps at staging** — safe, zero Docker.

## New collaborator setup

Toolchain (all pinned by the repo):

1. **Node 22** — `.node-version` is picked up by mise/fnm/nvm.
2. **pnpm** — `corepack enable`; the `packageManager` field in root `package.json` pins the version.
3. `pnpm install` at the repo root (also installs the Supabase MCP server binary `.mcp.json` uses).
4. No Docker needed for Setup A below.

Accounts + secrets (ask Joshua for invites; nothing secret is in git):

- **Doppler** — source of truth for secrets (`doppler setup`, then run the API via
  `doppler run -- pnpm dev`). See `secrets.md`.
- **Supabase org** — then create your own personal access token and export it in your shell as
  `SUPABASE_ACCESS_TOKEN`; the checked-in `.mcp.json` reads it from the environment (read-only,
  pinned to staging).
- **PostHog** org; **Sentry** if triaging errors. Vercel team access is optional — per-PR preview
  deploys appear at `landingpage-git-<branch>-puente-financial.vercel.app` (note: previews sit
  behind Vercel Authentication, so anonymous requests may get an SSO redirect).
- Env files to create (see the `.env.example` next to each): `apps/web/.env.local`
  (`INTERNAL_API_URL` + PostHog public vars — nothing secret) and `apps/api/.env`
  (staging + Bridge **sandbox** values, from Doppler `dev_main`).

The Claude Code harness ships with the clone: `CLAUDE.md`, hooks + permissions
(`.claude/settings.json`), dev-server launch config (`.claude/launch.json`), skills, reviewer
agents, and `.mcp.json`. `.claude/settings.local.json` is personal, per machine.

Day-one smoke test: start the API (Setup A), start web, hit `localhost:3000`, submit a marked
waitlist entry, confirm the row lands in **puente-staging**.

## Setup A — local apps → staging cloud (default)

- `apps/api/.env` already points at **puente-staging** + **Bridge sandbox**. Safe to boot and write
  (verified: waitlist inserts land in staging, no real data there). `PORT=3001`.
- `pnpm dev` alone **fails env validation** — nothing auto-loads `.env` (no dotenv; tsx doesn't).
  Run via Doppler, or: `set -a; source .env; set +a; pnpm dev`.
- Web: `apps/web/.env.local` needs only `INTERNAL_API_URL=http://localhost:3001` + PostHog public
  tokens. `apiFetch` **throws** if `INTERNAL_API_URL` is unset — there is no default.
- API must bind `HOST=::` — Node's fetch resolves `localhost` to `::1`, so an IPv4-only bind breaks
  the web→API proxy.

## Setup B — fully local (supabase start)

1. `supabase start` (Docker). Phone auth works via test OTP in `supabase/config.toml`:
   number `15005550006`, code `123456` (dummy-enabled Twilio — GoTrue refuses phone auth without an
   enabled provider; no real SMS).
2. After migrations apply, fix the local grants quirk (local CLI only — hosted is fine):
   ```
   docker exec supabase_db_goyfagidfkjyhyepsaup psql -U postgres -d postgres \
     -c "grant select, insert, update, delete on all tables in schema public to service_role, authenticated, anon;"
   ```
   Without it, the API gets `permission denied (42501)` on every table.
3. API env: local `SUPABASE_URL`/keys from `supabase start` output — must use the **legacy
   service-role JWT** (the newer `sb_secret_…` keys also 42501 locally), plus
   `SUPABASE_JWKS_URL=http://127.0.0.1:54321/auth/v1/.well-known/jwks.json`, `HOST=::`, `PORT=3001`.

## Hard-won rules

- **One `next dev` per checkout.** Two instances share `.next` and corrupt it (ENOENT page.js 500s).
  Fix: kill both, `rm -rf apps/web/.next`.
- **Identity is the phone number** — one account per phone, forever. A shared test number = one
  shared account (caused the poisoned-row 404 incident on 2026-07-08). Multi-tester work uses
  Supabase test phone numbers (fixed OTP, no Twilio).
- Bridge **sandbox cannot test hosted KYC links** (API-created customers + `simulate_kyc_approval`
  only) — KYC UI testing happens on prod with test phone numbers + Bridge-customer delete reset.
  Sandbox is right for remittance API testing (wallets, simulate_deposit, transfers with dummy data).
- Never point local API `.env` at the prod project. Roles: `goyfagidfkjyhyepsaup` = PROD (live
  waitlist data); `namdkmsmdkmdffgscqgd` = dev + staging.
- Tests: `pnpm test` from `apps/api/`; `pnpm run typecheck` after any change.
