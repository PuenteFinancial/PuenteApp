# Puente — Pre-Implementation To-Do

**Date:** 2026-06-25
**Scope:** USD → MXN remittance MVP (one send-money flow). Lending is a separate stack (cofounder owns it).

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
- [ ] **ERD / data model** — users, kyc_records, recipients, quotes, transfers, ledger_entries, payment_events, audit_log; RLS plan per table.
- [x] **Transfer state machine** — v1 drafted in `docs/transfer-state-machine.md` (PENDING_PAYMENT → FUNDED → SUBMITTED → IN_FLIGHT → COMPLETED + exception states; `funding_cleared` gate; cancellation window). Pending review.
- [ ] **Double-entry ledger rules** — account taxonomy, posting rules per event, invariants ("sum of entries = balance", money never created or destroyed).
- [ ] **API contract** — v1 endpoints, Zod input/response schemas, error taxonomy, idempotency-key convention.
- [ ] **Flow / sequence diagrams** — send-money happy path, payout webhook, error resolution, cancel/refund.
- [ ] **Architecture diagram** — mobile, API, worker, Supabase, Railway, Bridge, Stripe, Twilio, PostHog, Sentry.
- [ ] **`Money` type** in `packages/shared` — integer minor units + currency, no float constructors.

## Compliance (design now, finish before launch)
- [ ] **Reg E disclosures** — prepayment disclosure (FX rate, fees, MXN received) + receipt; EN + ES, human-translated.
- [ ] **Error-resolution process** (Reg E §1005.33) — intake + investigation path.
- [ ] **Cancellation handling** within the open window (wired into the state machine).
- [ ] **Confirm OFAC / KYC division with Bridge** — who screens, what data we pass, where the handoff sits.
- [ ] **Paper the Bridge MTL relationship** — states covered, our agent/platform role, SAR ownership, error-resolution responsibility.
- [ ] **Consent capture** — TCPA (SMS), E-SIGN (e-sign consent), privacy; each with its own timestamp.

## Infra & ops setup
- [ ] Paid Supabase + PITR; separate staging & prod projects.
- [ ] Railway services: API + worker; cron for reconciliation.
- [ ] Secrets via Doppler across all envs.
- [ ] Sentry + end-to-end trace IDs; alerts on stuck/failed transfers.
- [ ] Reconciliation job — ledger vs Stripe funding vs Bridge payout.
- [ ] Admin/ops console — view transfers, resolve stuck payout, process refund/cancel.
- [ ] Fraud guardrails — amount caps, velocity limits, first-transaction holds.

---

*After these, implementation begins with the foundation slice (auth + consent + audit + RLS), then the send-money flow.*
