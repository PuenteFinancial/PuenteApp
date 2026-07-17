---
name: codex-review
description: Second-model review — run OpenAI Codex headless over the branch diff and relay its findings VERBATIM before any Claude commentary. Use before opening a PR on financial/auth slices, or whenever an independent second opinion on a diff is wanted.
---

Run an independent Codex review of the current branch and relay it faithfully.

## Why this exists

Claude reviewing Claude has correlated blind spots. Codex is the independent
second opinion — but it's only independent if its output reaches Joshua
unfiltered. The output contract below is the point of this skill; follow it
exactly.

## Preflight

1. `command -v codex` — if missing, STOP and tell Joshua to run:
   - `npm i -g @openai/codex` (or `brew install --cask codex`)
   - `codex login` (interactive browser auth — he must do this himself)
   Do not install or authenticate on his behalf.

## Steps

2. Determine the diff range:
   - default: `origin/main...HEAD` (run `git fetch origin main --quiet` first)
   - `$ARGUMENTS` may override with an explicit range or a PR number
     (for a PR: `gh pr diff <n>` written to a file, reviewed from that file)

3. Run Codex non-interactively from the repo root, read-only, with a
   generous timeout (reviews can take several minutes — use run_in_background
   if needed):

   ```bash
   codex exec --sandbox read-only \
     "Review the changes in \`git diff <RANGE>\` in this repo as a senior
      reviewer. Repo standards live in CLAUDE.md (money handling, PII,
      security rules) — enforce them. Report only real, reachable issues:
      correctness bugs, security problems, money-math errors, missing
      idempotency, PII leaks. For each finding give file:line, severity
      (P0/P1/P2), and a concrete failure scenario. No style nits, no
      compliments. If you find nothing, say so plainly." \
     > <scratchpad>/codex-review-$(date +%s).md
   ```

4. **Output contract — non-negotiable:**
   - Save raw stdout to the scratchpad file and give Joshua the path so he
     can read the unfiltered original himself.
   - In the reply, quote Codex's findings **verbatim and complete** in a
     fenced block FIRST — no summarizing, no reordering, no omissions, even
     if the output is long or Claude believes a finding is wrong.
   - Only AFTER the verbatim block, add a clearly separated **"My take"**
     section: agree/disagree per finding, with evidence (file:line, test
     names, runtime proof).
   - Where Claude disagrees with Codex, say so prominently — disagreement
     between the two models is Joshua's strongest signal to read that code
     personally. Never quietly drop a Codex finding.

5. If findings warrant fixes, propose them but do not apply until Joshua
   responds (this skill is a review checkpoint, not a fix loop).
