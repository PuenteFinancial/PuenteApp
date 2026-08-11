#!/usr/bin/env bash
#
# Run expo-doctor and fail only on failures we have not already accounted for.
#
# expo-doctor exits non-zero if ANY of its 20 checks fails, and apps/mobile has
# failures that are correct and expected (expo-doctor-known-failures.txt). A plain
# pass/fail gate would be red forever and get ignored within a week.
#
# Asserting a failure COUNT instead would be worse than useless: a count cannot say
# WHICH checks failed, so a benign failure being fixed silently pays for a real one
# appearing and the total never moves. It is also environment-dependent — the same
# checkout produced 6 failures and then 2 on one machine in one session, purely
# because corepack had provisioned a real `npm` in between.
#
# So: gate on check NAMES. Anything failing that is not in the allowlist is a new
# problem. Anything in the allowlist that stops failing is fine and needs no edit.
set -euo pipefail

cd "$(dirname "$0")/.."

# expo-doctor's failure lines are matched on the literal ✖ prefix, so make sure
# nothing wraps them in ANSI colour codes.
export NO_COLOR=1
export FORCE_COLOR=0

allowlist='expo-doctor-known-failures.txt'
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

# Read the output, not the exit status — non-zero here is the normal case.
# An optional argument substitutes a saved log for the live run, so the parsing
# below can be exercised against captured output (a runner with a real npm, a
# machine with npm shimmed, a synthetic new failure) without needing to reproduce
# each environment.
if [ $# -ge 1 ]; then
  cp "$1" "$work/doctor.log"
else
  npx expo-doctor > "$work/doctor.log" 2>&1 || true
fi
cat "$work/doctor.log"

# A check that could not RUN is reported as ✖ but also prints "Unexpected error
# while running '<name>' check:". That is what happens when expo-doctor shells out
# to `npm explain` and npm is a corepack shim refusing to run (the root
# package.json sets packageManager: pnpm). Tolerate checks that errored out that
# way; gate on the ones that actually reached a verdict.
{ grep -o "Unexpected error while running '[^']*' check" "$work/doctor.log" || true; } \
  | sed "s/^Unexpected error while running '//; s/' check$//" \
  | LC_ALL=C sort -u > "$work/errored.txt"

{ grep '^✖' "$work/doctor.log" || true; } \
  | sed 's/^✖ //' \
  | LC_ALL=C sort -u > "$work/failed.txt"

{ grep -v -e '^[[:space:]]*#' -e '^[[:space:]]*$' "$allowlist" || true; } \
  | LC_ALL=C sort -u > "$work/known.txt"

LC_ALL=C comm -23 "$work/failed.txt" "$work/errored.txt" \
  | LC_ALL=C comm -23 - "$work/known.txt" > "$work/unexpected.txt"

if [ -s "$work/unexpected.txt" ]; then
  echo
  echo "expo-doctor reported a check failure that is not known-benign:"
  sed 's/^/  ✖ /' "$work/unexpected.txt"
  echo
  echo "Fix it — or, if it is genuinely benign, add the check name verbatim to"
  echo "apps/mobile/$allowlist with a comment saying why."
  exit 1
fi

echo
echo "expo-doctor: no failing check outside apps/mobile/$allowlist"
