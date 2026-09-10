# Runbook — Funding Reversal (ACH return / chargeback after payout)

**Date:** 2026-07-10 · **Updated:** 2026-09-10 · **Status:** ⚠️ **PROPOSAL — the ops process around
it is still undecided**, but the mechanics below are no longer hypothetical: the handler, the loss
posting, the sender freeze, the freeze notice, and the unfreeze tool all exist and are described
here as they behave. What remains a proposal is the human process (who decides, how fast, what the
escalation looks like) and the SAR question at the bottom.
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
   is deliberately still available to the sender — that is a legal right, not an oversight. The
   freeze writes a `sender_freeze` row to `ops_actions` carrying the status it replaced and the
   disputed transfer.
4. **Deliver the freeze notice — this one IS yours to perform.** The handler renders it in the
   sender's `preferred_language`, stores it in `sender_notices`, and pages Sentry
   (`sender-notice-owed:account_frozen:<userId>`) with the exact subject and body. **Read those
   words; do not improvise.** The copy is deliberately bounded: it says the account is on hold and
   that a payment is the reason, it names the cancellation right the freeze leaves intact, and it
   discloses **nothing** about the dispute — not the code, the amount, the transfer, or the
   deadline. All of that helps a fraudulent actor and nobody else, and inventing a friendlier
   version is how an unreviewed promise gets made.

   There is **no automated channel**, which is why this is a step and not a footnote. The API
   cannot send SMS (Twilio credentials live in GoTrue, which sends OTP only, and the approved A2P
   campaign is registered for that one verbatim template — a freeze notice on it is unregistered
   traffic), and no email provider is wired anywhere in the repo. So `channel` is `'manual'` and
   the row's `status` stays `'pending'` forever: it records what was owed and what it said, not
   that anyone sent it. Phone is the practical channel at pilot scale.

   ```sql
   select created_at, language, subject, body
     from public.sender_notices
    where user_id = '<user-id>' order by created_at desc limit 1;
   ```

   *Unblocking automation, when it is worth it:* an email provider plus a verified sending domain
   (then `channel = 'email'`, one adapter in `services/sender-notices.ts`, no migration), or a
   second A2P campaign registered for transactional account notices. Both are external setup, not
   code. `account-lifecycle.md` deliberately defers email infra so it is built once, alongside
   receipts and transfer status.
5. If unauthorized-coded: security sweep — `sign_in_events` for the account, rotate sessions, and
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

## Unfreezing the sender

**The default answer is no.** A freeze is cheap to keep and expensive to lift wrongly, and nothing
in the system will lift it on its own — unlike `sender_kyc_pending` there is no event that says a
person is trustworthy again. Unfreeze only when the reason the account stopped is *resolved*, not
merely *explained*: the sender repaid, or we won the dispute, or the return turned out to be the
bank's error. "They seem fine" is not a resolution.

```bash
doppler run -- pnpm exec tsx scripts/unfreeze-sender.ts \
  --user <user-uuid> --operator <your-user-uuid> --note "what you verified"
```

Dry run by default: it prints the sender's status, every `sender_suspended` hold it would release,
and **every open dispute on the account**, and changes nothing. Add `--confirm` to perform it.
`--operator` and `--note` are required and never defaulted — an unfreeze with no stated reason is
exactly the row an examiner asks about, because someone chose to let a suspected-fraud account
transact again.

**Read the open-dispute list before you confirm, every time.** It is the one check the code cannot
make for you. The freeze is idempotent, so a SECOND dispute arriving on an already-frozen sender
writes nothing: no row on the account changes, no new `sender_freeze` record appears. If one landed
while you were investigating the first, no guard anywhere will stop you lifting the freeze with it
outstanding. The tool prints the transfers held on `funding_disputed` and any already at
`FUNDING_REVERSED`; confirm each one is a dispute you actually investigated.

What it does, in order:

1. `users.status` `'suspended'` → `'active'`, under a compare-and-swap pinned to the row's
   `updated_at`. Any write to the user row between the read and the write refuses the unfreeze
   rather than forcing it, so a freeze that was lifted and re-applied by someone else cannot be
   cleared by a decision made about the previous one. A refusal prints as *"the account is STILL
   suspended, but not the same suspension you just read"*; re-read and decide again. An unrelated
   write (a KYC status landing, a profile edit) refuses the same way, and re-running is safe.
2. A `sender_unfreeze` row in `ops_actions` — actor `ops:<your uuid>`, your note, before/after.
   This is the record that did not exist before 2026-09-10, when the only unfreeze was an UPDATE in
   the SQL editor whose sole trace was query history.
3. Releases this sender's `sender_suspended` payout holds and re-enqueues each submit, one
   `hold_release` row apiece. **Status first, holds second** is load-bearing: `payout-submit`
   re-reads the sender's status every run, so releasing first only re-holds on the next sweep.
   (Safe either way — that self-correction is why `sender_suspended` is also releasable from the
   ops board — but this order finishes the job in one pass.)

Holds under any **other** reason are left alone, `funding_disputed` included: a dispute on one
transfer outlives the account freeze and is released on its own judgement.

**Not a button on the ops board, deliberately.** The board is transfer-scoped end to end and this
is a user action, so a button means a new route plus a new web surface for something that should
fire approximately never — and this is judgement-heavy work whose default answer is "no", which is
not what a dashboard button is for. `decisions.md` 2026-08-01 already puts this class in the CLI
("the CLI stays break-glass"), and Doppler access to run it is a stronger gate than the board's
`OPS_WRITE_ENABLED` pair, not a weaker one. It drives a service (`services/sender-freeze.ts`), so
if unfreezing ever becomes routine the route is a thin wrapper the way
`POST /v1/ops/transfers/hold-release` wraps `releaseHold`.

Verify:

```sql
select created_at, actor, action, note, before, after
  from public.ops_actions
 where action in ('sender_freeze', 'sender_unfreeze')
 order by created_at desc limit 10;
```

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
