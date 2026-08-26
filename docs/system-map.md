# Puente, end to end — the CTO's map

Written to be *defended*, not just read. Each section is: the mechanism, why it's built that way,
and what the alternative was. If someone technical challenges a decision, the answer is here.

---

## 1. What actually happens when someone sends $200

1. **Quote.** We ask Bridge for the live USD→MXN rate, fold our margin **into the displayed rate**
   (one number, no separate fee line — since #193 the customer pays exactly what they typed and the
   take is recorded as `margin_minor`), and freeze *our* number for 15 minutes. Bridge offers
   **no rate lock** — their rate is indicative and moves every ~30 s.
2. **Transfer + disclosure.** We create the transfer and generate the federally-required
   pre-payment disclosure from our own quote. The customer must actively accept it; we record that.
3. **Payment.** One of four rails, selected by `FUNDING_PROCESSOR`: **mock** (dev/demo only — the
   missing webhook secret is the production lock), **manual** (out-of-band: the sender wires/ACHes
   to Puente's own coordinates, auto-attached from a Bridge onramp at confirm; an operator verifies
   the deposit and asserts `FUNDED` — this is how the first real prod transfers moved), **stripe**
   (Payment Element ACH debit), and **stripe onramp** (Stripe's crypto widget delivers USDC
   straight to the treasury wallet; a delivered-amount guard verifies the exact amount before
   `FUNDED`, because the widget's amount field is user-editable). Whichever door fires, the
   transfer becomes `FUNDED` and the **first accounting entries are written**.
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
  and resume automatically as it drains. That "outstanding" reading depends on the ledger
  relieving `funding_receivable` when the ACH settles — a posting that was specified from the
  start but only implemented on 2026-08-03. Without it the account tracked *lifetime volume*,
  which would have turned the ceiling into a one-way ratchet that halted every payout once
  cumulative volume crossed it. Worth knowing as the shape of failure this control can have:
  a risk limit is only as honest as the number it reads.
- **Uncleared cap (per user)** — one unsettled transfer at a time. A second send is refused until
  the first clears.
- **First-transfer hold** — a switch (currently off) that makes a brand-new sender wait for their
  own ACH to clear before we pay out.

**Why front at all:** the product promise is speed. Waiting for ACH would make us a 3-day service.
**The switch exists:** a single flag turns fronting off and makes us wait for clearing — so this is
a priced business decision, not a hard-coded assumption.

**Replenishing the float is now a first-class operation** (funding-ops, 2026-08-20/21): the
treasury wallet is topped up by an ops-board action (or break-glass CLI) posting
`DR bridge_wallet_float / CR cash_clearing`, idempotent on a global `float_topup:<ref>` ledger
key; on the onramp rail the top-up happens **automatically** when Stripe's settlement webhook
lands, keyed to the session id.

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

Since funding-ops slices 1–4 (2026-08-20/21) the board also **acts**: per-transfer buttons
(attach deposit instructions — prefilled from the auto-created onramp so the operator confirms
rather than transcribes; release funding; deposit-landed = cleared + float top-up in one tap,
with a ref-typo guard because the top-up's ledger key is global), an ad-hoc float top-up card,
and cancellation refund/deny actions. Every money button is a two-step confirm restating the
amount, holds a browser-minted idempotency key across retries, and every refusal is a non-2xx
(a 200-refusal would freeze into the idempotency replay). The sender's side got one new signal:
an "I've sent the payment" claim — set-once, **never a release** (a claim that released money
would be a treasury-drain lever); ops hears about it as a fingerprinted Sentry info event.

---

## 9. Environments

`main` deploys to staging automatically. Production moves only through an approval-gated promote
workflow that applies database migrations first, then fast-forwards. Two separate databases.

**Production moves real money now** (first live transfer 2026-08-18, $5). What made that safe to
say is the shape of the locks, which changed rather than disappeared:

- The **mock rail is still dead in prod** — its webhook secret is absent, so simulated funding
  cannot exist there. That lock never came off.
- The doors that ARE open are deliberately human-gated: the **manual rail** requires an
  allowlisted operator to assert every `FUNDED` (an empty allowlist means nothing can leave
  `PENDING_PAYMENT`), and the **onramp rail** requires the delivered-amount guard to pass to the
  cent before any payout releases.
- `AUTO_REFUND` ships **off** in prod: a failed payout parks and pages rather than auto-disbursing.

---

## 10. What is NOT done — know these before someone finds them

| Gap | Status |
|---|---|
| **Payment Element rail unproven live** | The onramp rail has made real prod API calls (live sessions, real money). The **Payment Element (ACH debit) rail has not** — adapter written and unit-tested; creating a live payment, refunding, and the payment form under real keys are unproven. |
| **`FUNDING_REVERSED` has no writer** | An ACH return / chargeback event is logged and acked — nothing transitions the state or books the loss. Today a real reversal is a Sentry page and a human. |
| **Onramp reconciliation is `skipped`, not `pass`** | The recon stripe-legs gate on the Payment Element provider; the onramp rail deliberately implements no recon reads yet (fast-follow). Interim nets: redelivery window + the uncleared-transfer check + the amount guard's page. |
| **`AUTO_REFUND` is off in prod** | A failed payout parks at `PAYOUT_FAILED` and pages; a human disburses via runbook. Deliberate posture, but it means refund latency is human latency. |
| **Reg E disclosure wording** | Drafted; counsel sign-off outstanding, plus a native-Spanish review. |
| **Support mailbox** | The disclosure tells customers to contact an address that doesn't receive mail yet. |
| **Delivery confirmation in sandbox** | Bridge sandbox parks payouts and never delivers; we drive the final step with a signed test webhook. |

*(Resolved since the last edition: SMS — the A2P campaign was approved 2026-08-05 AND the Twilio
provider is configured in Supabase Auth, so real sign-in works; the "Turning SMS on" section below
stays as the reference for how it's wired and the spend controls that must stay on.)*

None of these block the demo. The counsel and mailbox rows still block scaling past trusted users.

### Turning SMS on

Nothing in this repo sends SMS. The chain is web/mobile → `POST /v1/auth/otp/send` →
`signInWithOtp({ channel: 'sms' })` → GoTrue → Twilio, so every Twilio setting lives in the
Supabase dashboard, **per project** — staging (`namdkmsmdkmdffgscqgd`) and prod
(`goyfagidfkjyhyepsaup`) are configured separately, and neither reads Doppler for this.

Under **Authentication → Providers → Phone**: enable the provider, choose **Twilio** (not Twilio
Verify — Verify runs its own OTP and ignores the template below), then enter the account SID, auth
token, and the Messaging Service SID whose sender pool is attached to the approved A2P campaign.
Traffic from a number outside that pool is unregistered and gets filtered.

The SMS template must match the registered campaign sample verbatim — carriers compare delivered
traffic against what was registered:

```
Puente Financial: Your verification code is {{ .Code }}. It expires in 10 minutes. Do not share this code with anyone.
```

Set the SMS OTP expiry to **600 seconds** to match that "10 minutes". It is a separate setting and
its default is far shorter, so left alone the message lies and users hit dead codes.

`supabase/config.toml` is local-only and stays as it is: the dummy Twilio block exists because
GoTrue refuses phone auth without an enabled provider, and test number `15005550006` / `123456`
bypasses it entirely.

**Spend controls are part of turning it on, not a follow-up.** `/v1/auth/otp/send` is public and
unauthenticated, which is the SMS-pumping setup — an attacker cycles premium-rate international
numbers and bills us. Twilio **Geo Permissions restricted to US** removes most of the value (our
users' phones are US numbers; MXN is the destination of money, not of SMS) and was set 2026-08-05.
Pair it with GoTrue's per-phone cooldown and hourly SMS cap under **Authentication → Rate Limits**,
and Twilio usage triggers — Twilio has no hard spend stop, so those are alerts someone must act on.

---

## 11. If you only remember five things

1. Money is integer minor units; balances are summed from an append-only ledger, never stored.
2. The API takes a transfer to `FUNDED`; a worker does everything after that.
3. We front our own cash between ACH initiation and settlement — three controls bound it, and a
   flag turns it off.
4. A cancellation that met both legal conditions is owed a refund even if the recipient keeps the
   money, and no operator can override that.
5. Production moves real money now — through human-gated doors only: an operator asserts every
   manual `FUNDED`, the onramp amount guard verifies to the cent, the mock rail stays locked out,
   and refunds are hand-disbursed.
