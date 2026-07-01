# Puente — Pre-Implementation To-Do

**Date:** 2026-06-25 (updated 2026-06-29)
**Scope:** USD → MXN remittance MVP (one send-money flow). Lending is a separate stack (cofounder owns it).

Status legend: **drafted** → reviewed → approved → implemented

Everything to settle or build before we write feature code. We tackle these one by one.

---

## Decisions locked
- **Stack:** Supabase (Postgres + Auth) + Railway. API-first — the Fastify API is the boundary so infra stays swappable.
- **Async layer:** Postgres-backed job queue (pg-boss or Graphile Worker) + transactional outbox + idempotency keys. `pg_cron` / Railway cron for schedules. No Redis, no SQS for MVP.
- **Rails:** Bridge is the MTL / regulated entity; handles FX, stablecoin orchestration, SPEI payout, and KYC/OFAC. We build the app on top.
- **Funding source = abstraction:** card/ACH now, LOC later. Never hardcoded.
- **Remittance and lending are separate stacks** to start.

## Open decisions — RESOLVED 2026-06-25
- [x] **Payout timing:** Instant payout for MVP — do **not** wait for ACH. Acceptable: launch is ~5 trusted users and we need fast iteration. Build the `funding_cleared` gate into the state machine now as a **config flag** (default: skip the wait) so we flip it on when we widen beyond trusted users — no rework.
- [x] **Supabase + PITR:** Pro plan now. Daily backups are an acceptable floor for the ~5 trusted-user phase; enable the PITR add-on (separate toggle, ≥ Small compute, billed hourly, start at 7-day retention) before widening beyond trusted users or moving real volume.
- [x] **KYC:** Bridge requires **us** to perform KYC and hand verified identity to them. Provider: **Sumsub** (LATAM doc coverage + bundled AML/watchlist + liveness). Wrap behind an `IdentityVerifier` interface so providers can be swapped/added later (e.g. the lending stack). Open: confirm with Bridge whether OFAC/sanctions screening is theirs or expected from our KYC.
- [x] **Limits:** No Puente-imposed limits for MVP (5 trusted users). Keep limit fields in the data model as config for later. Note: Bridge's own AML monitoring + BSA thresholds (e.g., CTR at $10k) still apply underneath us regardless.

## Design artifacts (the "before code" docs)
- [x] **ERD / data model** — drafted in `docs/erd.md`. Pending: explicit constraint names; `idempotency_keys` table (in skill checklist).
- [x] **Transfer state machine** — drafted in `docs/transfer-state-machine.md`. Pending review.
- [x] **Double-entry ledger rules** — drafted in `docs/ledger-rules.md`. Pending: Bridge fee treatment; FX/slippage amounts once sample Bridge quote available.
- [x] **API contract** — drafted in `docs/api-contract.md`. Pending: field-level Zod schemas; finalize after Bridge quote sample.
- [ ] **Flow / sequence diagrams** — send-money happy path, payout webhook, error resolution, cancel/refund.
- [ ] **Architecture diagram** — mobile, API, worker, Supabase, Railway, Bridge, Stripe, Twilio, PostHog, Sentry.
- [x] **`Money` type** in `packages/shared` — integer minor units + currency, no float constructors. Tests written.

## Compliance (design now, finish before launch)
- [ ] **Reg E disclosures** — prepayment disclosure (FX rate, fees, MXN received) + receipt; EN + ES, human-translated.
- [ ] **Confirm Bridge fee / FX-spread structure** — get a sample quote API response; blocks exact Reg E disclosure numbers and the ledger `provider_fees` booking.
- [ ] **Error-resolution process** (Reg E §1005.33) — intake + investigation path.
- [ ] **Cancellation handling** within the open window (wired into the state machine).
- [ ] **Confirm OFAC / KYC division with Bridge** — who screens, what data we pass, where the handoff sits.
- [ ] **Paper the Bridge MTL relationship** — states covered, our agent/platform role, SAR ownership, error-resolution responsibility.
- [ ] **Consent capture** — TCPA (SMS), E-SIGN (e-sign consent), privacy; each with its own timestamp.

## Infra & ops setup
- [ ] **Funding processor** — choose the ACH (+ debit card) processor; Stripe & Dwolla declined us (startup). Shortlist: **Plaid Transfer** (ACH/bank only), **Moov** (ACH + card, one integration), **Etogy** (card + ACH — vet stability/compliance). Apply in parallel; lead with "Bridge is the MTL." Wrap behind a **`FundingProcessor` interface** (swappable). Confirm quasi-cash / money-transfer MCC approval before relying on card funding.
- [ ] Paid Supabase + PITR; separate staging & prod projects.
- [ ] Railway services: API + worker; cron for reconciliation.
- [ ] Secrets via Doppler across all envs.
- [ ] Sentry + end-to-end trace IDs; alerts on stuck/failed transfers.
- [ ] Reconciliation job — ledger vs funding processor vs Bridge payout.
- [ ] Admin/ops console — view transfers, resolve stuck payout, process refund/cancel.
- [ ] Fraud & exposure guardrails — **float ceiling (cap aggregate fronted `funding_receivable`)**, amount caps, velocity limits, first-transaction holds.

---

*After these, implementation begins with the foundation slice (auth + consent + audit + RLS), then the send-money flow.*
