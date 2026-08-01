# Runbook — Stuck Transfer

**Date:** 2026-07-10 · adopted 2026-08-01 (slice-8 O1) — graduated from `proposals/`.
**Mechanism:** the `transfers.stuck-watch` worker cron (pg-boss, **every 5 minutes**,
`apps/api/src/jobs/stuck-watch.ts`) sweeps the non-terminal states and pages one Sentry issue
per **(transfer, state, entry) episode** — fingerprint `['stuck-transfer', id, state,
enteredAt]`, warning level, with the state-entry time and last-transition actor/reason in the
context. The 5-min re-fire while stuck collapses into the same issue; resolving it while the
transfer is still stuck reopens next tick; a round trip back into the same state is a new
episode with its own issue. Detection only — every repair below is a human action.

A transfer is "stuck" when it stops moving, not when it's merely slow. Dwell thresholds
(env-tunable, hard code defaults — see `.env.example`):

| State | Expected dwell | Pages after | Knob |
|---|---|---|---|
| `PENDING_PAYMENT` | minutes (user paying) | never — the 30-min auto-fail cron owns it (O2's daily audit watches THAT cron's liveness) | — |
| `FUNDED` | seconds (gate + submission) | 15 min | `STUCK_FUNDED_AFTER_MINUTES` |
| `SUBMITTED` | seconds–minutes (Bridge accepts) | 30 min | `STUCK_SUBMITTED_AFTER_MINUTES` |
| `IN_FLIGHT` | seconds (SPEI settles in seconds) | 1 h | `STUCK_IN_FLIGHT_AFTER_MINUTES` |
| `UNDER_REVIEW` | days (human review) | 24 h — calendar-blind "1 business day"; its page points at `pending-cancellation.md` / `resolve-cancellation` | `STUCK_UNDER_REVIEW_AFTER_HOURS` |

**A CLAIMED FUNDED row (`submit_attempted_at` set) is never exempt:** payout-submit skips
every wait gate on crash recovery — the only safe move is the idempotent re-POST — so a
claimed row that dwells is genuinely stuck and always pages.

**Deliberate FUNDED waits never page** (mirrored exactly from payout-submit's skip ladder,
unclaimed rows only):
ops holds (`payout_hold_reason` — they paged at hold time; see `payout-holds.md`), and the
three no-hold waits from decisions.md 2026-07-31 — `WAIT_FOR_CLEARING`, the
`FIRST_TRANSFER_HOLD` unproven-sender wait, and the O3 uncleared-cap wait (an older uncleared
send by the same user; note the OLDER blocker itself **does** page if it exceeds its own
dwell, which is exactly what you want to look at). O2's daily 8-day uncleared audit bounds
all of these.

The read-only ops page at `/dashboard/ops` (8.5-v1, admin-allowlisted) lists every open
transfer with dwell, threshold, and wait annotations — the same clocks as this cron, but as a
board, not a pager.

**Overlapping alerts are separate questions, deliberately not deduped:** this cron = "is OUR
pipeline stuck"; payout-poll's `payout-in-review-stale` = "is Bridge holding it >1h"; O2's
daily `transfer_aging` = the coarse audit backstop. One incident can page two of these.

## First: diagnose, don't touch

1. The page's context carries the state-entry time and the last transition's actor/reason —
   start there. Pull the full `transfer_transitions` history for the shape of the story.
2. Check `payment_events` for the transfer: did we **receive** the webhook we're waiting for?
   - Event received but state didn't advance → worker problem: check pg-boss for a
     failed/retrying job and Sentry for the error. Fix, then let the retry drive the transition.
   - No event → provider side: check the provider dashboard directly.
3. Provider truth:
   - Stuck `FUNDED` (none of the deliberate waits): check the worker gate — float ceiling hit
     (`float-ceiling` page alongside)? Job queue dead? A gate blocking on the float ceiling is
     *working as designed* — decide whether to raise the ceiling, not whether to bypass the gate.
   - Stuck `SUBMITTED`/`IN_FLIGHT`: `GET /v0/transfers/{provider_transfer_ref}` — Bridge's
     actual state vs ours, and Bridge webhook delivery logs (`GET /v0/webhooks/{id}/logs`) —
     delivery has been empirically flaky before (2026-07-13 incident).

## Repair actions (in order of preference)

1. **Missed webhook, provider is terminal** → replay through the normal worker path
   (idempotent — `payment_events` dedupe + ledger `(transfer_id, transition)` uniqueness).
   payout-poll does this automatically every few minutes; the daily reconciliation
   (`reconciliation.md`) is the backstop. Doing it manually is just doing it sooner.
2. **Failed job** → fix the cause, let pg-boss retry. Never hand-advance the state without the
   ledger post — state and ledger move together or not at all.
3. **Bridge `in_review`** (their AML hold): nothing to repair on our side. Contact Bridge
   support if > 24h; the transfer stays `SUBMITTED`/`IN_FLIGHT` with truthful pending copy.
4. **Bridge `refund_failed`**: principal stuck at Bridge after a failed payout. Open a Bridge
   support ticket immediately; the sender's refund must not wait for Bridge — decide whether
   to front the refund from float (`manual-refund.md`), and reconciliation tracks the open
   `due_from_bridge` until Bridge actually returns the money.
5. **UNDER_REVIEW aging**: the queue is `cancellation_requests` — work it with
   `resolve-cancellation` per `pending-cancellation.md`. The 24h page is a nag, not a
   statutory clock (that arrives with counsel's error-resolution process).
6. **Nothing works and the sender is harmed** → treat as an error-resolution case even
   without a formal dispute: refund per the `PAYOUT_FAILED` postings.

## Never

- Never `UPDATE transfers SET state = …` directly — every transition goes through code that
  writes `transfer_transitions`, the ledger post, and the audit log, or via a script that
  does all three.
- Never re-submit to Bridge with a **new** idempotency key "to unstick it" — that's how a
  payout doubles. Reuse the stored key; a true resubmission decision requires confirming with
  Bridge that the original is dead.
- Never mark `COMPLETED` from a dashboard screenshot — require Bridge's API state
  (`payment_processed`).
