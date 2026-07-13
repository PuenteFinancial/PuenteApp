# New Engineer Onboarding

**Date:** 2026-07-13 · **Status:** v1

Start with the [README](../README.md) if you haven't. This doc is the part that can't be
self-served: access, policy, and a first-week plan.

## Access checklist

Joshua grants everything below. Ask for the minimum tier that unblocks you — several of these
deliberately have no "full access" tier for anyone but him.

| System | What you need | Notes |
|---|---|---|
| GitHub (`PuenteApp` repo) | Write | `production` environment reviewer stays Joshua-only (it gates the Promote workflow) |
| Doppler | `puente-api` **dev_main** + `puente-web` dev config | Staging/prod configs only when you need them; secrets are synced from here to everything else |
| Supabase | `puente-staging` project (dev + staging, no real data) | **`PuenteApp` project is PROD with live data — no default access** |
| Railway | Staging service | Prod service view-only at most |
| Vercel | Team member | Prod env vars are write-only anyway; branch-tracking settings are load-bearing — don't touch without reading the deploy runbook |
| Bridge dashboard | Sandbox (sk-test) | **Live keys (sk-live) are Joshua-only — see policy below** |
| Stripe | Sandbox/test mode | Live mode Joshua-only |
| PostHog | Member (org "Puente") | Analytics + feature flags |
| Sentry | Member | Error monitoring for API + web |
| Twilio | None usually | SMS goes through Supabase Auth; dashboard access only for OTP/spend debugging |

## The credentials policy (read this one)

**Live-money credentials never leave Joshua:** Bridge `sk-live`, Stripe live keys, the prod DB
password, and the prod `service_role` JWT. This is deliberate isolation, not a trust statement — it
also applies to Claude Code sessions (the live Bridge key was rotated specifically so agent sessions
can't see it). Practical consequences:

- Anything that needs live-key output (e.g. pulling a production Bridge transfer's `receipt`) is a
  Joshua-run step. Design your work to hand him a one-liner to run.
- Local dev points at staging + sandboxes by default and that's the only supported configuration
  ([runbooks/local-dev.md](runbooks/local-dev.md)).
- If you ever see a live credential somewhere it shouldn't be (a screenshot, a scratch file, a log),
  say so immediately — the response is rotation, not embarrassment. It has happened; the runbook
  ([runbooks/secrets.md](runbooks/secrets.md)) has the procedure.

## First day

- [ ] Access checklist above (at least GitHub, Doppler dev, staging Supabase).
- [ ] Clone, `pnpm install`, `pnpm run typecheck`, `cd apps/api && pnpm test` — all green.
- [ ] Run the stack locally against staging ([runbooks/local-dev.md](runbooks/local-dev.md)),
      sign up with a Supabase test phone number, and click through onboarding.
- [ ] Read CLAUDE.md end to end. The security and money rules are non-negotiable and short.

## First week

- [ ] Work through the README reading order (architecture → state machine → ERD → ledger → API
      contract → flows). The ledger doc is the one to slow down on.
- [ ] Read the [glossary](glossary.md) once so the compliance vocabulary stops being noise.
- [ ] Skim the [decision log](decisions.md) — it's the "why" for everything that looks odd.
- [ ] Trace one webhook end to end in code: `apps/api/src/routes/v1/webhooks.ts` → signature
      verification → `payment_events` dedupe → state change. This path is the heart of the system.
- [ ] Watch (or run, with Joshua) one staging deploy + the verification drill in
      [runbooks/deploy-and-promote.md](runbooks/deploy-and-promote.md).
- [ ] Ship something small end to end — a copy fix or test gap is fine. The goal is exercising the
      PR → checks → staging pipeline, not the size of the change.

## Who to ask

Solo-founder-engineer phase: Joshua is the answer to "who owns X" for everything. The compliance
material (Reg E, disclosures) additionally goes through counsel before launch — don't ship
user-facing consent/disclosure changes on your own judgment.
