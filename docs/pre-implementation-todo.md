# Puente — Pre-Implementation To-Do

**Date:** 2026-06-25 (updated 2026-07-10)
**Scope:** USD → MXN remittance MVP (one send-money flow). Lending is a separate stack (cofounder owns it).

Status legend: **drafted** → reviewed → approved → implemented

Everything to settle or build before we write feature code. We tackle these one by one.

---

## Decisions locked
- **Stack:** Supabase (Postgres + Auth) + Railway. API-first — the Fastify API is the boundary so infra stays swappable.
- **Async layer:** Postgres-backed job queue (pg-boss) + enqueue-after-commit with sweep healing (outbox rejected — decisions.md 2026-07-20) + idempotency keys. pg-boss cron for schedules. No Redis, no SQS for MVP.
- **Rails:** Bridge is the MTL / regulated entity; handles FX, stablecoin orchestration, SPEI payout, and KYC/OFAC. We build the app on top.
- **Funding source = abstraction:** card/ACH now, LOC later. Never hardcoded.
- **Remittance and lending are separate stacks** to start.

## Open decisions — RESOLVED 2026-06-25
- [x] **Payout timing:** Instant payout for MVP — do **not** wait for ACH. Acceptable: launch is ~5 trusted users and we need fast iteration. Build the `funding_cleared` gate into the state machine now as a **config flag** (default: skip the wait) so we flip it on when we widen beyond trusted users — no rework.
- [x] **Supabase + PITR:** Pro plan now. Daily backups are an acceptable floor for the ~5 trusted-user phase; enable the PITR add-on (separate toggle, ≥ Small compute, billed hourly, start at 7-day retention) before widening beyond trusted users or moving real volume.
- [x] **KYC:** Bridge requires **us** to perform KYC and hand verified identity to them. Provider: **Sumsub** (LATAM doc coverage + bundled AML/watchlist + liveness). Wrap behind an `IdentityVerifier` interface so providers can be swapped/added later (e.g. the lending stack). Open: confirm with Bridge whether OFAC/sanctions screening is theirs or expected from our KYC.
- [~] **Limits:** ~~No Puente-imposed limits for MVP (5 trusted users).~~ **SUPERSEDED 2026-07-17** — per-user limits + velocity checks are now **MVP-required** (the instant-front policy makes them load-bearing; PRD §1 / §10, slice 8). Limit fields stay in the data model as config. Note: Bridge's own AML monitoring + BSA thresholds (e.g., CTR at $10k) still apply underneath us regardless.

## Design artifacts (the "before code" docs)
All four core docs **reviewed for cross-consistency 2026-07-10** (states, accounts, transitions, and
endpoint maps align). Open items below.
- [x] **ERD / data model** — `docs/erd.md`, reviewed. `idempotency_keys` table added 2026-07-10. Topology question **resolved 2026-07-13** (sandbox spike): pre-funded treasury wallet; one Puente transfer = one Bridge payout transfer; `bridge_wallet_float` adopted in ledger. Pending: explicit constraint names (in skill checklist).
- [x] **Transfer state machine** — `docs/transfer-state-machine.md`, reviewed.
- [x] **Double-entry ledger rules** — `docs/ledger-rules.md`, reviewed. Pending: Bridge fee treatment (PoC key rotated — pull `receipt` objects with a fresh key); card-funding postings + possible `bridge_wallet_float` account (flagged in doc).
- [x] **API contract** — `docs/api-contract.md`, reviewed (Moov→Stripe, dispute-state scope tightened). Pending: field-level Zod schemas; finalize fee numbers after Bridge receipt sample.
- [x] **Flow / sequence diagrams** — `docs/flows.md` (send-money happy path, payout webhook, error resolution, cancel/refund) — 2026-07-10.
- [x] **Architecture diagram** — `docs/architecture.md` — 2026-07-10.
- [x] **Engineering runbooks** — `docs/runbooks/` (deploy & promote, migrations, local dev, secrets) — 2026-07-10.
- [ ] **Ops process runbooks** — unreviewed drafts in `docs/runbooks/proposals/` (error resolution, stuck transfer, funding reversal, reconciliation); the processes themselves are **not yet decided** — review/adopt/rewrite before launch.
- [x] **`Money` type** in `packages/shared` — integer minor units + currency, no float constructors. Tests written.
- [x] **Bridge production PoC** — real USD moved personal bank → Bridge wallet (USDC) → business bank via `scratch/bridge-smoke/bridge-poc.js`; both legs confirmed delivered (2026-07-10). Proves: customer/external-account/wallet flow, two-leg USD routing, deposit instructions, transfer states.

## Compliance (design now, finish before launch)
- [ ] **Reg E disclosures** — prepayment disclosure (FX rate, fees, MXN received) + receipt; EN + ES, human-translated.
- [x] **Confirm Bridge fee / FX-spread structure** — RESOLVED 2026-07-13 from production PoC receipts: no explicit Bridge fees (all 0.0, netted-model receipts); Bridge monetizes via FX spread (`buy_rate` vs midmarket). Quotes price off `buy_rate`; `provider_fees` mainly carries Stripe costs (see ledger-rules.md). Remaining: observe real USD→MXN spread at the first pilot send.
- [ ] **Error-resolution process** (Reg E §1005.33) — unadopted proposal in `docs/runbooks/proposals/error-resolution.md`; process undecided, needs counsel review.
- [ ] **Cancellation handling** within the open window (wired into the state machine).
- [ ] **Confirm OFAC / KYC division with Bridge** — who screens, what data we pass, where the handoff sits.
- [ ] **Paper the Bridge MTL relationship** — states covered, our agent/platform role, SAR ownership, error-resolution responsibility.
- [ ] **Consent capture** — TCPA (SMS), E-SIGN (e-sign consent), privacy; each with its own timestamp.

## Infra & ops setup
- [x] **Funding processor — RESOLVED 2026-07-10: Stripe.** Initially declined, now unblocked — Stripe handles USD intake (ACH first, card second); Bridge is the remittance rail and MTL holder; Puente never touches funds. Still wrapped behind the **`FundingProcessor` interface** (swappable). Remaining: confirm quasi-cash / money-transfer MCC approval before relying on card funding.
- [ ] Paid Supabase + PITR; separate staging & prod projects.
- [x] Railway services: API + worker; cron for reconciliation. Worker service + housekeeping crons (`transfer.reconcile-pending`, `payout.sweep`, `payout.poll`, `idempotency.purge`) shipped in slice 5 (prod worker deferred to slice 7 — staging only today). The three-way ledger↔Stripe↔Bridge reconciliation is the separate open item below.
- [x] Secrets via Doppler across all envs. Live — see `runbooks/secrets.md`.
- [~] Sentry + end-to-end trace IDs; alerts on stuck/failed transfers. Sentry wired; slice-5 alerts live (float-ceiling trip, Bridge `in_review` >1h, payout holds). The **general** stuck-transfer alert (any non-terminal state past a threshold) is still slice 8.
- [ ] Reconciliation job — ledger vs funding processor vs Bridge payout. Unadopted design sketch in `docs/runbooks/proposals/reconciliation.md`; decide the process, then build the cron with the worker.
- [ ] Admin/ops console — view transfers, resolve stuck payout, process refund/cancel.
- [~] Fraud & exposure guardrails — **float ceiling (cap aggregate fronted `funding_receivable`)** shipped in slice 5; amount caps, velocity limits, per-user exposure caps, and first-transaction holds are still slice 8.
- [x] **Rate-limit keying behind proxies** — implemented 2026-07-09 (`TRUST_PROXY_HOPS`, default 1; semantics pinned in `apps/api/src/config/trust-proxy.test.ts`). Remaining (Joshua, dashboards): confirm Supabase per-phone SMS OTP limits/cooldown + Twilio spend cap; after staging deploy, confirm audit-log `ip` matches a real client IP (bump `TRUST_PROXY_HOPS` if not). Original context: `apps/api/src/server.ts` has no `trustProxy`, so `@fastify/rate-limit` keys on the proxy's address — users share buckets (collateral limiting) and per-client limits are meaningless. Fix: `trustProxy: 1` (trust exactly the Railway edge hop) after empirically confirming chain depth on staging. **Never `trustProxy: true`** — the leftmost `X-Forwarded-For` is client-controlled, so trusting the whole chain lets an attacker rotate fake XFF values for unlimited fresh buckets (a bypass, strictly worse). **Do not key the limiter on `x-client-ip`** (the slice-4 sign-in-events header): the routes are public and the header is spoofable; only safe behind a shared-secret internal header (Doppler) proving the request came from our web tier — build only if actually needed. The control that protects Twilio SMS spend is per-**phone**, not per-IP: confirm GoTrue's built-in per-phone OTP limits/cooldown are configured + a Twilio spend cap is set — that may resolve most of this. Note `@fastify/rate-limit`'s in-memory store resets per deploy/replica (fine at current scale; no Redis). `trustProxy` also changes the IP recorded by the audit plugin and the `sign_in_events` fallback — desirable, but re-verify tests. Security-reviewer before merge.

---

*After these, implementation begins with the foundation slice (auth + consent + audit + RLS), then the send-money flow.*
