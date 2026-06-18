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
```bash
npm test
```
Run from the repo root. All tests must pass. If a test was skipped with `.skip`, note it explicitly in the PR description.

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
