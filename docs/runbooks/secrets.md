# Runbook — Secrets Map & Rotation

**Date:** 2026-07-10 · **Status:** live process

**Doppler is the source of truth**; everything else is a sync target or a deliberately-scoped
exception. No secret ever lands in git, client code, or logs (Gitleaks enforces on every PR/push).

## Where every secret lives

| Store | Configs / scope | Contents |
|---|---|---|
| Doppler `puente-api` | `dev_main`, `stg_main`, `prd_main` → synced to Railway envs | Supabase URL/keys, Bridge keys (sandbox in stg, live in prd), CRS, Sentry, `TRUST_PROXY_SOURCES` (optional — the code default covers Railway; the old `TRUST_PROXY_HOPS` is dead, delete it), **`PROXY_TRUST_SECRET`** (see the note below — the same value must be in `puente-web` at the same tier), `BRIDGE_WEBHOOK_PUBLIC_KEY`. **Slice-5 worker vars:** `DATABASE_URL` + `BRIDGE_TREASURY_WALLET_ID` (no defaults — the worker asserts both at boot) and `FLOAT_CEILING_MINOR` (no default — the submit job refuses to submit payouts without it); tuning knobs with code defaults, env-overridable: `FX_MAX_DRIFT_BPS` (200), `FX_MAX_QUOTE_AGE_MINUTES` (240), `WORKER_POLL_INTERVAL_SECONDS` (300), and (slice-7 debt pass) `BRIDGE_TIMEOUT_SECONDS` (15), `LOSS_CORRECTION_ALERT_MINOR` (20000 = $200), `LOSS_CORRECTION_WINDOW_DAYS` (7). `MOCK_FUNDING_WEBHOOK_SECRET` — HMAC for the mock funding processor's webhook + `/confirm`. **dev + stg only, never prd**: its absence 503s the funding webhook + confirm (the production lock against mock funding); present in dev/stg it lets you exercise the funding path against Bridge sandbox. Generate `openssl rand -hex 24`; the value must match on both the API and whatever fires the webhook (the `fire-funding-webhook` script / e2e). **Slice-7 var:** `ENABLE_DEV_ENDPOINTS` (`'true'`/`'false'`, code default `false`) — set `true` in **dev + stg only, never prd**. It is the second, independent control on `POST /v1/dev/transfers/:id/simulate-funding` (the web "Simulate payment" button standing in for Stripe): that route drives a transfer to `FUNDED` — a real ledger batch — with no real payment, so it needs BOTH this flag and `MOCK_FUNDING_WEBHOOK_SECRET`. It is deliberately not keyed on `NODE_ENV`, which nothing in this repo sets for the deployed API and which therefore fails open. **Without it set, the Simulate payment button 404s on staging** |
| Doppler `puente-web` | 3 configs → synced to Vercel | `INTERNAL_API_URL` + PostHog tokens (public), ~3 vars each. **`PROXY_TRUST_SECRET`** — see the note below; NOT `NEXT_PUBLIC_` |
| GitHub Actions — repo secrets | all workflows | `STAGING_DB_URL` (session-pooler string), `TURBO_TOKEN`, `TURBO_TEAM=puente-financial` |
| GitHub Actions — `production` environment secret | readable **only** inside the approval-gated Promote job | `PROD_DB_URL` (session-pooler string) |
| EAS environment variables (`eas env:set --scope project`) | mobile builds; per-environment (`production` / `preview` / `development`) | Expo/EAS-side **build-time** config. The app itself still calls no providers, so no runtime provider secrets live here. **`SENTRY_AUTH_TOKEN`** (`production` only, `--visibility secret` so it is write-only and unreadable afterwards) — used by the Xcode "Upload Debug Symbols to Sentry" phase, never shipped in the binary; get it from Sentry → Settings → Auth Tokens with `project:releases` scope, **not** from the Expo dashboard. Deliberately NOT in Doppler: Doppler syncs to Railway and Vercel, not EAS, and this is consumed only by the build. `simulator`/`preview` profiles set `SENTRY_DISABLE_AUTO_UPLOAD=true` in `eas.json` (a boolean, not a secret) and need no token |
| Local | `apps/api/.env` (staging + sandbox values), `apps/web/.env.local` (`INTERNAL_API_URL` + PostHog public only) | see `local-dev.md` |

Supabase DB passwords are **write-only** (reset-only in Database→Settings, new UI). Their only
consumers are the two pipeline secrets above.


### `PROXY_TRUST_SECRET` — the one secret that lives in BOTH projects

Set the **same value** in `puente-api` and `puente-web` at the **same tier**
(`stg_main` with `stg_main`, `prd_main` with `prd_main`). Different value per tier — a staging
leak must not authenticate against prod. Generate with `openssl rand -hex 32`.

It is how the API tells its own Next.js proxy from any other caller. `INTERNAL_API_URL` is a
public-internet hop, not a private network: the Railway host answers a stranger's
`GET /v1/health` with 200 (measured 2026-09-16). Web forwards the browser's real address in
`x-client-ip`, and that value becomes `consents.ip` — the E-SIGN record and the NACHA WEB-debit
authorization — plus `sign_in_events.ip`. Without the secret the API ignores those headers and
stores the socket address instead.

**Nothing breaks if it is missing, and that is the hazard.** Every request still succeeds; the
evidence just quietly becomes Vercel's egress address. The API logs a warning and raises one
Sentry issue at boot (`proxy-trust-secret-missing`) when it is unset on a deployed instance —
that page is the only signal.

**Order when rotating:** set the API side first, then web. The API accepts exactly one value, so
a web-first rotation makes it distrust the proxy for the gap between the two syncs. Confirm the
Railway service redeployed (see "Doppler → Railway" below — it normally redeploys itself, but
confirm rather than assume).

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
- **Twilio: not in Doppler at all, by design.** The API never calls Twilio — phone OTP goes through
  Supabase Auth, so GoTrue holds the account SID, auth token, and Messaging Service SID under
  **Authentication → Providers → Phone**, entered separately in the staging and prod projects.
  Rotating a Twilio credential means editing it there, in both, and nothing in Doppler or Railway
  changes. (Three unused `TWILIO_*` vars were declared in the API's env schema until 2026-08-05;
  they were read by nothing, so setting them looked like configuring SMS while doing nothing.)
- **Doppler → Railway: the sync DOES redeploy — corrected 2026-09-17.** This entry used to say
  "Railway does not restart on every var change", and planning a manual redeploy around that is
  how an operator ends up restarting prod services for no reason. **Measured:** a
  `doppler secrets set` on `puente-api/prd_main` at `15:46:24.832Z` redeployed **both** prod
  services (`@puente/api` and `puente-worker`) at `15:46:26/:27Z` — two seconds later, unprompted.
  Confirm it landed rather than assuming in either direction; the check is the same either way:

  ```bash
  railway deployment list -s <service> -e production -p <projectId>
  ```

  Measured on `puente-api` only. `puente-web` → Vercel is a different integration and was not
  tested here. **The API validates its whole env at boot** (`config/env.ts`), so until a service
  actually restarts a synced var is inert — which is what makes the confirmation worth doing.
- **A var that BOTH Railway services read must reach both.** The API and the worker are separate
  services with separate boots, so a half-applied change is a live skew, not a slow rollout: after
  the 2026-09-17 `FX_MAX_QUOTE_AGE_MINUTES` change, an API-only restart would have had the ops
  board offer a Release the worker would re-hold within the minute. Check the deployment list for
  **both**.
- **Restarting a service without shipping new code:** plain `railway redeploy` re-runs the
  **existing** deployment. Never add `--from-source` on production — that pulls the latest commit
  from the configured branch, which is a deploy, not a restart. Verify what is actually serving
  with `/v1/health`, which reports the short commit; it must match `origin/production`. Note the
  `railway` CLI links to **staging** by default (`railway status`), so pass `-e production`
  explicitly rather than relying on the linked environment.
- **`DATABASE_URL` goes to BOTH Railway services (API + worker), not just the worker.** (Both
  services now run in **both** environments — the prod worker went live 2026-08-17, see
  `deploy-and-promote.md`.) It's the
  Supabase **session-mode** pooler string (port 5432, never transaction mode 6543 — pg-boss needs
  session semantics). The worker asserts it at startup; the **API needs it too** so money-moving
  webhooks (funding-success, Bridge `transfer.*`) enqueue jobs immediately. Without it on the API,
  enqueues fail and recovery falls back to `payout.sweep` — correct, but adds ~1 min (payouts) to
  ~5 min (payment events) of latency. Discovered running the slice-5 sandbox e2e (2026-07-21).

### Stripe (funding rails + crypto onramp, #213 / K3–K6)

All in Doppler `puente-api`, server-only — the web app never holds a Stripe var (the publishable
key reaches the browser through `GET /v1/transfers/:id/funding-session` and, since K6,
`GET /v1/config/web`). Which vars are REQUIRED is decided by `FUNDING_PROCESSOR`
(`config/env.ts` superRefine):
- `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, `STRIPE_PUBLISHABLE_KEY` — the platform trio;
  required for `stripe`, `stripe_onramp`, `stripe_crypto`. Test-mode keys in `dev_main`/`stg_main`,
  live in `prd_main`. Mode (sandbox vs live) is *which platform key*, nothing else.
- `STRIPE_CRYPTO_OAUTH_CLIENT_ID` (`lwlpk_…`) + `STRIPE_CRYPTO_OAUTH_CLIENT_SECRET` (`lwlsk_…`) —
  the Link OAuth pair for the embedded-components onramp; required only for `stripe_crypto`.
  ONE pair works in both test and live (Stripe, 2026-08-28); it is in `stg_main` AND `prd_main`.
  The secret is used solely in the refresh grant at `login.link.com`; rotate by minting a new pair
  in the Stripe dashboard, setting both values, and redeploying — users' stored refresh tokens
  survive a pair rotation. **Undocumented until 2026-09-03** (audit debt).
- `STRIPE_CRYPTO_VERSION` — the preview version header (code default
  `2026-05-27.preview;crypto_onramp_beta=v2`); override only when Stripe moves the preview.
- `STRIPE_LINK_TOKEN_KEY` (if present in your config) — see `utils/encryption.ts`: the AES-256-GCM
  key for `stripe_link_tokens.refresh_token_enc`. Rotating it invalidates every stored refresh
  token (users re-run Link OTP at their next send) — never rotate casually.

## Outstanding rotations (as of 2026-07-10)

- [x] Prod DB password (2026-07-10)
- [x] Bridge `sk-live` key — rotated by Joshua ~2026-07-12 (was exposed in a screenshot 7/08 and in
  stray local files). Old key confirmed dead (401). `scratch/bridge-smoke/.env` still holds the dead
  key — delete the file.
- [ ] Prod `service_role` legacy JWT
