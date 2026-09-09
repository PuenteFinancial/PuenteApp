---
name: pr-prep
description: Run the full quality gate before creating a PR — typecheck, lint, test, then reviewers
---

Run this before opening any pull request. Execute steps in order — a failure at any step stops here.

## Step 1 — Typecheck
```bash
npm run typecheck
```
All three packages (api, mobile, shared) must pass. Fix all errors before continuing.

## Step 2 — Lint
```bash
npm run lint
```
Zero warnings allowed on new files. Existing warnings are pre-existing debt — don't add more.

## Step 3 — Tests

Run from the repo root, and KEEP THE OUTPUT:

```bash
pnpm run test 2>&1 | tee /tmp/puente-test-$(date +%H%M%S).log | tail -40
```

All tests must pass. If a test was skipped with `.skip`, note it explicitly in the PR description.

**Never pipe this suite straight into `grep`.** The api suite has a known
intermittent failure (~1 in 12, never in isolation — see the api DB-suite flake
note). A filter that shows only the summary lines throws away the one thing
worth reading: the name and diff of the test that failed. Re-running usually
goes green, and then the evidence is gone for good.

When a run does fail, before re-running:

```bash
grep -E "FAIL|✕|AssertionError|→|Expected|Received" /tmp/puente-test-*.log | head -40
```

Record the test name in the PR or the flake note even if the retry passes. A
second sighting is what turns an unexplained flake into a fixable one.

## Step 4 — Determine which reviewers are required

| Changed code | Required reviewer |
|---|---|
| Auth middleware, JWT handling, session logic | `security-reviewer` subagent |
| Credit score endpoint, FCRA consent, CRS API calls | `security-reviewer` subagent |
| Any route that moves money (ledger posts, draws, repayments) | `security-reviewer` subagent |
| Consent flows, adverse action notices, Metro 2 reporting | `compliance-reviewer` subagent |
| Both of the above | Run both |

If none of the above apply, skip to Step 5.

## Step 5 — PR description
Include:
- What changed and why (not what the code does — the diff shows that)
- Which reviewer subagents were run and their verdict
- Any `.skip`ped tests and why
- Any open follow-up items

## Gate summary

```
typecheck ✓ → lint ✓ → tests ✓ → reviewers (if required) ✓ → PR
```

A PR opened without passing all required gates will be flagged in review.
