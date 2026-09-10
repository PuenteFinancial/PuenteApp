# Runbook — Funding Reversal (ACH return / chargeback after payout)

**Date:** 2026-07-10 · **Status:** ⚠️ **PROPOSAL — not adopted.** Drafted unprompted during design review; the ops process itself is undecided.
**Trigger:** Stripe webhook reports an ACH return (or, later, a card chargeback) on a transfer that
already reached `COMPLETED` — the MXN is delivered and unrecoverable; the USD that funded it just
bounced. State: `COMPLETED → FUNDING_REVERSED`. This is Puente's real loss path — the risk the
instant-payout MVP deliberately accepts at trusted-user scale.

ACH returns can arrive up to **~60 days** post-delivery (unauthorized-debit returns, R05/R07/R10/R11);
NSF-style returns (R01/R09) usually land within 2 business days. Industry recovery on fraudulent
returns is poor (~25%) — speed matters.

*(A return that arrives **before** payout is not this runbook — pre-payout the transfer simply fails
funding: cancel the submission if still gated, refund path if needed, no loss.)*

## Immediate (same day)

1. Confirm the handler did its job. **As of 2026-09-10 this step is real** — `applyFundingReversed`
   writes the state and the posting automatically, so you are checking its work, not doing it:
   - **Delivered (was `COMPLETED`)** — transfer is now `FUNDING_REVERSED`, ledger posted
     `DR loss_funding_reversed` / `CR cash_clearing` (or `CR funding_receivable` when the funding
     had never cleared — ledger-rules.md), transition logged.
   - **Not yet delivered (was `FUNDED`)** — no posting at all, and the payout is held on
     `funding_disputed`. Nothing was lost; do not book anything.
   - **Already at Bridge (`SUBMITTED`/`IN_FLIGHT`)** — nothing could be stopped or booked. This is
     the arm that needs you most: watch the payout resolve, then treat it as delivered or failed.
   The sender is frozen automatically in every one of those cases.
   If the webhook never arrived at all, the `stripe_disputes` reconciliation check pages it (60-day
   window) — process it through the normal code path first.
2. Read the return code in the Stripe event — it decides the path:
   - **R01/R09 (NSF)** — likely innocent. Re-presentment may be possible; the user probably just
     needs to fund their account.
   - **R05/R07/R10/R11 (unauthorized/revoked)** — treat as possible fraud or account takeover.
   - **R02/R03/R04 (closed/invalid account)** — stale bank link; verify identity before accepting a
     new funding source.
3. **Freeze the blast radius:** now AUTOMATIC (`users.status = 'suspended'`, set by the handler),
   enforced at the onboarded gate and at payout submit, so the user's other pre-`SUBMITTED` payouts
   hold themselves on `sender_suspended`. Verify rather than perform it, and note that cancellation
   is deliberately still available to the sender — that is a legal right, not an oversight.
4. If unauthorized-coded: security sweep — `sign_in_events` for the account, rotate sessions, and
   check whether other users share the device/IP pattern.

## Recovery (days 1–14)

1. Contact the user (we know all five of them personally at MVP scale): explain the return, ask them
   to repay. Innocent NSF usually resolves here.
2. Book honestly. **Policy decided 2026-09-10 (supersedes the receivable-first draft above):** the
   loss is booked STRAIGHT to `loss_funding_reversed` at dispute creation, automatically. If the
   user repays, or we win the dispute, that is a NEW correcting credit on its own transition —
   never an edit to the original entries. We do not carry per-sender receivables at this scale.
3. Re-presentment (R01) through Stripe where eligible.
4. No repayment + fraud-coded → the account stays frozen, and the loss stands. At MVP scale
   collections/legal is not worth it; document everything and move on.

## After every reversal (post-mortem, ~30 min)

This is the feedback loop the risk engine will eventually automate — do it manually now:

- Would `WAIT_FOR_CLEARING = true` have prevented it? (Almost always yes — note the trade made.)
- Was the float ceiling sized right? Aggregate `funding_receivable` exposure vs comfort level.
- Did anything in `sign_in_events` predict it (new device, odd hours, velocity)?
- One reversal from a trusted user = conversation. A second = flip `WAIT_FOR_CLEARING` on for that
  user (per-transfer verdict is the design — state machine doc) or off-board them.
- Update `docs/pre-implementation-todo.md` guardrail items if the incident changes priorities
  (amount caps, first-transfer holds).

## SAR note

Bridge is the MTL holder and owns BSA/AML program obligations on the rail, but **confirm in the
Bridge agreement who files SARs** for platform-detected fraud (tracked in pre-implementation-todo:
"Paper the Bridge MTL relationship"). Until confirmed, report suspected fraud incidents to Bridge
support in writing so the record exists either way.
