# PRD — Move the funding rail to Stripe Checkout Sessions

**Owner:** Joshua
**Build target:** Claude Code
**Status:** 🟡 **PROPOSAL — decision doc, not a build order.** Written 2026-09-08 so the choice gets
made deliberately rather than drifting. Three gates in §5 must be answered first; one of them can
kill it outright.
**Goal:** Take crypto off the user's path entirely. Senders pay with a Stripe payment form we
control, on our own page, and never see the word USDC. Keep identity verification at first send,
which is the thing the K lane was built to achieve and the part worth protecting.

---

## 1. Why this is on the table

The shipped flow (`stripe_crypto`, K1–K6) verifies the sender inside our own pay step and delivers
USDC straight to Bridge's treasury. It works — proven end to end in sandbox — but it carries two
costs that were accepted in August and have not gone away:

- **It leaks crypto.** Link's sign-in, the OAuth permission screen, and Stripe's own emails all name
  the asset. The 2026-08-27 decision was "de-emphasize, never deny." That was a concession, not a
  preference.
- **It is a private preview.** The rail runs behind a beta version header on an account Stripe had
  to flag in. Whether Stripe enables it in **live** mode is an open, unverified dependency sitting
  on the critical path right now.

Two things learned on 2026-09-08 raise the stakes:

1. **Stripe now recommends against the API the existing `stripe` rail is built on.** Their docs say
   to use the Checkout Sessions API with the Payment Element *over* Payment Intents, and "don't use
   the Payment Intent API unless the user explicitly asks, because it requires significantly more
   code." The `stripe` rail (S1–S3) uses `paymentIntents.create` directly. It has also **never run
   against Stripe once**, not even in test mode. It is not a fallback we can trust today.
2. **`ui_mode: "elements"` gives us both halves.** A Checkout Session drives our own Payment
   Element (`CheckoutElementsProvider`, `checkout.confirm`) — Stripe owns payment-method
   availability, pricing and tax logic, we own the page. That is the split we want.

## 2. What the sender experiences

**Today (`stripe_crypto`):** phone → consents → profile → recipient → quote + disclosure → then a
long pay step: check limits, accept Bridge's terms on Bridge's site, sign in to Stripe Link by text
code, enter DOB and tax ID for Stripe, wait for Stripe, send the same values to Bridge, wait for
Bridge, choose card or bank, pay.

**Proposed:** phone → consents → profile → recipient → quote + disclosure → pay step: accept
Bridge's terms, enter DOB and tax ID once, Bridge approves, pay.

**Not proposed** (the `stripe` rail as built): verification moves back to signup, before the sender
has decided to send anything. That is the flow the K lane existed to remove. Rejected.

The proposed flow is **shorter than what we ship today**, because Stripe stops being an identity
provider. Stripe only verifies on the crypto rail because its onramp refuses to create a session
for an unverified consumer. A bank or card charge needs none of that. Bridge is the party that
actually requires the identity, because Bridge makes the payout — and the Bridge half is already
built and has never cared how money moves.

### The integration, verified against Stripe's docs (2026-09-08)

Read before building C1 — the event model is the part that decides how this rail maps onto our
existing states, and it maps almost exactly.

**Creating the session.** `checkout.sessions.create` with `ui_mode: 'elements'`, `mode: 'payment'`,
a `line_items[].price_data` entry (name, currency, `unit_amount` — no Product object needed) and a
`return_url`. It returns a `client_secret`. Client side: `CheckoutElementsProvider` from
`@stripe/react-stripe-js/checkout`, the Payment Element, and `checkout.confirm()`.

**Which payment methods appear is Dashboard configuration, not code.** This is the concrete win
over the Payment Intents rail, where `payment_method_types: ['us_bank_account']` is hard-coded and
adding debit means a deploy.

**The three events, and how they land on our states:**

| Stripe event | When | Our funding event |
|---|---|---|
| `checkout.session.completed` | the sender finishes checkout | `funding_succeeded` → FUNDED |
| `checkout.session.async_payment_succeeded` | a delayed method actually settles | `funding_cleared` |
| `checkout.session.async_payment_failed` | a delayed method fails | `funding_failed` |

That is a near 1:1 replacement for the Payment Intents rail's existing map
(`payment_intent.processing` → succeeded, `.succeeded` → cleared, `.payment_failed` → failed), which
is why C1 is smaller than it looks: the funding-apply layer underneath does not change at all.

**One real difference C1 must handle — cards and bank debits complete differently.** For ACH the
`completed` event arrives with `payment_status: 'unpaid'` and the PaymentIntent still processing;
clearing comes later on the async event. For a card, `completed` arrives already `paid` and **no
async event ever fires**. So the handler cannot map `completed` to "funded, clearing later"
unconditionally — on a card that would leave `funding_cleared` false forever and strand
`funding_receivable` open, which reconciliation would eventually flag. Read `payment_status`:
`paid` means funded *and* cleared in one event, `unpaid` means funded with clearing still to come.

**⚠ Measured 2026-09-08 with `scripts/smoke-stripe-checkout.ts`, and it is not what we want yet.**
The methods a sender would actually be offered today:

| Account | Payment methods returned | ACH? |
|---|---|---|
| Staging (test) | card, klarna, link, cashapp, amazon_pay | **no** |
| **Live** | card, link | **no** |

Two problems, both invisible from the repository, which is exactly why the smoke exists.

**ACH is not enabled on either account.** The Payment Intents rail hard-codes
`payment_method_types: ['us_bank_account']` and accepts *only* bank debit; this rail would accept
only cards. That inverts the economics of the product — bank debit is roughly 0.8% capped, cards
are ~2.9% + 30¢ on a remittance whose whole margin is about 100bps. **Enabling ACH in the Dashboard
is a prerequisite for C1, not a detail**, and it is a Joshua action, not a code change.

**Staging currently offers Klarna, Cash App and Amazon Pay.** Funding an outbound international
money transfer with buy-now-pay-later is a risk and compliance question nobody has asked, and
cards already carry chargeback exposure this rail did not have (see §5.2). Whatever is enabled
should be a deliberate list, and the Dashboard is where that decision now lives. Live is already
narrower than staging, which is its own reason to check both.

**Fulfillment must be idempotent and webhook-driven.** Stripe is explicit that the handler can be
called multiple times, concurrently, for the same session, and that the landing page is not a
reliable trigger because the sender may never load it. Both are properties our
`applyFundingSucceeded` path already has.

## 3. Code inventory

| | Detail |
|---|---|
| **Deleted** | 8 `/v1/crypto/*` routes (596 lines), the Stripe crypto client (591), the crypto funding processor (69), and 11 of the pay step's 25 screens — Link sign-in, Stripe's identity form, its polling, document upload, payment collection, onramp session creation |
| **Kept untouched** | The Bridge terms gate, the relay (`POST /users/me/bridge-customer`), the `sender_kyc_pending` hold and its auto-release, `kyc_verifications`, Persona fallback, duplicate handling, address sync. K1, K2 and K6 survive whole |
| **Reworked** | The payment screen (Checkout Session + Payment Element), the funding processor, the send gate |
| **Thrown away** | K3, K4, K5 — three merged slices of Stripe-crypto-specific work |

A useful accident: K6b factored the DOB and tax-ID inputs into a shared component used by both
forms. That collection UI survives as-is.

## 4. Retiring the crypto rail without deleting it

**Nothing has to be deleted to take it off the user path.** `FUNDING_PROCESSOR` is a single enum
value; an unselected processor is inert code that no user can reach. So:

- **Phase 1 (this PRD):** build the new rail alongside. Switch the env var. The crypto rail stays
  in the tree, unselected, fully intact.
- **Phase 2 (a separate, later decision):** if and only if the new rail is proven in production and
  Stripe's live-mode answer is known, delete it — and tag the commit before doing so
  (`retired/stripe-crypto-rail`) with a short note in `docs/plans/kyc-at-first-send.md` naming the
  tag and the restore steps.

The cost of leaving it in Phase 1 is honest and small: ~2,700 lines stay in typecheck, lint and
test, and they need care during dependency bumps. That is the price of a real fallback, and it is
worth paying until the new rail has moved actual money.

A `retired/` or `vault/` directory is deliberately **not** proposed. Dead code inside the build
rots silently and confuses what is live; git plus an annotated tag is the durable answer.

## 5. The three gates — answer before building

### 5.1 Flow of funds ⛔ can kill this outright

On the crypto rail **Stripe is merchant of record** (documented in `flows.md`, `glossary.md` and
`stripe-onramp.ts`) and the sender's dollars become USDC in Bridge's wallet without passing through
us. On the proposed rail the sender's money lands in **our** Stripe balance and we move it onward.
That puts Puente in the flow of funds.

This is not new territory — the manual rail already does it, and one real $5 transfer moved that way
in production on 2026-08-18. But it was never blessed. "Paper the Bridge MTL relationship — states
covered, our agent/platform role, SAR ownership" has been open on the pre-implementation list since
June. **Counsel question:** with Bridge holding the licences, can Puente receive sender funds into
its own Stripe balance and fund payouts from a pre-funded treasury, and in which states? Nothing
gets built until this is answered.

### 5.2 ACH returns become our loss ⚠️ quantified

Today a reversed onramp payment is Stripe's problem; they are merchant of record. On the proposed
rail an ACH return lands on us, and the payout is irreversible the moment SPEI settles.

`runbooks/proposals/funding-reversal.md` (#218, drafted 2026-07-10, **still unadopted**) is the
process for exactly this. Its own numbers: unauthorized-debit returns arrive up to **~60 days**
after delivery, and industry recovery on fraudulent returns is about **25%**.

Existing controls bound the damage more than expected: $1,500 per transfer, $1,500 per rolling day,
5 sends per day, and — the strong one — **`RISK_UNCLEARED_MAX_COUNT = 1`**, so a user can have only
one un-cleared send in flight at a time.

What those caps do **not** bound is the 60-day tail: sends that cleared can still be reversed later.
Theoretical worst case for one determined account is the rolling caps themselves — **$3,000 in a
month, $18,000 over 180 days**. Today that number is zero, because it is Stripe's exposure.

**Decision:** adopt #218 (or explicitly accept the loss at pilot scale, in writing) before this rail
takes real money. Consider whether `funding_cleared` should gate payout on this rail rather than
fronting from float — that trades speed for safety and is the single biggest lever here.

### 5.3 Bridge as sole verifier ✅ smaller than it looked

Concern: today the relay only fires after Stripe says the person is verified. Remove Stripe and
Bridge sees every attempt, at $2 per check.

On inspection this is mostly handled. The relay is rate limited to **5 attempts per 15 minutes per
user**, and it **no-ops entirely once `bridge_customer_id` exists** — Bridge is never called twice
for the same person. Exposure is failed attempts only, capped at 5 per user per 15 minutes.

What genuinely changes: Stripe's verdict disappears as a first filter, so typos and probes reach
Bridge that previously did not, and `stripe_kyc_tier IN (L1, L2)` — today's precondition on the
relay — has to be replaced with something. Bridge already runs its own sanctions, PEP, blocklist and
database checks and offers the document fallback, so it is a competent sole verifier. **Open:** what
replaces the tier gate, and does the ITIN answer Bridge already gave in writing now carry the whole
product (it would, since Stripe's contradictory ITIN position stops mattering).

## 6. Slices

Only if §5.1 clears.

| Slice | Scope |
|---|---|
| **C1** | Checkout Sessions funding processor: create session (`ui_mode: elements`), webhooks, status, void, refund, reconciliation listing. Server only, dark |
| **C2** | Web payment step: `CheckoutElementsProvider` + Payment Element + `checkout.confirm`, replacing the collect / session / checkout screens |
| **C3** | Machine surgery: delete the Link and Stripe-verification arms, make the Bridge relay the identity path, replace the tier gate |
| **C4** | Send gate, env, config, docs — the new rail means profile + consents, never `kyc_status = approved` |
| **C5** | Staging drive end to end, then a real send |

**Build log.** C1 (2026-09-08, #294 + the join fix #296) and C2 (2026-09-09) are merged, and the
rail is still INERT: `FUNDING_PROCESSOR` selects it nowhere, so no sender can reach it and §5.1 is
not yet spent. Two things C2 measured that this document had wrong or could not know:

- **Staging now offers card, US bank account and Klarna** (2026-09-09, real elements-mode session).
  ACH landed — the §2 table's "no" is stale. Klarna arrives through **Link**, which is why the
  session's own `payment_method_types` does not list it and the API-level smoke could not see it.
  Reading `payment_method_types` is therefore NOT sufficient to know what a sender is offered; the
  rendered element is. Funding an outbound international transfer with buy-now-pay-later is the
  §5.2 question in a sharper form, and it is a Dashboard decision.
- **Locale is fixed at `loadStripe()` on this rail.** The Checkout SDK options carry no `locale`
  field, unlike `<Elements>`. Spanish senders get an English form unless the key is loaded with the
  locale, so `getStripe()` now caches on (key, locale).

Five to eight focused sessions plus the drive. C3 is the risky one: that machine is the most tested
and most drive-proven code in the repo.

## 7. What would make us not do this

- Counsel says no to §5.1. **Then the crypto rail is the only path and this PRD is dead.**
- ~~Stripe confirms crypto onramp for live mode~~ — **answered 2026-09-08: it IS provisioned.**
  `scripts/smoke-stripe-crypto.ts` against `prd_main` returned a real $25 USDC-on-Base quote from
  the live API with the beta header. So the crypto rail is a genuine production fallback rather
  than a hope, which *lowers* the risk of building this one: if gate 5.1 goes against us, there is
  something working to fall back to. It stays inert until `FUNDING_PROCESSOR` selects it.
  (The Link OAuth leg of that smoke is still ambiguous — it 404s identically for "probe email has
  no Link account" and "unrecognized OAuth client". Rerun with `SMOKE_PROBE_EMAIL` set to an email
  that has a Link account to settle it. Irrelevant to this rail, which uses no Link.)
- The pilot surfaces enough identity-flow problems that rebuilding the payment half on top of an
  unsettled identity flow is obviously the wrong order.

## 8. Sequencing note

The pilot starts 2026-09-08 on the shipped crypto rail. **It should still run.** The five untested
paths — rejection, Persona, manual review, duplicate tax ID, poll timeout — are Bridge behaviours,
not Stripe ones, and every one of them survives this switch unchanged. Pilot learnings are not
wasted work under either outcome.
