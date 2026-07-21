# Decision Log

**Started:** 2026-07-13 (seeded retroactively from PR history, design docs, and session notes).
One dated paragraph per decision: what, why, status. Newest first. Add an entry whenever a choice
would make a future engineer ask "why on earth…" — that question is the inclusion test.

---

**2026-07-21 · Bridge execution rate vs quoted `buy_rate` — an unresolved pricing question, must be
answered before slice-7 real money.** The slice-5 sandbox e2e drove a full payout whose `SUBMITTED`
batch debited `fx_slippage` (`D` = actual USDC draw − quoted send principal). Investigation: Bridge's
own receipt reports **zero fees** (`developer_fee`/`exchange_fee`/`gas_fee` all `0.0`), yet direct
probes executed at a **constant rate, proportional across amounts** — a fixed ~2% below the
`exchange_rates` `buy_rate` we quote off. So the delta is **not a fee and not random drift, but a
systematic rate gap.** The mechanism is sound (`submittedLedgerEntries` captures `A − S`, nets to
zero); only the magnitude is suspect, because the sandbox rate feed is frozen (`updated_at` April
2026) and proves nothing about production. **Open question:** in prod, does Bridge execute at the
`buy_rate` we quote off, or at a worse rate? If a real spread exists, every transfer under-collects
~1–2% and `fx_slippage` is silently absorbing a **provider cost that belongs in pricing**
(`QUOTE_FX_BUFFER_BPS`) and arguably a separate `provider_fees`-style account — not slippage.
**Status: open** — validate with real rates during the slice-7 pilot ("observe the real spread" item,
§9); decide the quote basis + account mapping then. [remittance-mvp.md](prds/remittance-mvp.md) §9,
ledger-rules.md.

**2026-07-20 · Immediate payout — no 30-minute hold; the Reg E tail is accepted.** Submit to
Bridge as soon as a transfer is `FUNDED`; `cancelable_until` is disclosure metadata, not a
submission gate. Research (12 CFR §1005.34 + CFPB official interpretations, primary sources): the
sender's cancellation right survives until funds are *picked up or deposited* — there is NO
exception for "already submitted to partner," and no safe harbor. Our disclosure's "unless
submitted for payout" wording is stricter than the law allows (counsel item; hard gate before
slice-7 real money). Accepted tail: a timely cancel while `SUBMITTED`/`IN_FLIGHT` legally requires
a full refund even though Bridge payouts are uncancelable — rare, bounded double-pay. Accepted
because: SPEI deposits in seconds (the right extinguishes almost immediately); the delay is not
attacker-farmable (delivery delay can't be caused on demand); the 3-business-day refund window
means the payout resolves first (if it failed, Bridge returns principal — the refund costs
nothing); per-transfer limits cap the worst case. Slice-6 refund rule keyed to state: `FUNDED` →
normal cancel; `SUBMITTED`/`IN_FLIGHT` → full refund within 3 business days (wait for payout
resolution first); `COMPLETED` → lawful denial. **Status: active**
([transfer-state-machine.md](transfer-state-machine.md)).

**2026-07-20 · Enqueue-after-commit + sweep healing, not a transactional outbox.** PostgREST RPC
and pg-boss can't share a transaction, so the state change commits first and the job is enqueued
after. All jobs are idempotent replays, so a lost enqueue costs at most ~1 minute of sweep latency
(`payout.sweep` re-enqueues unclaimed `FUNDED` rows and stale `received` payment_events) — never
correctness. Supersedes the transactional-outbox wording in earlier docs. **Status: active.**

**2026-07-20 · Crude aggregate float ceiling ships in slice 5.** Immediate payout is what makes
fronting risk real, so the submit job checks the aggregate `funding_receivable` balance against
the `FLOAT_CEILING_MINOR` env cap before creating a Bridge payout. A trip leaves the transfer
`FUNDED` with **no hold** — self-healing backpressure (the 1-min sweep retries as the balance
drains) plus a fingerprinted Sentry alert. Per-user limits, velocity checks, and the risk engine
remain slice 8. **Status: active** ([runbooks/payout-holds.md](runbooks/payout-holds.md)).

**2026-07-13 · Payout topology: pre-funded treasury wallet, one Bridge transfer per Puente
transfer.** Sandbox spike proved Bridge has no one-transfer fiat→SPEI route (`ach_push`/`ach`/`wire`
→ `spei` all rejected), and the wallet-USDC → MXN-SPEI payout leg works (`201` → `funds_received`
in seconds). So Puente assembles the stablecoin sandwich: payouts draw from a pre-funded USDC
treasury wallet with `destination.amount` fixed in MXN (recipient gets exactly the disclosed
amount; FX variance lands on our side as `fx_slippage`); replenishment is a separate batch onramp.
`bridge_wallet_float` added to the chart of accounts. **Status: active.**

**2026-07-13 · Send-money UI ships on web first.** Auth, sessions, KYC, and `/continue` routing are
already live on web; mobile follows once the flow is proven with the five trusted users.
**Status: active.**

**2026-07-13 · KYC stays Bridge-hosted (Persona) for the remittance MVP.** Closes the open
re-decision below: it's live, the SPEI endorsement flow is wired, and Sumsub adds an integration
project with zero MVP benefit. Revisit when lending or non-Bridge rails need their own identity
layer. **Status: active.**

**2026-07-10 · Stripe is the funding processor.** Stripe initially declined us (startup, money
transmission adjacency); that's resolved — Stripe handles USD intake (ACH first, card later), Bridge
remains the regulated rail, Puente never touches funds. Still wrapped behind the `FundingProcessor`
interface so this stays swappable. Superseded: the Plaid/Moov/Etogy shortlist in older docs.
**Status: active.** Open sub-item: confirm money-transfer MCC approval before relying on card funding.

**2026-07-10 · Live-money credentials are Joshua-only, including from agent sessions.** Bridge
`sk-live`, Stripe live keys, prod DB password, prod `service_role` are deliberately isolated;
the live Bridge key was rotated specifically so Claude Code sessions can't hold it. Work needing
live-key output is designed as a hand-Joshua-a-one-liner step. **Status: active policy.**

**2026-07-09/10 · Two-branch environment model with an approval-gated Promote (PRs #50, #51).**
`main` auto-deploys to staging only; the `production` branch is what's live and moves solely via the
Promote workflow — which applies prod migrations *first*, then fast-forwards the branch, all under
one GitHub environment approval. Chosen over tags because it makes "what is live" a branch pointer
and makes schema-before-code atomic with the same approval. **Status: active.**

**2026-07-09 · `TRUST_PROXY_HOPS=1`, never `trustProxy: true` (PR #49).** Rate limiting keys on the
real client IP by trusting exactly the Railway edge hop. Trusting the whole XFF chain would let an
attacker mint unlimited fresh rate-limit buckets (leftmost XFF is client-controlled) — strictly
worse than no trust. Railway appends the real client IP as the *rightmost* XFF entry. **Status: active.**

**2026-07-08 · KYC in production is Bridge-hosted (Persona), not Sumsub (PRs #36, #40, #41).** The
2026-06-25 pre-implementation decision picked Sumsub, but the shipped onboarding uses Bridge's
hosted KYC links (which required server-minted session-scoped ToS URLs, #41). **Status: OPEN —
superseded in practice, needs an explicit re-decision** for the remittance MVP: keep Bridge-hosted
(simpler, one vendor) or move to Sumsub behind `IdentityVerifier` (the lending stack will need its
own answer anyway). **Update 2026-07-13: resolved — Bridge-hosted for MVP (entry above).**

**2026-07-02 · Identity = phone number, forever.** One Supabase account per phone via SMS OTP; there
is no account merge or phone change flow. A shared test phone means a shared account — the cause of
a production 404 incident — hence Supabase test phone numbers for multi-tester work.
**Status: active** (revisit when phone-change support becomes a real user need).

**2026-06-30 · Web app has no direct Supabase access.** All web data writes go through the Fastify
API via `INTERNAL_API_URL`. One boundary for auth/audit/validation instead of two, and RLS stays a
backstop rather than a primary control surface. **Status: active.**

**2026-06-26 · USD-only ledger; MXN is display metadata.** Puente never custodies MXN — Bridge does
FX and SPEI — so there is no FX event in our books and no MXN ledger position, just disclosure
metadata on quotes/transfers. Kills a whole class of multi-currency bookkeeping bugs.
**Status: active** ([ledger-rules.md](ledger-rules.md)).

**2026-06-26 · Puente issues firm quotes and absorbs slippage.** Bridge offers no rate lock, but
Reg E demands firm numbers, so the quote is our commitment: customer rate = Bridge indicative minus
a buffer; execution variance books to `fx_slippage`. The buffer is a priced risk, reviewed via
reconciliation trends. **Status: active.**

**2026-06-25 · Instant payout with the `funding_cleared` gate as config.** We pay out before ACH
clears (accepting return risk) because launch is ~5 trusted users and iteration speed wins; the gate
exists from day one as a flag so flipping to wait-for-clearing (or per-transfer risk verdicts) is a
config change, not a redesign. The float ceiling is the one risk control on from day one.
**Status: active** ([transfer-state-machine.md](transfer-state-machine.md)).

**2026-06-25 · Postgres for everything async — no Redis, no SQS.** Job queue (pg-boss/Graphile),
transactional outbox *(superseded 2026-07-20 — see above: enqueue-after-commit, no shared
transaction)*, and schedules all live in the one database, so state changes and jobs commit
atomically and there's one system to operate. Revisit at real scale. **Status: active.**

**2026-06-25 · Bridge is the regulated entity.** Bridge holds the MTLs and does FX, stablecoin
orchestration, SPEI payout, and sanctions screening; Puente builds product on top and never touches
funds. This is what makes a two-person company viable in money transmission. **Status: active.**
Open: paper the exact division (SAR ownership, OFAC handoff) — pre-implementation-todo.

**2026-06-23 · `Money` type in `packages/shared` (PR #21).** Integer minor units + explicit
currency, no float constructors, defined once and imported everywhere. **Status: active.**

**2026-06 · Supabase MCP is scoped staging + read-only (PR #23).** Agent tooling can inspect schema
but cannot run destructive SQL or touch prod; migrations go through files + the pipeline only.
**Status: active.**

**2026-06 · Railway native GitHub integration owns API deploys (PR #39).** The custom Actions deploy
workflow was deleted; Railway builds on push to main with health-check-gated cutover, and branch
protection guarantees main is CI-green. Less machinery, same guarantee. **Status: active.**

**2026-06 · Turborepo with remote cache (PR #6); grouped Dependabot (PR #15); Gitleaks + branch
protection from the start (PR #2).** Standard-issue hygiene decisions, recorded here mostly so
nobody relitigates them: task-graph builds with caching, dependency bumps batched by ecosystem with
majors split out, and secret scanning as a required check. **Status: active.**

**2026-06 · Remittance and lending are separate stacks.** The cofounder owns lending; remittance is
pure money movement. Shared identity/credit substrate comes later — don't couple the codebases now.
**Status: active.**
