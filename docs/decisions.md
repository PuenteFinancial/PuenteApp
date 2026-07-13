# Decision Log

**Started:** 2026-07-13 (seeded retroactively from PR history, design docs, and session notes).
One dated paragraph per decision: what, why, status. Newest first. Add an entry whenever a choice
would make a future engineer ask "why on earth…" — that question is the inclusion test.

---

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
own answer anyway).

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
transactional outbox, and schedules all live in the one database, so state changes and jobs commit
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
