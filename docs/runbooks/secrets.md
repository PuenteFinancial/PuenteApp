# Runbook — Secrets Map & Rotation

**Date:** 2026-07-10 · **Status:** live process

**Doppler is the source of truth**; everything else is a sync target or a deliberately-scoped
exception. No secret ever lands in git, client code, or logs (Gitleaks enforces on every PR/push).

## Where every secret lives

| Store | Configs / scope | Contents |
|---|---|---|
| Doppler `puente-api` | `dev_main`, `stg_main`, `prd_main` → synced to Railway envs | Supabase URL/keys, Bridge keys (sandbox in stg, live in prd), Twilio, CRS, Sentry, `TRUST_PROXY_HOPS`, `BRIDGE_WEBHOOK_PUBLIC_KEY`. **Slice-5 worker vars:** `DATABASE_URL` + `BRIDGE_TREASURY_WALLET_ID` (no defaults — the worker asserts both at boot) and `FLOAT_CEILING_MINOR` (no default — the submit job refuses to submit payouts without it); tuning knobs with code defaults, env-overridable: `FX_MAX_DRIFT_BPS` (200), `FX_MAX_QUOTE_AGE_MINUTES` (240), `WORKER_POLL_INTERVAL_SECONDS` (300). `MOCK_FUNDING_WEBHOOK_SECRET` — HMAC for the mock funding processor's webhook + `/confirm`. **dev + stg only, never prd**: its absence 503s the funding webhook + confirm (the production lock against mock funding); present in dev/stg it lets you exercise the funding path against Bridge sandbox. Generate `openssl rand -hex 24`; the value must match on both the API and whatever fires the webhook (the `fire-funding-webhook` script / e2e) |
| Doppler `puente-web` | 3 configs → synced to Vercel | `INTERNAL_API_URL` + PostHog tokens (public), ~3 vars each |
| GitHub Actions — repo secrets | all workflows | `STAGING_DB_URL` (session-pooler string), `TURBO_TOKEN`, `TURBO_TEAM=puente-financial` |
| GitHub Actions — `production` environment secret | readable **only** inside the approval-gated Promote job | `PROD_DB_URL` (session-pooler string) |
| EAS | mobile builds | Expo/EAS-side config (no provider secrets — mobile never calls providers) |
| Local | `apps/api/.env` (staging + sandbox values), `apps/web/.env.local` (`INTERNAL_API_URL` + PostHog public only) | see `local-dev.md` |

Supabase DB passwords are **write-only** (reset-only in Database→Settings, new UI). Their only
consumers are the two pipeline secrets above.

## Rotation procedure (generic)

1. Mint the new credential at the provider.
2. Update Doppler (correct project + config) — sync pushes to Railway/Vercel; redeploy if the
   platform doesn't hot-reload.
3. Update the GitHub Actions secret if it's one of the pipeline DB URLs.
4. Verify with the write-then-probe pattern (Vercel/Doppler values are often write-only — verify by
   behavior, not by reading back): hit the affected endpoint or run the relevant workflow dry-run.
5. Revoke the old credential at the provider **after** verification.
6. Purge any scratch files that held the old value (`git status` + `scratch/`; the repo is
   Gitleaks-scanned, scratch is not).

## Provider-specific notes

- **Bridge:** keys are dashboard-minted. Webhook signature verification uses
  `BRIDGE_WEBHOOK_PUBLIC_KEY` (PEM, per-webhook — rotating the API key does *not* rotate webhook
  keys). Sandbox (`sk-test`) and live (`sk-live`) are separate.
- **Supabase:** resetting a DB password only affects `STAGING_DB_URL` / `PROD_DB_URL`. Service-role
  JWT rotation is separate (Doppler). Prod DB password rotated 2026-07-10 ✅.
- **Doppler → Railway:** confirm the service redeployed after a sync; Railway does not restart on
  every var change.
- **`DATABASE_URL` goes to BOTH Railway services (API + worker), not just the worker.** (Both
  services run in **staging** today; the prod worker is deferred to slice 7 — see
  `deploy-and-promote.md` — so in prod only the API consumes it for now.) It's the
  Supabase **session-mode** pooler string (port 5432, never transaction mode 6543 — pg-boss needs
  session semantics). The worker asserts it at startup; the **API needs it too** so money-moving
  webhooks (funding-success, Bridge `transfer.*`) enqueue jobs immediately. Without it on the API,
  enqueues fail and recovery falls back to `payout.sweep` — correct, but adds ~1 min (payouts) to
  ~5 min (payment events) of latency. Discovered running the slice-5 sandbox e2e (2026-07-21).

## Outstanding rotations (as of 2026-07-10)

- [x] Prod DB password (2026-07-10)
- [x] Bridge `sk-live` key — rotated by Joshua ~2026-07-12 (was exposed in a screenshot 7/08 and in
  stray local files). Old key confirmed dead (401). `scratch/bridge-smoke/.env` still holds the dead
  key — delete the file.
- [ ] Prod `service_role` legacy JWT
