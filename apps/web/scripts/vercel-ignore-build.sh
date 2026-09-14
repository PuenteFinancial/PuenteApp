#!/usr/bin/env bash
#
# Vercel Ignored Build Step for @puente/web — don't rebuild the web app for a
# commit that cannot have changed it.
#
# Every push to every branch in this repo builds this Next.js app and stores its
# function bundles, and those bundles are what Vercel meters as Functions
# Storage: roughly 16 MB per deployment, kept for the 30-day retention window.
# 464 deployments in the 30 days to 2026-09-14 is how a landing page with two
# functions reached 7.5 GB of a 10 GB free-tier allowance. Most of those builds
# were an apps/api fix or a Dependabot bump for apps/mobile — nothing that any
# preview URL would render differently.
#
# Exit codes are Vercel's, and they are the opposite of a shell's instinct:
#   exit 1 -> build (the deployment proceeds)
#   exit 0 -> skip  (deployment is marked CANCELED, no bundles are stored)
#
# Every unexpected path must therefore exit 1. A wrong build costs a build. A
# wrong skip leaves a preview URL silently serving older code, which is the kind
# of thing you only notice after debugging the wrong thing for an hour.
#
# Runs from the Root Directory (apps/web) BEFORE the install step, so there is no
# node_modules and no `pnpm exec turbo` — npx fetches turbo-ignore, which infers
# the pinned turbo version from package.json and asks turbo's own dependency
# graph whether @puente/web or anything it depends on changed.

# Deliberately no `-e`: turbo-ignore exits 1 on the common, correct path and we
# need to read that status rather than die on it.
set -uo pipefail

# Production is never skipped, for two reasons that both fail silently:
#   - promote.yml fast-forwards `production` to `main` and the drill that follows
#     expects a fresh deployment to verify; a CANCELED one has no URL to check.
#   - an env var synced from Doppler changes no files, so turbo sees no diff.
#     Prod picking up a new secret must never depend on a code change landing.
if [ "${VERCEL_ENV:-}" = 'production' ] || [ "${VERCEL_GIT_COMMIT_REF:-}" = 'production' ]; then
  echo 'ignore-build: production deployment — building'
  exit 1
fi

# No arguments beyond the workspace: turbo-ignore compares against
# VERCEL_GIT_PREVIOUS_SHA (this project's last successful deployment) and falls
# back to HEAD^ when there isn't one, which is the right comparison in both cases.
npx --yes turbo-ignore @puente/web
status=$?

case "$status" in
  0) echo 'ignore-build: @puente/web unaffected — skipping'; exit 0 ;;
  1) echo 'ignore-build: @puente/web affected — building'; exit 1 ;;
  *) echo "ignore-build: turbo-ignore exited $status — building anyway"; exit 1 ;;
esac
