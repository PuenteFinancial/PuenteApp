# Runbook — Dependency Management

**Date:** 2026-07-20 · **Status:** live process (cooldown config shipped in PR #60)

Dependabot opens grouped PRs on a weekly schedule (**Mondays 09:00 Denver**), configured in
`.github/dependabot.yml`. pnpm's release-age policy and a few Expo constraints make the workflow
less obvious than it looks — the gotchas below each cost time once.

## pnpm release-age policy vs Dependabot

- CI installs enforce pnpm's `minimumReleaseAge` (24h, pnpm default — no repo config sets it).
  A package published <24h ago fails install with `ERR_PNPM_MINIMUM_RELEASE_AGE_VIOLATION`.
- Dependabot therefore runs with `cooldown: default-days: 3` on the npm ecosystem, so the versions
  it picks are always old enough to install.
- **`@dependabot recreate` does NOT re-resolve versions** — it reuses the versions the PR was
  originally opened with. A PR that resolved a too-fresh version can't be salvaged by recreate:
  close it and let the next scheduled run open a fresh, compliant one.
- Dependabot auto-rebases (`rebase-strategy: auto`) used to refresh to newest versions on every
  rebase, resetting the 24h clock mid-review — the cooldown prevents this now.

## Expo constraints

- `expo*` majors and `react-native-screens` are in the Dependabot ignore list — the Expo SDK pins
  these; they only move when the SDK itself is upgraded.
- **CI never builds the mobile app**, so an Expo-SDK-incompatible bump (e.g. SDK 57 packages into
  the SDK 56 app) passes CI green. Check expo-adjacent package majors manually before merging.

## Deferred major migrations

Closed deliberately (no ignore rule, so Dependabot will re-open on the *next* major — treat as a
signal to schedule the migration, not to merge):

- **eslint 9 → 10** — breaks web lint ("Failed to patch ESLint" compat shim).
- **typescript 5.9 → 7** — new type errors in mobile + web.

Both are real migration tasks, not routine bumps.

## Merging a Dependabot PR

1. CI green is necessary but not sufficient (see Expo caveat above).
2. Groups: `expo`, `react-native`, `fastify`, `typescript-tooling`, `misc` — one PR each, batched
   across a directory. A separate weekly config covers GitHub Actions bumps.
3. Squash-merge as usual; if several grouped PRs are open, merge one, let Dependabot rebase the
   rest (the cooldown keeps versions stable through rebases).
