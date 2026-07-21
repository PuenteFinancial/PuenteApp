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

1. Confirm the webhook did its job: transfer is `FUNDING_REVERSED`, the ledger posted
   (`DR loss_funding_reversed` or a user receivable / `CR cash_clearing` — ledger-rules.md), audit
   log written. If the webhook was missed, reconciliation surfaces the Stripe return — process it
   through the normal code path first.
2. Read the return code in the Stripe event — it decides the path:
   - **R01/R09 (NSF)** — likely innocent. Re-presentment may be possible; the user probably just
     needs to fund their account.
   - **R05/R07/R10/R11 (unauthorized/revoked)** — treat as possible fraud or account takeover.
   - **R02/R03/R04 (closed/invalid account)** — stale bank link; verify identity before accepting a
     new funding source.
3. **Freeze the blast radius:** suspend further sends for the user (`users.status = suspended` or
   a send-block flag) until resolved. Check for other in-flight transfers from the same user — if any
   are still pre-`SUBMITTED`, hold them at the gate.
4. If unauthorized-coded: security sweep — `sign_in_events` for the account, rotate sessions, and
   check whether other users share the device/IP pattern.

## Recovery (days 1–14)

1. Contact the user (we know all five of them personally at MVP scale): explain the return, ask them
   to repay. Innocent NSF usually resolves here.
2. Book honestly: if the user commits to repay, carry it as a receivable; write off to
   `loss_funding_reversed` only when recovery fails (corrections are new ledger transactions —
   never edit the original entries).
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
