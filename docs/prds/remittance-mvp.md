# PRD — Remittance MVP: USD → MXN Send-Money Flow

**Owner:** Joshua
**Build target:** Claude Code
**Goal:** ~5 trusted, KYC-approved users can send USD to a Mexican bank account (SPEI via CLABE)
from the web dashboard, with every cent recorded in a double-entry ledger, Reg E disclosures at the
right moments, and a state machine that can't lie. Definition of done: **one real send through the
product** (~$20, Joshua → own test recipient), with the books balanced.

**Context:** Everything before this was preparation. The design docs (`erd.md`,
`transfer-state-machine.md`, `ledger-rules.md`, `api-contract.md`, `flows.md`) are reviewed and
cross-consistent. The Bridge production PoC moved real money both legs (2026-07-10). The payout
topology and fee spikes are resolved (2026-07-13, PR #65): pre-funded treasury wallet, one Puente
transfer = one Bridge payout transfer, Bridge monetizes via FX spread inside `buy_rate`. Onboarding
+ account lifecycle are live in production. The build order below was agreed 2026-07-13; this PRD
turns it into slice specs.

---

## 1. What we're building

Eight slices, ordered. Each is one PR. Slices 1–7 are the critical path to the pilot send; 8 is
required before anyone but Joshua uses it.

1. **Ledger core** — ledger tables, chart of accounts, posting engine. Pure TDD, no external deps, no routes.
2. **Recipients + payout destinations** — recipient CRUD, CLABE validation, Bridge external accounts, minimal dashboard UI.
3. **Quotes** — firm time-boxed offers priced off Bridge `buy_rate` minus buffer.
4. **Transfers + disclosure + funding** — the state machine, transfer tables, Reg E prepayment disclosure, Stripe ACH confirm.
5. **Payout + async layer** — pg-boss worker, `funding_cleared` gate, Bridge payout, webhooks + polling.
6. **Cancel/refund + receipts** — 30-min cancel window, refund postings, Reg E receipt.
7. **Web send UI + pilot send** — the dashboard send flow end-to-end, then the real ~$20 send.
8. **Ops floor** — reconciliation cron, stuck-transfer alerts, float ceiling, per-user
   exposure cap + velocity checks.

### Decisions locked

- **Build order agreed 2026-07-13** (memory + spike session): ledger → recipients → quotes →
  transfer+disclosure+funding → worker/payout → cancel/refund → send UI → pilot send.
- **One refinement to that agreement (2026-07-14):** the original phrasing was "money-tables
  migrations + ledger posting engine" in slice 1. This PRD lands **only the ledger tables in
  slice 1**; every other table ships in the slice that consumes it (recipients in 2, quotes in 3,
  transfers/disclosures/idempotency in 4, payment_events in 5). Rationale: each table gets
  `financial-schema-checklist` scrutiny next to the code that exercises it, and no PR reviews a
  mega-migration in the abstract. Consequence: `ledger_transactions.transfer_id` ships as a
  nullable UUID without FK; slice 4 adds the FK when `transfers` exists.
- **UI surface: web dashboard** (`apps/web`). Mobile (Expo) comes after the rail is proven.
  Recipients get minimal UI in slice 2 (low-risk CRUD); the send flow UI is deliberately **last**
  (slice 7) so the rail is built and tested API-first.
- **Funding: Stripe ACH only** for MVP. Card is rail #2, blocked on posting rules
  (ledger-rules.md "Pending") and MCC confirmation.
- **Instant payout** (2026-06-25 decision): don't wait for ACH to clear. The `funding_cleared`
  gate ships as a config flag, default off.
- **Per-user limits and velocity checks are required for MVP** (2026-07-17, reversing the
  earlier "no Puente-imposed limits" call). The instant-front policy makes them load-bearing,
  not risk-engine polish: ACH has no balance check at initiation, and a sender's bank balance
  doesn't reflect in-flight debits — only our ledger knows the in-flight exposure. They ship in
  slice 8 alongside the **float ceiling** (config values, authoritative check at
  `FUNDED → SUBMITTED`) — see §10 for the controls and rationale.

### Where reality diverges from the design docs

The design docs predate the onboarding build. Deltas, so nobody re-litigates them mid-slice:

- **`public.users` plays the ERD's `profiles` role.** No separate `profiles` table. Field mapping:
  `first_name`/`last_name` (not `full_name`), `preferred_language` (not `preferred_locale`),
  `bridge_customer_id` (the ERD's `provider_customer_ref`). `risk_tier` doesn't exist yet — add it
  only when something reads it.
- **KYC is Bridge-hosted, not Sumsub.** Users are already KYC-approved through Bridge
  (`users.kyc_status`). The ERD's `kyc_records` table and the api-contract's `/v1/kyc/*` + Sumsub
  webhook are **deferred**. `IdentityVerifier` remains the abstraction if a second provider arrives.
- **Auth endpoints exist** (`/v1/auth/*`), as do the audit plugin, rate limiting
  (`TRUST_PROXY_HOPS`), and consent timestamps on `users`. The ERD's append-only `consents` table
  is deferred until a consent needs versioning we don't have.

---

## 2. Non-goals

- No mobile app changes.
- No card funding, no LOC — `funding_source_type` stays the abstraction hook.
- No lending anything (separate stack).
- No admin console — runbook-driven scripts are acceptable at 5 users (slice 8 decides the minimum).
- No first-transaction holds or amount tiers — deferred to the risk engine. (Per-user limits
  and velocity checks are **no longer** non-goals — in scope since 2026-07-17, slice 8, §10.)
- No email infrastructure — status via in-app polling (same decision as lifecycle slice 5);
  receipts viewable in the dashboard, email delivery deferred.
- No corridors beyond USD → MXN bank deposit (SPEI). No cash pickup, no wallets.
- No dispute/`UNDER_REVIEW` flow UI — the state + `disputes` table exist (slice 4 migration), but
  error-resolution process is pending counsel; ops handles by runbook.

---

## 3. Slice 1 — Ledger core

The double-entry ledger from `ledger-rules.md`, as schema + a posting service. Nothing user-facing;
pure TDD, no external dependencies. Everything later posts through this.

### Migrations (follow `financial-schema-checklist` + `migration` skills)

Three tables per the ERD, one migration:

- **`ledger_accounts`** — `code` (UNIQUE), `name`, `type` (`asset`|`liability`|`revenue`|`expense`),
  `normal_balance` (`debit`|`credit`), `currency` (`USD`), `owner_scope` (`platform`).
  Seed the full **10-account chart** in the same migration (incl. `bridge_wallet_float` —
  ledger-rules.md chart is authoritative).
- **`ledger_transactions`** — `transfer_id UUID` (nullable, **no FK yet** — slice 4 adds it;
  replenishment batches keep it NULL forever), `transition TEXT` (nullable for non-transfer
  events), `idempotency_key TEXT UNIQUE` (convention: `{transfer_id}:{transition}` for transfer
  postings), `description`, `posted_at`.
- **`ledger_entries`** — `ledger_transaction_id` FK, `account_id` FK, `direction`
  (`debit`|`credit`), `amount_minor BIGINT CHECK (> 0)` (direction carries the sign),
  `currency TEXT`.

Enforcement **in the database**, not just the service:

- RLS enabled, deny-by-default, **service-role only** on all three — no owner policies; clients
  never see raw ledger rows.
- **Append-only:** no UPDATE/DELETE path on `ledger_transactions` + `ledger_entries` (revoke at
  the role level per the ERD convention); corrections are new transactions.
- **Net-zero trigger:** a deferred constraint trigger validates each transaction's entries net to
  zero per currency at commit. Reject otherwise.
- FKs indexed: `ledger_entries(ledger_transaction_id)`, `ledger_entries(account_id)`.

### Posting service — `apps/api/src/services/ledger.ts`

- `postLedgerTransaction({ transferId, transition, description, entries })` — entries as
  `{ accountCode, direction, money: Money }` using `Money` from `@puente/shared`.
  - Validates balanced-per-currency and positive integer amounts **before** the DB (the trigger is
    the backstop, not the primary control).
  - Inserts transaction + entries atomically in one DB transaction.
  - Idempotent: on idempotency-key conflict, read back and return the existing transaction — a
    retried worker job posts exactly once, and the caller can't distinguish a replay.
- `getAccountBalance(accountCode)` — `SUM(entries)` signed by direction vs. `normal_balance`.
  Derived, never stored. This is what the float ceiling reads in slice 8.
- No routes. No changes to `apps/web`.

### Tests (Vitest; this slice is mostly tests)

- Unbalanced posting rejected at the service layer **and** at the DB trigger (bypass the service
  to prove the trigger).
- Zero/negative/non-integer amounts rejected. A batch that nets per-currency passes; netting only
  across currencies fails.
- Idempotent replay: same key posts once, returns the original.
- UPDATE/DELETE on posted rows fails at the DB.
- The **worked example from ledger-rules.md** runs end-to-end: FUNDED, SUBMITTED (with
  replenishment), COMPLETED, ACH-clears → assert final balances and the conservation invariant
  (`cash +1.50 = fee_revenue 2 − provider_fees 0.50`).
- Balance math correct for both normal-balance directions.

### Guardrails

- security-reviewer before merge (financial logic).
- No PII in these tables — `description` is system-generated, never user input.

---

## 4. Slice 2 — Recipients + payout destinations

First user-facing piece. `recipients` + `payout_destinations` tables per the ERD, CRUD routes per
the api-contract, minimal dashboard UI to add "Mom in Guadalajara — BBVA ····1234".

- CLABE validation (18 digits + check digit) server-side; `details` JSONB with sensitive fields
  encrypted server-side.
- Bridge external-account registration (`provider_account_ref`, `verification_status`) **at
  destination create**, so failures surface early (sandbox artifacts exist for testing — see
  memory).
- Owner-scoped RLS; archive, never delete. i18n en + es. security-reviewer (PII).

*(Detailed spec written when the slice starts — same pattern as account-lifecycle.)*

---

## 5. Slice 3 — Quotes

`quotes` table + `POST /v1/quotes` / `GET /v1/quotes/:id` per the api-contract, priced off Bridge
**`buy_rate`** minus the FX buffer (ledger-rules "no rate lock": the quote is *our* firm
commitment; slippage is ours to absorb).

- `total_amount = send_amount + fee_amount` invariant; `fx_rate` as fixed-scale decimal string.
- Buffer size, Puente fee, and expiry window are config; initial values set from observed sandbox
  spread (~0.5%).
- Rate fetch goes in `apps/api/src/services/bridge.ts` (exists); `rate_unavailable` on failure.
- No disclosure yet — that's generated at transfer creation (slice 4), per the api-contract.

---

## 6. Slice 4 — Transfers + disclosure + funding

The state machine becomes real: `transfers`, `transfer_transitions`, `idempotency_keys`,
`disclosures`, `disputes` tables (+ the deferred FK on `ledger_transactions.transfer_id`);
`POST /v1/transfers` (create from quote, snapshot terms, generate the **Reg E prepayment
disclosure**), `POST /v1/transfers/:id/confirm` (record acceptance → Stripe ACH PaymentIntent),
`GET /v1/transfers[/:id]`; `Idempotency-Key` header middleware; the Stripe funding webhook driving
`PENDING_PAYMENT → FUNDED` with its ledger posting.

- State transitions only via a single transition function (row lock, append `transfer_transitions`,
  post ledger batch) — never a bare UPDATE.
- Stripe behind the `FundingProcessor` interface.
- Disclosure content: en + es; machine-ES acceptable for the pilot send to self, **human-reviewed
  before real users** (Joshua's track).
- **Blocked by (human):** Stripe account + MCC approval for money transmission.
- security-reviewer + compliance-reviewer before merge.

---

## 7. Slice 5 — Payout + async layer

The money moves: pg-boss worker (new Railway service), `payment_events` table, Bridge webhook
receiver (signature-verified — same RSA scheme as the KYC webhook — dedupe on
`(source, external_event_id)`, ack fast, process async), the `FUNDED → SUBMITTED` job (Bridge
payout with fixed MXN `destination.amount`; the synchronous `source.amount` draw books slippage
inside the SUBMITTED batch per ledger-rules), `IN_FLIGHT`/`COMPLETED`/`PAYOUT_FAILED` transitions,
polling fallback for sandbox/dev.

- `funding_cleared` gate wired as config, default off (instant payout).
- **FX submission backstop (decided 2026-07-18, required):** before the `FUNDED → SUBMITTED`
  Bridge call, the worker checks quote age and rate drift
  (`|live buy_rate − source_rate| / source_rate` vs `FX_MAX_DRIFT_BPS`, ~150–200 default;
  `source_rate` joins via `transfers.quote_id`). Tripped → do NOT submit; stay `FUNDED`,
  Sentry alert, ops chooses manual release (accept known slippage) or cancel + **full refund**
  (always Reg E-clean — Wise's model). Caps the unbounded-slippage tail on transfers stuck
  behind a float-ceiling trip / dry treasury / downed worker. Fires ~never by design; the
  50 bps buffer prices the normal 15-min quote window. (A pre-quote volatility pause was
  considered and deferred to slice 8.)
- Treasury wallet pre-funded manually for MVP (runbook step); replenishment posting exists from
  slice 1. Treasury wallet is owned by the **Puente Financial business customer** (KYB in
  progress as of 2026-07-15), not a personal customer. Shared-wallet cross-customer sourcing
  verified in sandbox 2026-07-15 (business wallet → `on_behalf_of` individual → delivered).
- **Stamp `client_reference_id` = our transfer UUID on every Bridge transfer** — makes
  Bridge-side records joinable to ours for reconciliation (verified accepted in sandbox).
- Sandbox-verified constraints to build against (2026-07-15): concurrent payouts serialize at
  Bridge (loser gets a synchronous 400, no transfer created — retry after replenishment);
  Bridge payouts are never cancelable after creation (a timely Reg E cancel after submission is
  honored as a full refund — §1005.34's right survives to pickup/deposit, no submitted-exception;
  see decisions.md 2026-07-20); same Idempotency-Key with different body → Bridge 422; MXN destination
  minimum $2.00 USD equivalent.
- End-to-end in **sandbox** here (API-driven); the real-money send waits for slice 7.
- Open question for Bridge (deferred): where do funds land when a SPEI payout fails
  post-submission (`returned`/`undeliverable`)? Handle those webhook states defensively.
- **Payability gate must join the recipient (deferred from slice 2, Codex review 2026-07-17):**
  destination-create and recipient-archive are separate non-transactional writes, so a race can
  leave an `active` destination under an `archived` recipient. The gate that matters is at payout
  time: require `payout_destinations.status = 'active'` **AND** `recipients.status = 'active'`
  **AND** `provider_account_ref IS NOT NULL` in the same query. Optional hardening (nice-to-have
  here or later): DB trigger on destination insert taking `FOR KEY SHARE` on the recipient row +
  moving the archive cascade into a single transactional function (flip ordering: recipient
  first — safe once atomic).
- security-reviewer before merge.

---

## 8. Slice 6 — Cancel/refund + receipts

`POST /v1/transfers/:id/cancel` (FUNDED-only, `payment_at + 30 min` window, row-lock re-check,
CANCELED → REFUNDED postings incl. Stripe refund — full amount incl. fee per Reg E),
`GET /v1/transfers/:id/receipt` + receipt `disclosures` row on COMPLETED.

Cancellation semantics from the 2026-07-18 Reg E review (§1005.34 + commentary):
- The reg's extinguishing event is funds **picked up or deposited**, not "submitted": a cancel
  request landing post-`SUBMITTED`/pre-`COMPLETED` (a seconds-wide sliver on SPEI) routes to the
  refund/error-resolution path, never a flat denial.
- The 30-min clock runs from payment **authorization** (confirm), per official commentary; our
  `cancelable_until` (set at FUNDED) opens and closes later — customer-favorable, therefore
  compliant. A cancel while still `PENDING_PAYMENT` (post-confirm, pre-webhook) = void the
  payment intent.
- Refund = total incl. fees and taxes within **3 business days** of the request.
- Counsel item (already flagged in transfer-state-machine.md): disclosure says "submitted for
  payout" where the reg says "picked up or deposited" — reconcile wording before launch.

---

## 9. Slice 7 — Web send UI + pilot send

The dashboard flow: pick recipient → amount → quote (rate + fee + MXN received) → prepayment
disclosure → confirm → fund → status timeline (poll `GET /v1/transfers/:id`) → receipt. Transfer
history list. en + es throughout.

- Ends with the **real pilot send**: ~$20, production, Joshua → own Mexican test recipient.
  Observe the real USD→MXN spread and receipt lines (open item in ledger-rules) and record them.
  **Specifically resolve the buy_rate-vs-execution question** (decisions.md 2026-07-21): compare
  Bridge's actual USDC draw against the `exchange_rates` `buy_rate` we quoted; if there's a
  systematic spread, move it out of `fx_slippage` into pricing (`QUOTE_FX_BUFFER_BPS`) / a
  provider-cost account. Sandbox can't answer this — its rate feed is frozen.
- **Pre-real-money verification carried over from slice 5** (all validated in sandbox, need a real
  pass here): real Bridge `transfer.*` webhook delivery + signature against the prod endpoint
  driving `SUBMITTED → COMPLETED` (slice-5 e2e used synthetic webhooks; the sandbox transfer stalls
  at `funds_received`); stand up the **prod worker service** (`railway.worker.toml`, `prd_main`
  synced) — deferred here because the mock-funding lock keeps prod inert until real funding.
- compliance-reviewer (disclosure presentation is consent-adjacent).

---

## 10. Slice 8 — Ops floor

Before anyone but Joshua sends: daily reconciliation job (ledger vs. Stripe vs. Bridge via
`payment_events` + external refs — **adopt or rewrite the proposal runbook first**, it's
undecided), Sentry alert on transfers stuck in a non-terminal state past a threshold, the **float
ceiling** at `FUNDED → SUBMITTED` reading `getAccountBalance('funding_receivable')`, the
**per-user exposure controls** below, and the minimal ops capability the runbooks require
(scripts over console).

### Per-user exposure controls (added 2026-07-17)

Why these are MVP-required and not risk-engine polish: ACH has no balance check at initiation,
and the sender's bank balance doesn't reflect in-flight debits — a user with $500 can send $500
three times, all accepted; the first clears, the rest bounce R01 **after** the MXN is irrevocably
delivered. An external balance check (e.g. Plaid) doesn't fix this — the balance reads $500 every
time. Only our ledger knows the in-flight exposure, and honest users can trip this by accident.

- **Per-user outstanding-uncleared cap** — block when the SUM of the user's not-yet-cleared
  `funding_receivable` entries would exceed a config value. Same query shape as the float
  ceiling, filtered by user: `funding_receivable` ledger entries carry `transfer_id`
  attribution. Pilot-simple variant: **one in-flight transfer per user** until its ACH clears.
- **Velocity checks** — count and amount per rolling window (config values).
- **Enforcement points:** transfer creation (or quote creation) for UX, so users get a clear
  error early; the `FUNDED → SUBMITTED` gate as the **authoritative backstop** — the same
  checkpoint as the float ceiling, matching transfer-state-machine.md "Limits & holds".

---

## 11. Sequencing & sizing

| # | Slice | Size | Depends on | Blocked by (human track) |
|---|---|---|---|---|
| 1 | Ledger core | M | — | — |
| 2 | Recipients + destinations | M | — | — |
| 3 | Quotes | S | 2 (destination required on quote) | — |
| 4 | Transfers + disclosure + funding | L | 1, 3 | Stripe MCC approval |
| 5 | Payout + async | L | 4 | treasury wallet funded |
| 6 | Cancel/refund + receipts | M | 5 | — |
| 7 | Send UI + pilot send | M | 6 | disclosure copy (pilot: machine-ES ok) |
| 8 | Ops floor | M | 5 | reconciliation process decision |

1 and 2 are independent — 2 can start while 1 is in review.

**Human track (Joshua, in parallel):** Stripe MCC confirmation (blocks 4) · counsel scoping email
for Reg E disclosure/error-resolution (longest lead time; blocks real users, not pilot) · Bridge
MTL papering + OFAC division (blocks public launch) · human ES translation of disclosure copy ·
Supabase PITR toggle (before widening) · Twilio spend cap + per-phone OTP limit confirmation.

---

## 12. Acceptance criteria (MVP-level)

- [ ] A KYC-approved user on the web dashboard: adds a recipient + CLABE → firm quote → Reg E
      prepayment disclosure → confirms → funds via Stripe ACH → recipient receives the **exact
      disclosed MXN amount** via SPEI → sender sees COMPLETED + receipt.
- [ ] Every state transition has a `transfer_transitions` row and exactly one balanced
      `ledger_transactions` batch; replayed webhooks/jobs never double-post.
- [ ] After the pilot send, every ledger account's `SUM` matches the worked-example shape;
      conservation invariant holds.
- [ ] Cancel within 30 min of payment fully refunds, including the fee.
- [ ] No client ever talks to Stripe/Bridge directly; no PII in logs or URLs; all money integer
      minor units; `fx_rate` never a float.
- [ ] Every slice: Fastify schemas, tests alongside, typecheck green, security-reviewer on
      financial logic, compliance-reviewer on consent-adjacent UI.

---

## 13. Reference

- Design docs: `docs/erd.md` · `docs/transfer-state-machine.md` · `docs/ledger-rules.md` ·
  `docs/api-contract.md` · `docs/flows.md` · `docs/architecture.md`
- Spikes/PoC: production two-leg PoC 2026-07-10; topology + slippage-timing spike 2026-07-13
  (PR #65). Fee resolution: ledger-rules.md §Provider-fee placement.
- Sandbox artifacts for slice 2+ testing: customer `d4305c9a…`, MXN external account
  `def2c782-…7329` (dummy CLABE), wallet `4a810de0-…ed29` (base) — see session memory.
- Prior PRDs: `user-onboarding.md`, `account-lifecycle.md` (the slice-per-PR pattern this follows).
