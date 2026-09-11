# Failure-path evidence inventory

**Date:** 2026-09-11 · **Scope:** every non-happy path in the money pipeline
**Readable version:** https://claude.ai/code/artifact/47217da3-9dfc-4fd0-94e6-6fa7e0bea25b
**Why this exists:** on 2026-09-10 a dispute that arrived two seconds before its funding event
would have funded a transfer nobody knew was disputed. 1,886 unit tests passed while that was
true. One staging drive found it in a single run.

So this is not a coverage report. Coverage says a line executed under mocks we wrote. This asks a
harder question: **has this path ever actually run, and against what?**

## The tiers

Ordered by how much they would have caught.

| Tier | Means | What it cannot tell you |
|---|---|---|
| **Live** | Happened in production with real money. | Nothing. This is the only tier that is not a simulation. |
| **Driven** | A real provider event exercised the real code end to end on staging. | Whether prod config (webhook subscriptions, Dashboard settings) matches. |
| **DB** | Ran against real Postgres: real constraints, real triggers, real ledger. | Whether the provider actually sends what we think it sends. |
| **Unit** | Mocks only. Proves intent, not integration. | Ordering between real events, real provider payloads, real constraints. |
| **None** | Code exists. Nothing has ever executed it. | Everything. |

**Unit is where the bugs were.** Both defects found on 2026-09-10 lived in paths with unit
coverage that passed.

## Funding — collecting the money

| Path | Mechanism | Evidence |
|---|---|---|
| Card declined at confirm | `payment_intent.payment_failed` acked as unhandled; the session is the unit, so a decline does NOT kill the transfer | **Driven** — `4000000000000002`, staging, 2026-09-10 |
| ACH fails before settlement | `checkout.session.async_payment_failed` → `PAYMENT_FAILED`, no ledger | **Unit** — never driven |
| Sender abandons the pay step | Rail-aware reaper; the processor's session is expired FIRST, `not_open` aborts the fail | **Driven** — 6 sessions reaped at the 4h clock, staging |
| Stale tab pays after the reap | `expireFunding` closes the session so a mounted Element cannot take money for a failed row | **Unit** — the reaper half is driven, this half is not |
| Onramp session rejected | `failRejectedOnrampSessions` polls; there is no rejection webhook | **Unit** |
| Sender edits the onramp amount | Amount guard refuses; nothing applied, payout not released | **Unit** |

## Identity

| Path | Mechanism | Evidence |
|---|---|---|
| Bridge rejects the sender | `GET /users/me/kyc-rejection`, bounded retries, 429 at the ceiling | **None** — and unreachable. Bridge's sandbox will not simulate a rejection, so the drive script says live-pilot-only. Real senders WILL hit this. |
| Sender not yet approved at payout | `sender_kyc_pending` hold; auto-released by Bridge's approval webhook | **Driven** |
| SPEI endorsement missing | Bridge 403 `missing_required_endorsements` on CLABE registration → `endorsement_missing` | **Driven** — probed directly, and the recovery observed when the endorsement landed |
| Duplicate external account | Adopt the existing account; refuse when the last-4 match is ambiguous | **DB** |

## Payout

| Path | Mechanism | Evidence |
|---|---|---|
| Destination not registered | `payability` hold; auto-released when a late registration succeeds | **Driven** — 4 transfers, staging |
| Bridge rejects the payout | `PAYOUT_FAILED`, then the refund tail | **DB** |
| Treasury wallet drained | Bridge sync 400; retries freely until the ceiling, then `submit_error` | **Driven** — sandbox, 2026-07-15, real 400, no overdraw |
| Retry ceiling exhausted | `submit_error` hold after 30 min of 400s | **Unit** |
| FX drift or stale quote | `fx_drift` hold, no claim, no Bridge call | **Unit** |
| Velocity / amount limits | `velocity_review` hold at submit; 403 at confirm | **DB** |
| Float ceiling tripped | No hold by design; the sweep retries as exposure drains | **DB** |
| Uncleared-exposure cap | No hold; older-wins ordering makes it deterministic | **DB** |

## Delivery and after

| Path | Mechanism | Evidence |
|---|---|---|
| Refund after payout failure | Two balanced batches; single-disburser claim | **DB** |
| Refund bounces | `refund_failed` pages; sender still owed, never auto-adjusted | **Unit** — never driven |
| Cancel before the payout claims | `CANCELED` → void → `REFUNDED`; rests at `CANCELED` on human-disbursement rails | **DB** |
| Cancel after delivery | `UNDER_REVIEW`; correction batch to its own loss account | **DB** |
| Dispute BEFORE the money lands | Mark the transfer, freeze the sender, book nothing; the funding event catches up and holds | **Driven** — this is the bug the drive found |
| Dispute before delivery | `funding_disputed` hold, freeze, book nothing | **Driven** — staging, 2026-09-10 |
| Dispute AFTER delivery | `FUNDING_REVERSED` + the loss batch | **DB only** — the drive cannot reach it. Stripe raises the test dispute seconds after the charge; our payout takes up to a minute, so the dispute always wins that race. |
| ACH return after settlement | Same path as a dispute | **DB** — never seen as an actual ACH return |
| A dispute webhook never arrives | `stripe_disputes` recon check, 60-day window | **Unit** |

## Platform

| Path | Mechanism | Evidence |
|---|---|---|
| Worker dies silently | Sentry cron monitor; 3 missed beats ≈ 17 min | **Live** — the 22h staging outage is why it exists; green in prod and staging today |
| Webhook event unsubscribed | Nothing tells us. The smoke asserts the required set | **Live** — `charge.dispute.created` was found missing on staging, 2026-09-10 |
| Funding and clearing race | Row-lock ordering; both legs always post | **DB** |
| Idempotency conflict | 409; one of two concurrent claims wins | **DB** |
| Quote expires mid-flow | 409 `quote_expired`; status settled without a write | **DB** |
| Frozen sender has no way back | `unfreezeSender` + notice | **DB** |

## Documented but never written

`docs/transfer-state-machine.md` shows four entry points into `UNDER_REVIEW`. **Only one exists in
code.**

- `COMPLETED → UNDER_REVIEW` — written by the cancellation tail.
- `FUNDED → UNDER_REVIEW` — **no writer.**
- `SUBMITTED → UNDER_REVIEW` — **no writer.**
- `IN_FLIGHT → UNDER_REVIEW` — **no writer.**

A Reg E error claim on a transfer that is funded but not yet delivered has nowhere to go. That is
the window a real dispute is most likely to arrive in, because the sender is still waiting.

## Ranked gaps

1. **Bridge rejection has never run and cannot be driven.** Real senders will be rejected. The
   whole path is unexercised, and the sandbox cannot fix that.
2. **Three of four `UNDER_REVIEW` doors do not exist.** Documented, diagrammed, absent.
3. **The loss booking has only ever run against a database.** Never against a real dispute,
   because of a timing race that cannot be arranged in test mode.
4. **Refund bounces are unit-only.** The sender is still owed money and a human must act.
5. **ACH pre-settlement failure is unit-only** on the rail we most want senders using.

## How to close one

Drive it. Both 2026-09-10 defects were found by a drive and neither by tests. Where a drive cannot
reach (Bridge rejection, the post-delivery dispute), a database test is the next best tier, and the
gap should be written down here rather than assumed covered.
