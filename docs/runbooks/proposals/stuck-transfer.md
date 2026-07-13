# Runbook — Stuck Transfer

**Date:** 2026-07-10 · **Status:** ⚠️ **PROPOSAL — not adopted.** Drafted unprompted during design review; the ops process itself is undecided.
**Trigger:** a transfer sits in a non-terminal state past its expected dwell time, or a
`refund_failed` / prolonged `in_review` alert fires from the Bridge webhook handler.

A transfer is "stuck" when it stops moving, not when it's merely slow. Expected dwell times:

| State | Expected dwell | Stuck after |
|---|---|---|
| `PENDING_PAYMENT` | minutes (user completing payment) | 30 min — **cron auto-marks `PAYMENT_FAILED`** (no ops action; user re-quotes) |
| `FUNDED` | seconds (gate check + submission) | 15 min |
| `SUBMITTED` | seconds–minutes (Bridge accepts) | 30 min |
| `IN_FLIGHT` | seconds (SPEI is 24/7, settles in seconds) | 1 hour |
| `UNDER_REVIEW` | days (human investigation) | statutory deadlines — see error-resolution runbook |

## First: diagnose, don't touch

1. Pull the transfer's `transfer_transitions` — where did it stop, and what actor made the last move?
2. Check `payment_events` for the transfer: did we **receive** the webhook we're waiting for?
   - Event received but state didn't advance → worker problem: check the job queue (pg-boss) for a
     failed/retrying job, and Sentry for the error. Fix, then let the retry drive the transition.
   - No event → provider side: check the provider dashboard directly.
3. Provider truth:
   - Stuck `FUNDED`: check the worker gate — float ceiling hit (`limit_exceeded` in logs)? Job queue
     dead? The gate blocking on the float ceiling is *working as designed* — decide whether to raise
     the ceiling, not whether to bypass the gate.
   - Stuck `SUBMITTED`/`IN_FLIGHT`: `GET /v0/transfers/{provider_transfer_ref}` — Bridge's actual
     state vs ours. Also check Bridge webhook delivery logs (`GET /v0/webhooks/{id}/logs`) — Bridge
     webhook delivery has been empirically flaky (status 0 incidents, 2026-07-10).

## Repair actions (in order of preference)

1. **Missed webhook, provider is terminal** → replay: process the provider's current state through
   the same worker code path (idempotent — `payment_events` dedupe + ledger `(transfer_id,
   transition)` uniqueness make this safe). This is what daily reconciliation does automatically;
   doing it manually is just doing it sooner.
2. **Failed job** → fix the cause, let pg-boss retry. Never hand-advance the state without the
   ledger post — state and ledger move together or not at all.
3. **Bridge `in_review`** (their AML hold): nothing to repair on our side. Contact Bridge support if
   > 24h; keep the sender informed (truthful pending copy); the transfer stays `SUBMITTED`/`IN_FLIGHT`.
4. **Bridge `refund_failed`**: principal is stuck at Bridge after a failed payout. Open a Bridge
   support ticket immediately; the sender's refund must not wait for Bridge — decide whether to front
   the refund from float (post `refunds_payable` → pay from `cash_clearing`; `due_from_bridge` stays
   open until Bridge actually returns the money, and reconciliation tracks it).
5. **Nothing works and the sender is harmed** → treat it as an error-resolution case (see that
   runbook) even if the sender hasn't formally disputed: refund per `PAYOUT_FAILED` postings.

## Never

- Never `UPDATE transfers SET state = …` directly — every transition goes through code that writes
  `transfer_transitions`, the ledger post, and the audit log, or via a script that does all three.
- Never re-submit to Bridge with a **new** idempotency key "to unstick it" — that's how a payout
  doubles. Reuse the stored key; a true resubmission decision requires confirming with Bridge that
  the original is dead.
- Never mark `COMPLETED` from a dashboard screenshot — require Bridge's API state (`payment_processed`).

## Alerting (to wire up in Sentry/cron)

- Cron sweep: any transfer past its stuck-after threshold → Sentry alert with transfer id + state + age.
- Webhook handler: `refund_failed` or `in_review` observed → immediate alert.
- Float ceiling ≥ 80% of the configured cap → warning (pre-empts stuck-`FUNDED` pileups).
