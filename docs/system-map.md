# Puente, end to end — the CTO's map

Written to be *defended*, not just read. Each section is: the mechanism, why it's built that way,
and what the alternative was. If someone technical challenges a decision, the answer is here.

---

## 1. What actually happens when someone sends $200

1. **Quote.** We ask Bridge for the live USD→MXN rate, add our margin, and freeze *our* number for
   15 minutes. Bridge offers **no rate lock** — their rate is indicative and moves every ~30 s.
2. **Transfer + disclosure.** We create the transfer and generate the federally-required
   pre-payment disclosure from our own quote. The customer must actively accept it; we record that.
3. **Payment.** Today a mock; Stripe later. When it succeeds the transfer becomes `FUNDED` and the
   **first accounting entries are written**.
4. **Payout.** A background worker picks it up, calls Bridge, and buys MXN. Bridge sends it over
   SPEI, Mexico's instant rail — seconds, not days.
5. **Delivery.** Bridge tells us it landed; the transfer completes and a receipt becomes available.

**Money is always integer minor units plus an explicit currency.** Never floats — floating point
loses cents, and cents are the product.

---

## 2. Why an API and a separate worker

The API answers requests. The worker does everything slow, retryable, or scheduled: submitting
payouts, processing webhook events, polling Bridge, nightly reconciliation, stuck-transfer alerts.

**Why split:** a payout takes seconds and can fail halfway. Doing that inside a web request means
the customer's browser is holding a money movement open — and a dropped connection becomes an
ambiguous outcome. The worker owns a durable queue, so a crash resumes instead of losing work.

**Alternative rejected:** doing it inline in the API. Simpler, but every deploy or timeout becomes
a potential stranded transfer.

**The nuance worth knowing:** the API is deliberately data-layer-only for most things, but it
*does* hold a queue connection so it can enqueue work the instant a webhook lands. Without that
connection it still works — a sweep heals it within ~5 minutes — but the fast path is gone. That
safety net is why losing the enqueue is survivable at all.

---

## 3. The ledger — the thing to be proudest of

**Mechanism.** Double-entry. Every money event writes a *balanced batch*: debits equal credits.
Balances are **derived** by summing entries — there is no balance column anyone can update. The
accounting entries are written **in the same database transaction** as the state change, so the
books and the transfer status cannot drift apart. And ledger rows are **append-only, enforced by a
database trigger** — `DELETE` raises an error telling you to post a correcting entry instead.

**Why:** money systems fail when a number can be edited without a trace. This design makes the
history the source of truth and the balance an opinion derived from it. Corrections are new
entries, so a mistake is visible forever rather than erased.

**Alternative rejected:** a `balance` column updated in place. Faster to query, trivially
corruptible, and impossible to audit after the fact.

**Defend it like this:** "Our balances are computed, not stored. Nothing can be deleted. Every
state change carries its accounting in the same transaction."

---

## 4. Why Bridge, and why we never hold money

There is **no direct fiat→fiat route**. USD→MXN goes through a stablecoin: dollars become USDC in
a treasury wallet, and Bridge converts and delivers MXN over SPEI. We verified this in sandbox —
every direct USD-source→MXN-destination combination is rejected as an unsupported route.

**Puente never takes custody of customer funds.** Stripe holds the USD, Bridge holds the licenses
and the wallet. That is what lets us operate without money-transmitter licenses in 50 states —
the single largest regulatory cost we avoid.

**Alternative rejected:** getting our own MTLs. Years and millions.

---

## 5. The float — the one that will get challenged hardest

**`FUNDED` does not mean we have the money.** It means the ACH debit was *initiated*. ACH takes
days to settle. But we pay the recipient in seconds.

So **Puente fronts its own money on every transfer**, and carries the risk that the customer's
ACH bounces after the recipient has been paid.

Three controls bound that exposure:

- **Float ceiling** — an aggregate cap; payouts pause when outstanding uncleared money hits it,
  and resume automatically as it drains.
- **Uncleared cap (per user)** — one unsettled transfer at a time. A second send is refused until
  the first clears.
- **First-transfer hold** — a switch (currently off) that makes a brand-new sender wait for their
  own ACH to clear before we pay out.

**Why front at all:** the product promise is speed. Waiting for ACH would make us a 3-day service.
**The switch exists:** a single flag turns fronting off and makes us wait for clearing — so this is
a priced business decision, not a hard-coded assumption.

---

## 6. Cancellation — the hardest rule in the system

Federal law (Reg E §1005.34) gives a sender **30 minutes** to cancel and get a full refund, unless
the money has already been picked up or deposited. On an instant rail, it often has.

So there is a real window where **both are true**: the sender is legally owed their money back,
*and* the recipient already has it. We cannot claw it back.

**What we do:** pay the sender a second time, out of Puente's funds, booked to a dedicated
`loss_cancellation_correction` account so the cost is visible and trendable. An hourly job alerts
if those losses cross a threshold.

**The part worth showing off:** the operator tool **refuses** to deny a request that met both
conditions. Not a warning — a refusal. A tired human at 2am cannot click past a statutory right.
Denials also require the operator to type in the deposit timestamp as evidence, and the form
rejects a timezone-less value, because a bare local time silently shifts the evidence by hours.

**Alternative rejected:** treating cancellation as a dispute. Legally wrong — a dispute is a
different rule (§1005.33) with different obligations.

---

## 7. Why retries can't double-pay

Every money-moving endpoint takes an **idempotency key**. The key plus a hash of the request body
is claimed before the work runs; a repeat with the same key replays the stored result instead of
re-executing. Failed responses are never stored, so a retry after an error genuinely retries.

Downstream, the same discipline: transfer state changes use a guarded update that only applies
from the expected prior state, so two concurrent attempts can't both win. Ledger batches are
unique per transfer and transition, so a replayed post is a no-op.

**The subtle bug we designed out:** the browser mints the key *once* per user action and holds it
across retries. If the key were minted per attempt, a double-click would be two transfers.

---

## 8. Operations posture

**Scripts before dashboards.** Refunds and cancellation decisions started as command-line tools
that run the same service code as the app — deliberately, because a money-moving admin endpoint is
a bigger attack surface than a script, and because the CLI is safer than the SQL console the
alternative would have been.

The ops **page** is now additive: same services, nicer surface. It's gated by two independent
environment variables — one listing admin user ids, one enabling writes — and it returns **404,
never 403**, byte-identical to a missing route, so it never confirms it exists to someone probing.

**Why 404:** a 403 tells an attacker there is something there worth attacking.

---

## 9. Environments

`main` deploys to staging automatically. Production moves only through an approval-gated promote
workflow that applies database migrations first, then fast-forwards. Two separate databases.

**Production is deliberately inert today.** The mock-payment secret is absent there on purpose —
its absence makes the payment path return an error. There are no Stripe keys. **No transfer can be
funded in production right now**, and that is a safety property, not an oversight.

---

## 10. What is NOT done — know these before someone finds them

| Gap | Status |
|---|---|
| **Stripe has never made a real API call** | Adapter written and unit-tested against a dummy client. Creating a payment, refunding, and the payment form are all unproven. Blocked on sandbox keys. |
| **SMS is not live** | Twilio A2P registration pending. Real sign-in doesn't work outside local test numbers. |
| **Reg E disclosure wording** | Drafted; counsel sign-off outstanding, plus a native-Spanish review. |
| **Support mailbox** | The disclosure tells customers to contact an address that doesn't receive mail yet. |
| **Delivery confirmation in sandbox** | Bridge sandbox parks payouts and never delivers; we drive the final step with a signed test webhook. |

None of these block the demo. All of them block real customers.

---

## 11. If you only remember five things

1. Money is integer minor units; balances are summed from an append-only ledger, never stored.
2. The API takes a transfer to `FUNDED`; a worker does everything after that.
3. We front our own cash between ACH initiation and settlement — three controls bound it, and a
   flag turns it off.
4. A cancellation that met both legal conditions is owed a refund even if the recipient keeps the
   money, and no operator can override that.
5. Production cannot move money today, on purpose.
