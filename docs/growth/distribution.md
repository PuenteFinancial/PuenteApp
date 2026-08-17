# Distribution & growth — the plan, and what to build

**Date:** 2026-08-14
**Status:** drafted — nothing here is decided
**Scope:** how Puente acquires its first 1,000 senders, and the instrumentation required to know whether it's working.

Written in the same spirit as `system-map.md`: mechanism, why it's built that way, and what the
alternative was. If someone challenges a growth decision, the answer should be here.

The one-line summary: **canvassing gets the first cohort, referral and rev-shared partners compound
it, and none of it is legible without instrumentation that has to ship before launch.**

---

## 0. The math that makes this urgent

Two people canvassing produced **66 conversations → 14 ICP-qualified in ~2 weeks** (Rancho Provo,
Rancho SLC, WC watch party, 6/11–6/17). Call it 7 qualified prospects per week.

At a generous 30% qualified→first-send conversion, that's **2 users/week. A hundred users takes a
year.**

Canvassing is not wrong — Cashea's online-to-offline funnel failed and their breakthrough was
putting ambassadors physically at point of sale, eventually ~200 people across 25 cities. In-person
*is* the channel for this customer. But at two people it produces a first cohort, not a business.
Everything below exists to make that first cohort compound.

Reference for what "working" looks like: Cashea went from **$10k in month 1 to $450k in month 3**.
The shape shows up early and in small numbers.

---

## 1. Instrumentation — build this BEFORE launch

This is the section that matters most. We are ~2 weeks from live. Every item here is worth more
than any feature that could ship instead, because without them the first 90 days produce no
evidence and the raise has nothing to stand on.

### 1.1 The six numbers

| Metric | Definition | Why it's the one |
|---|---|---|
| **Activation** | waitlist signup → first completed send | The waitlist is meaningless until this is measured |
| **Second-send rate (30d)** | % of first-senders who send again within 30 days | **The single most important number we will have.** 50 users at 70% beats 500 who send once, and every good investor knows it |
| **Weekly cohort retention** | sends/user/week by signup cohort | Distinguishes a growing business from a leaking bucket |
| **Referral coefficient** | referred users ÷ referring users | Determines whether anything else we do multiplies |
| **CAC by channel** | fully-loaded cost per activated user, per channel | We currently cannot answer this. Post-launch we must |
| **Real contribution margin** | actual revenue − actual cost, per transfer | See §1.3 — this is currently unknown and possibly negative |

**Build note:** PostHog is already wired. These should be defined as events + a dashboard before
launch, not reconstructed from the database in October.

### 1.2 Referral codes on day one

Every user gets a code at signup. Not in v3.

**Mechanism:** code on the user record, attribution captured at signup of the referred user,
credited on the referred user's *second* send (not signup — see §2.4).

**Why now:** remittance is inherently social. Senders know each other, work the same jobs, send to
the same towns. If each user brings 0.5 users, everything else we do carries a 1.5× multiplier. If
we ship this in three months we lose the multiplier on the entire first cohort — the one we'll be
raising on.

**Alternative rejected:** waiting for a "proper" referral system with tiers and rewards. A code and
an attribution field is 90% of the value at 5% of the work.

### 1.3 The unit-economics instrument

We do not know our real contribution margin. The model says $0.40/transfer, and `decisions.md`
(2026-07-21, still open) flags that Bridge probes executed **~2% below the `buy_rate` we quote
off** — meaning every transfer may under-collect 1–2% with `fx_slippage` silently absorbing a
provider cost that belongs in pricing. On a $300 send that's $3–6 against a $0.40 margin.

**Build:** per-transfer margin capture — quoted rate, executed rate, realised spread, actual
processor cost, actual Bridge cost — written at settlement, queryable as a cohort.

**Why:** after ~50 real transfers this stops being a modelling argument and becomes a fact. That
is the fastest path to knowing whether the business works, and it is a genuinely strong thing to be
able to say: *we'll know our real unit economics within 30 days because we're live.*

### 1.4 Channel attribution

A `source` field captured at signup, populated from: referral code, ambassador code, QR code
(per-location), ad campaign, organic. Nothing clever — a string on the user record and a report.

**Why:** §2 and §3 are unfalsifiable without it. We will otherwise scale the channel that feels
best rather than the one that works.

---

## 2. The ambassador / rev-share program

### 2.1 The constraint everything must respect

**We cannot revenue-share a transaction whose contribution margin is $0.40.**

This is the trap in the rev-share idea and it needs stating plainly. Gentry's warning applies
directly: *"the corner trap of buying someone's love… paying 5% cashback when you make less than 5%
on interchange."* Any commission structure paid out of transfer margin is negative-margin growth
dressed as distribution.

**What we can share is the membership.** The credit-building membership is the actual margin pool.
It is recurring, and sharing it aligns the ambassador with *retention* rather than signup volume.

**Blocking dependency:** the membership price is not set. Until it is, no ambassador program can be
designed. Model against Bloom's furnishing cost (**$5k setup + $2k/month on a 24-month commitment**
≈ $53k contracted, per Gentry call notes) and known comparables (Kikoff $5/mo; Self roughly
$25–48/mo — *verify current tiers before citing*).

### 2.2 Three ambassador archetypes — not the same product

| Archetype | Who | Economics | Priority |
|---|---|---|---|
| **Location partner** | The rancho, the tienda, the money-change counter | Already has the customer, the trust, and the foot traffic at the moment of intent | **Highest** |
| **Individual ambassador** | Community member recruiting their own network | Low volume each, compounds, cheap | Medium |
| **Creator / influencer** | Spanish-language finance creators | Broad reach, weak attribution, usually wants cash not rev share | Lowest — test last |

**The unlock we may be underweighting:** small money-change counters and remittance windows are
*already agents* earning commission from WU, Ria, and Intermex. They have the customer at the exact
moment of intent, and they are already compensated per transaction — so the conversation is about
better economics, not about adopting a new behaviour. Converting an existing agent is far more
efficient than recruiting a community member from zero.

We have already met these people. `100 Convos` logs Mexsal workers, Envíos workers, Rancho
employees, and Jillian behind the counter. **These are warm contacts we have not converted.**

### 2.3 Proposed structure: bounty + tail

**Bounty:** a fixed amount per activated user, paid on the referred user's **second completed
send**, in arrears.

**Tail:** a percentage of that user's membership revenue for 12 months.

**Why this shape:** the bounty is a known, capped CAC that gets ambassadors to actually work. The
tail costs nothing until there is revenue and makes the ambassador care whether the person they
recruited stays. Paying on second send rather than signup filters for real users automatically —
it is simultaneously the anti-fraud control (§2.4) and the quality filter.

**Alternative rejected — per-transaction rev share:** violates §2.1. Negative margin per user with
no path to positive.

**Alternative rejected — pay on signup:** guarantees fraud and rewards volume over quality. Every
referral program that has ever been abused was abused at this exact design decision.

### 2.4 Fraud and abuse — designed in, not bolted on

Referral programs in remittance get abused. Specifically:

- **Fake or thin users** created to farm bounties.
- **Recruited mule accounts** — the serious version. An ambassador paid per head is an
  acquisition channel for someone who wants accounts.
- **Churn farming** — recruiting people who send once and vanish.

Controls, all of which we should already be able to support:

- Pay on **second send**, in arrears, never on signup.
- **Per-ambassador caps** on referrals per week pending review.
- **Full KYC on every referred user** — no relaxed path for referrals, ever.
- **Clustering detection** — flag same device, same IP, same recipient account, or same funding
  instrument across referred users. The existing velocity and per-user exposure work in slice 8 is
  the right home for this.
- Manual review of any ambassador above a volume threshold before payout.

### 2.5 ⚠️ The regulatory question — resolve before launching this

**Paying commissions to people who help customers move money may make them agents of a money
transmitter.** Many states regulate authorized delegates of MTLs, and we operate under Bridge's
licences, not our own.

The distinction that matters:

- **Marketing referral** — hands the customer a QR code, never touches funds, never assists with
  the transaction. Probably clean.
- **Agent** — takes cash, enters the transaction, or assists in initiating it. **Not clean.** This
  is a different regulatory animal and it is exactly what a rancho counter would naturally start
  doing without being told not to.

**Actions:** ask Bridge directly where the line sits under their licences; get counsel to confirm
before any commission is paid; and write the ambassador agreement so that handling customer funds
is explicitly prohibited.

This is not a reason to avoid the program. It is a reason to design it correctly the first time.

### 2.6 How to actually run it at two people

Cashea did not scale ambassadors as gig workers — they built a *managed* field organisation.
At two founders the leverage is in being ruthless about the pilot:

1. Start with **3–5 ambassadors**, personally managed, all three archetypes represented.
2. Ship them a kit: a **unique QR code**, printed Spanish materials, and a WhatsApp script.
3. Measure per-ambassador activation weekly.
4. **Scale only the archetype that converts.** Do not scale the one that is easiest to recruit.

---

## 3. Content pipeline — yes, but weighted differently than proposed

**The proposal:** automation posting financial literacy content to the site 2–3× per week.

**The verdict:** worth building, at low cost, but the site is the wrong primary surface and the
cadence is the wrong metric.

**Why it's right in principle:** our own field data says **~4 in 5 people we meet are afraid of
credit or don't understand it** — *"scared of credit and debt," "avoids credit cuz doesn't
understand," "afraid of banks, doesn't think she can open one because she's an immigrant."* That is
not an objection to route around; it is the top of the funnel. Spanish-language credit education is
genuinely under-served, and we already have literacy content live on puentefinancial.com.

**Why the site alone is the wrong surface:** the person standing in a rancho is not googling *cómo
construir crédito*. The formats that reach this customer are **short, Spanish, visual, and
distributed on WhatsApp and Facebook groups** — where the community already is. A blog post is an
SEO asset that compounds over 12+ months; we need users in 90 days.

**What to build instead — one pipeline, three outputs:**

1. **Site post** — the SEO asset. Long-term compounding, low near-term value.
2. **WhatsApp-forwardable card** — image + short Spanish text, designed to be forwarded.
3. **Short-form video/carousel** — for FB groups and IG.

Same source content, three renders. The automation is worth it *because* it fans out, not because
it hits a cadence.

**Guardrails:**

- **Kill criterion:** if it produces no attributable signups in 60 days, stop. Set this now, while
  it's cheap to be honest.
- **Quality over cadence.** Thin generated content is actively penalised by search ranking and, more
  importantly, is transparently low-effort to a reader deciding whether to trust us with money.
  Two good pieces a week beats five weak ones.
- ⚠️ **Compliance flag:** we will be an FCRA furnisher selling a credit-building membership.
  Content that makes representations about score improvement may implicate the **Credit Repair
  Organizations Act** and related state statutes. Self and Kikoff both navigate this. **Confirm
  scope with counsel before publishing claims about score outcomes** — including in ad creative.

---

## 4. Channels, ranked

1. **Referral** — cheapest, compounds, must ship at launch (§1.2).
2. **Location partners / existing remittance agents** — highest intent, warm contacts already
   logged in `100 Convos` (§2.2).
3. **WhatsApp as an entry point** — the customer lives there, not in an app store. Félix Pago
   raised a $75M Series B substantially on this insight. Likely the single largest conversion lever
   available to us.
4. **Anchor institutions** — one relationship equals a list. Already-warm: Comunidades Unidas, Utah
   Valley Refugees, Community Action Provo. Add churches, and consulate financial-literacy
   programming (*Ventanilla de Salud* and adjacent), which is the highest-trust surface that exists
   for this population. Also employers with dense immigrant workforces — construction, landscaping,
   hospitality, meatpacking.
5. **Paid social, Spanish, on the credit hook** — every competitor advertises *best rate, lowest
   fee, fastest*. **Nobody else can advertise "envía dinero y construye tu crédito."** A
   differentiated creative in a commoditised ad market is exactly the condition under which paid
   acquisition is cheap. Testable this week for a few hundred dollars, and informative either way.
6. **Content / SEO** — §3. Long-term asset, not a 90-day channel.

---

## 5. Realistic targets

| Horizon | Active senders | Notes |
|---|---|---|
| 30 days post-launch | **10–30** | Hand-recruited from waitlist + canvassing |
| 90 days | **50–200** | Only if one channel beyond canvassing works |
| 6 months | **300–1,000** | Requires the ambassador program to be running |

These are small numbers and should not be apologised for. **At pre-seed the absolute number is not
what gets funded — the rate and the repeat are.** The thing to optimise for is a cohort chart that
compounds, not a signup count.

---

## 6. Build backlog

Ordered by when it must exist.

### Before launch (~2 weeks)

- [ ] **Referral codes** — code per user, attribution on referred signup, credit on second send
- [ ] **`source` field** on user record + channel attribution report
- [ ] **Per-location QR codes** — distinct code per rancho / partner / ambassador
- [ ] **PostHog events + dashboard** for the six metrics in §1.1
- [ ] **Per-transfer margin capture** — quoted vs executed rate, realised spread, actual processor
      and Bridge cost, written at settlement (§1.3)
- [ ] **Second-send rate** as a first-class, queryable cohort metric

### First 30 days post-launch

- [ ] **WhatsApp entry point** — even a `wa.me` deep link into an assisted onboarding flow beats an
      app install for this customer. Test before polishing the app
- [ ] **Ambassador dashboard (internal, minimal)** — referrals, activations, pending payouts.
      A SQL view and a script is fine; this does not need a UI
- [ ] **Clustering/fraud detection** on referred users — device, IP, recipient account, funding
      instrument (§2.4). Extends slice-8 velocity work
- [ ] **Ambassador payout ledger account** — commissions are an expense that must post to the
      double-entry ledger like everything else. Do not pay these outside the books

### Next 90 days

- [ ] **Content pipeline** — one source, three renders: site post, WhatsApp card, short-form (§3)
- [ ] **Membership billing** — blocked on pricing (§2.1)
- [ ] **Ambassador self-serve onboarding** — only after the pilot identifies which archetype works

---

## 7. Open decisions — none of these are made

1. **Membership price.** Blocks the ambassador economics, the unit-economics model, and the Q&A
   answer on contribution margin. Highest-priority open item in this document.
2. **Bounty amount and tail percentage.** Cannot be set until (1).
3. **Agent vs. referral line** — Bridge + counsel (§2.5). Blocks paying anyone.
4. **CROA scope** on credit-building content and ad claims — counsel (§3).
5. **Which ambassador archetype to pilot first.** Recommendation: location partners, because the
   contacts are already warm.
