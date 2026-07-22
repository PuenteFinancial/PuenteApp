# Slice 6 — Cancel / Refund + Receipts

## Context

The USD→MXN remittance rail is built API-first. Slices 1–5 shipped the ledger, recipients, quotes,
transfers, funding intake, and the async payout layer (pg-boss worker, `payment_events` inbox, Bridge
webhook/poll, `FUNDED→SUBMITTED→…→COMPLETED`). Slice 5 was promoted to prod 2026-07-21. **Slice 6 is
the "undo + proof" slice**: let a sender cancel a funded transfer and get their money back (Reg E),
post the outcome into the double-entry ledger, and expose a receipt. It's the last rail slice before
slice 7 (web send UI + first real-money pilot), which depends on it.

Slice 5 deliberately left three seams for slice 6: the **cancel side** of the payout-vs-cancel race
guard (the submit side already shipped), the **refund ledger postings** for `PAYOUT_FAILED→REFUNDED`
(stubbed state-move-only), and the **receipt** disclosure + endpoint.

This plan was stress-tested via `/grill-with-docs` (2026-07-21); the decisions below reflect that
session, and the domain-model artifacts to write are listed under **Domain model updates**.

## Decisions

**Locked at kickoff:** three PRs (cancel · async refund tail · receipts); refund via the mock
funding seam (real Stripe deferred to slice 7); disclosure-wording counsel item deferred to slice 7
(reuse existing Reg E copy verbatim).

**Locked in grilling:**
1. **Cancel-at-`FUNDED` is a VOID, not a refund** — nothing has been paid out and no float is fronted
   yet, so the sender's uncleared inbound ACH is *voided*; the ledger is a clean reversal of the
   FUNDED batch. (Assumption to verify in slice 7: real Stripe ACH is cancelable inside the 30-min
   window; if not, slice 7 adds a refund fallback.)
2. **The funding seam gets two methods, both in PR1:** `voidFunding()` (cancel an uncleared pull →
   real Stripe: cancel the PaymentIntent) and `refund()` (return collected funds → real Stripe:
   create a Refund). Distinct ops, distinct ledger batches.
3. **Two-verb model:** PR1 *voids*, PR2 *refunds-from-float*. Not a contradiction — the verb tracks
   where the money actually is (never moved vs moved-and-returned). `PAYOUT_FAILED→REFUNDED` keeps
   the [ledger-rules.md](/docs/ledger-rules.md) template unchanged.
4. **The cancel guard lives in a new `cancel_transfer` RPC** — one atomic transaction, mirroring the
   existing specialized `create_transfer_from_quote`; `transition_transfer` is left untouched.
5. **Human-gate the first REAL payout-failure refunds** — slice 6 builds the full auto path
   (mock-safe), gated by a default-safe `AUTO_REFUND` flag (mechanism-now / policy-via-flag, same as
   `funding_cleared` + the float ceiling). Real failures stop at `PAYOUT_FAILED` + ops alert until
   Bridge return semantics are verified in the pilot.
6. **`SUBMITTED`/`IN_FLIGHT` cancel → lightweight compliant response** (not a flat 409): route the
   user to support/error-resolution per the PRD ("never a flat denial"), no dispute machinery. Full
   auto-resolution deferred to slice 7.

**Folded leaf-decisions:** PR1 refund execution is synchronous (instant void); cancel-window gate
uses `cancelable_until` (customer-favorable, compliant); fee is refunded on payout failure (Reg E);
receipt is built from immutable snapshot terms; cancel is `FUNDED`-only (`PENDING_PAYMENT` → 409).
**⚠️ Flag:** the refund reverses `S` and leaves `fx_slippage` realized — assumes Bridge returns `S`
(principal), not `A` (actual draw); unverified, slice-7 verification item.

## Domain model updates (captured in glossary.md + decisions.md alongside this plan)

New **[glossary.md](/docs/glossary.md)** entries:
- **void** — undo of an *uncleared* funding collection: the sender's inbound ACH is canceled before
  it settles, so no money ever moved; booked as a clean reversal of the FUNDED batch. The
  cancel-at-`FUNDED` path.
- **refund** — return of funds that *did* move, sent back to the sender from float; the
  `PAYOUT_FAILED→REFUNDED` path (and slice-7 real refunds).
- **`REFUNDED` (state)** — terminal "sender has been made whole," reached by either a void or a
  refund; the ledger shows which.

New **[decisions.md](/docs/decisions.md)** entries:
- *Cancel-at-`FUNDED` is a void, not a refund (two-verb model).* Why a future engineer will ask:
  "why doesn't cancel post through `refunds_payable` like ledger-rules.md's variant 2?" — because at
  FUNDED-pre-claim no money has moved, so we reverse cleanly; refund-from-float is the payout-failure
  path.
- *Human-gate the first real payout-failure refunds (`AUTO_REFUND`, default-safe).* Same
  mechanism-now/policy-via-flag rationale as the float ceiling; the trigger is Bridge return
  semantics being sandbox-unverified.

---

## Shared substrate (PR1 introduces it; PR2 reuses)

**Two funding-undo methods** on `FundingProcessor` ([funding/index.ts](/apps/api/src/services/funding/index.ts)),
mirroring the `initiateFunding` seam (accept an `idempotencyKey` so the slice-7 Stripe adapter drops
in without a signature change):

```ts
export interface FundingUndo { provider: string; ref: string; status: 'succeeded' | 'pending' }
// on interface FundingProcessor:
voidFunding(input: { transferId: string; paymentRef: string; idempotencyKey: string }): Promise<FundingUndo>
refund(input: { transferId: string; paymentRef: string; amountMinor: number; currency: 'USD'; idempotencyKey: string }): Promise<FundingUndo>
```

Mock ([funding/mock.ts](/apps/api/src/services/funding/mock.ts)) returns `mockvoid_…` / `mockrefund_…`
and ignores the key. PR1 calls `voidFunding()`; PR2 calls `refund()`.

**New transfer columns** (PR1 migration): a nullable undo-reference column (`refund_payment_ref`,
holding the void ref on the cancel path or the refund ref on payout-failure — a transfer takes
exactly one undo path, so one column suffices) + `refunded_at`. Both are **not** economic terms, so
they're absent from `enforce_transfer_terms_frozen`
([create_transfers.sql:72-98](/supabase/migrations/20260717164026_create_transfers.sql)) and freely
mutable via service-role UPDATE — same as `funding_cleared` / `submit_attempted_at`. Null is the
idempotency gate that stops a retry from double-calling `voidFunding()`/`refund()`.

---

## PR1 — Cancel path (`FUNDED → CANCELED → REFUNDED`, via void)

Ship `POST /v1/transfers/:id/cancel`: synchronous, idempotent, Reg-E cancel of a **`FUNDED`-pre-claim**
transfer. Guarded claim that can never race payout submission → clean FUNDED-batch reversal → mock
`voidFunding()` → terminal `REFUNDED`, all in-request (safe because the void is instant).

**Migration** (`…_cancel_transfer.sql`, sorts after `20260720165458`):
- Add `refund_payment_ref`, `refunded_at`.
- New RPC **`cancel_transfer(p_transfer_id, p_actor, p_reason, p_ledger_description, p_ledger_entries)`**,
  modeled on `transition_transfer` — one transaction: guarded UPDATE → CANCELED → append
  `transfer_transitions` → `post_ledger_transaction` keyed `{id}:CANCELED`. Grants to `service_role`
  only. The guard is the serialization point vs the submit claim:

```sql
update public.transfers set state = 'CANCELED'
 where id = p_transfer_id
   and state = 'FUNDED'
   and submit_attempted_at is null                             -- THE race guard (mirrors submit claim)
   and (cancelable_until is null or now() <= cancelable_until) -- Reg E window
returning * into v_transfer;
-- NOT FOUND → post-mortem SELECT: no row → 'transfer_not_found';
--   already CANCELED → replay no-op; else → 'transfer_not_cancelable'
```

`submit_attempted_at IS NULL` is load-bearing: the submit job sets it *while state is still FUNDED*
([payout-submit.ts:85-96](/apps/api/src/jobs/payout-submit.ts)), so a cancel guarded only on
`state='FUNDED'` could win mid-Bridge-POST and double-pay. Row-locking serializes the two guarded
UPDATEs — exactly one matches a row. (Guard deliberately omits `payout_hold_reason IS NULL`: a held
FUNDED transfer stays cancelable, and the submit job skips held rows so there's no contention.)

**Files to modify:**
- [services/transfers.ts](/apps/api/src/services/transfers.ts) — `cancelTransfer()` wrapper (mirror
  `transitionTransfer`); `canceledLedgerEntries()` (reverse of `fundedLedgerEntries`); add
  `'transfer_not_cancelable'` to `TransferRpcCode` + `RPC_CODES`.
- [funding/index.ts](/apps/api/src/services/funding/index.ts) + [mock.ts](/apps/api/src/services/funding/mock.ts)
  — `voidFunding()` **and** `refund()` (the shared substrate).
- [routes/v1/transfers.ts](/apps/api/src/routes/v1/transfers.ts) — new `POST /:id/cancel`, modeled on
  `POST /:id/confirm` (:239-402): `config: { idempotency: true }`, Zod params `{id: uuid}` + empty
  body, owner-scoped load. Audit-log entry (financial route). Handler by state:
  - `FUNDED` → `cancelTransfer(…, canceledLedgerEntries(t))`; then void step.
  - `CANCELED` (retry) → resume at void step. `REFUNDED` → return (idempotent terminal).
  - `SUBMITTED`/`IN_FLIGHT` → **lightweight compliant response** (not flat 409): a code/message
    routing the user to support/error-resolution ("can't be applied automatically after payout
    submission; contact support to exercise your cancellation right"). If the payout later fails,
    PR2 refunds anyway.
  - `PENDING_PAYMENT` / other → 409. (Abandoned `PENDING_PAYMENT` is cleaned up by the existing
    reconcile-pending job.)
  - **Void step** (`refund_payment_ref` null-gated): `getFundingProcessor().voidFunding({ idempotencyKey: `${idempotency_key}:void` })`,
    persist `refund_payment_ref`/`refunded_at`, then `transitionTransfer(CANCELED→REFUNDED)` **no ledger**.

**Ledger** (example $98 send + $2 fee):
- `FUNDED→CANCELED` (`{id}:CANCELED`): `DR transfer_payable 98 · DR fee_revenue 2 · CR funding_receivable 100`
  — clean reversal; fee not earned on a cancel.
- `CANCELED→REFUNDED`: **no ledger** — FUNDED only recognized a receivable; reversing it zeroes the books.

**Tests**: the headline **race test** (interleave `claimForSubmission` and `cancel_transfer` on a
FUNDED row → exactly one wins; assert no CANCELED row ever coexists with a set
`submit_attempted_at`/`provider_transfer_ref`); guard at claimed-but-not-submitted → not cancelable;
expired window → not cancelable; SUBMITTED/IN_FLIGHT → compliant-route response; idempotent replay
resumes without a second `voidFunding()`; ledger nets `funding_receivable`/`transfer_payable`/`fee_revenue` to 0.

---

## PR2 — Async refund tail (`PAYOUT_FAILED → REFUNDED`, refund-from-float, gated)

Turn the stubbed state-move into a ledger-posted refund inside the existing idempotent
`payment-event.process` job — **no new queue, no migration**. Reuses PR1's `refund()` + columns.

**The `AUTO_REFUND` gate (from grilling Q5):** a default-safe env flag. **On** (dev/test) → the job
auto-drives the refund so the e2e proves the full path. **Off** (prod default) → a real payout
failure stops at `PAYOUT_FAILED` + ops alert; a human triggers the refund by runbook. The ops-trigger
surface + flipping the flag are recorded slice-7 prerequisites.

**Files to modify:**
- [services/payment-events.ts](/apps/api/src/services/payment-events.ts) — split `mapBridgeState`
  (:24-64): `returned`/`refunded` carry `principalReturned: true` (drive the refund when
  `AUTO_REFUND`); `refund_in_flight` stays a plain wait.
- [services/transfers.ts](/apps/api/src/services/transfers.ts) — `bridgeReturnLedgerEntries()`
  (`DR cash_clearing S · CR due_from_bridge S`) and `refundedLedgerEntries()`
  (`DR transfer_payable S · DR fee_revenue F · CR cash_clearing S+F`).
- [jobs/payment-event-process.ts](/apps/api/src/jobs/payment-event-process.ts) — on `principalReturned`
  + `AUTO_REFUND`, after ensuring `PAYOUT_FAILED`: post `{id}:bridge_return`, `refund()` if
  `refund_payment_ref` null, then `transitionTransfer(PAYOUT_FAILED→REFUNDED, refundedLedgerEntries)`.
  Extend `resolveTransfer`'s SELECT (:114-123) with `fee_amount_minor`, `refund_payment_ref`. All
  before `markProcessed`; rethrow non-benign errors (leaves the event `received` for pg-boss retry /
  sweep). Flag **off** → mark `PAYOUT_FAILED`, alert, stop.
- [jobs/payout-poll.ts](/apps/api/src/jobs/payout-poll.ts) — extend the polled-state filter to include
  `PAYOUT_FAILED` rows with `provider_transfer_ref` set and `refund_payment_ref` null, so a missed
  terminal `refunded` webhook re-synthesizes (self-healing).

**Ledger** (post-SUBMITTED, `due_from_bridge 98` open): two **distinct** transition keys are mandatory
(the `UNIQUE(transfer_id, transition)` index rejects a second row under one key). `fx_slippage` from
the SUBMITTED batch **stays realized** (never reversed). **⚠️ Assumes Bridge returns `S` (principal),
not `A` (actual USDC draw incl. slippage)** — unverified (sandbox stalls at `funds_received`); if
Bridge returns `A`, slice 7 must reverse the slippage leg too. Sits with the FX-basis open question.

**Tests**: `returned`/`refunded` (flag on) → both batches post, balances net; `refund_in_flight` → no
refund yet; flag **off** → `PAYOUT_FAILED` + alert, no disbursement; webhook+poll duplicate → refund
posts once (`refund_payment_ref` gate); out-of-order `refunded` after `PAYOUT_FAILED`-via-`error`
still drives; crash mid-tail → replay completes without double-post.

---

## PR3 — Receipts

Write a Reg-E `receipt` disclosure row when a transfer reaches `COMPLETED`, and expose
`GET /v1/transfers/:id/receipt`. Purely mechanical; **no Reg E copy changes**.

**Migration** (`…_disclosures_unique_type.sql`): `alter table public.disclosures add constraint
disclosures_transfer_type_key unique (transfer_id, type)` — enables idempotent `ON CONFLICT DO
NOTHING`; the append-only trigger is `before update or delete`
([create_transfers.sql:168-170](/supabase/migrations/20260717164026_create_transfers.sql)) so a
no-op insert never fires it.

**Files to modify:**
- [services/disclosures.ts](/apps/api/src/services/disclosures.ts) — `buildReceiptDisclosure()`
  mirroring `buildPrepaymentDisclosure`, **reusing the same `renderEn`/`renderES` blocks** (no new
  counsel-pending copy); `type:'receipt'`. en+es parity (i18n skill).
- [jobs/payment-event-process.ts](/apps/api/src/jobs/payment-event-process.ts) — in `drive()`
  (:135-167) after `COMPLETED`, idempotent receipt upsert
  (`onConflict:'transfer_id,type', ignoreDuplicates:true`) from the transfer's **immutable snapshot
  terms** (= delivered amounts; Bridge fixes `destination.amount`). Before `markProcessed`; rethrow
  on failure (self-heals a crash between the COMPLETED ledger post and the receipt write).
- [routes/v1/transfers.ts](/apps/api/src/routes/v1/transfers.ts) — `GET /:id/receipt`, owner-scoped,
  modeled on `GET /:id` (:467-513); `200` receipt content / `404` before COMPLETED or non-owner.

**No ledger.** **Tests**: exactly one receipt on COMPLETED; replay/catch-up doesn't duplicate;
crash-after-COMPLETED-before-receipt heals on retry; GET 200 en+es / 404 pre-COMPLETED / 404 non-owner.

---

## Build sequence & workflow

1. **PR1 first** — introduces the shared substrate (`voidFunding()` + `refund()` + `refund_*` columns).
2. **PR2 after PR1** — reuses `refund()` + columns; TS-only, no migration.
3. **PR3 after PR2** — both edit `payment-event-process.ts` `drive()/route()`; sequencing avoids a
   merge conflict. Adds one migration (sorts after PR1's).

Each PR ships behind the mock-funding prod lock and is independently reviewable. Per PR: `pr-prep`
gate (typecheck + lint + test), then `security-reviewer` (money movement) and `compliance-reviewer`
(Reg E surface); apply `migration` / `ledger` / `api-route` / `tdd` / `i18n` /
`financial-schema-checklist` skills. Branch each PR from **fresh `origin/main`**. **Do not merge,
push, or open PRs without explicit per-action approval.**

## Execution & review orchestration

- **Implementation:** main agent (me), **TDD-first, one PR at a time** in dependency order. The
  race + ledger logic is *not* fanned out to build-subagents — I hold the full context and write
  tests first.
- **Per-PR review = a Workflow-orchestrated adversarial pass** (the "Max" choice), calibrated per PR,
  deepest on PR1: parallel review dimensions → adversarially verify each finding (refute-by-default)
  → synthesize ranked, confirmed findings → I fix → re-review the fixes. Dimensions:
  - **PR1:** cancel-vs-submit race safety, ledger reversal balances + no double-post, idempotent
    retry/replay, Reg E (window, void semantics, `SUBMITTED`/`IN_FLIGHT` response), silent failures,
    api-route contract (schema / auth / audit).
  - **PR2:** two-key ledger balance, `AUTO_REFUND` gate correctness, webhook+poll idempotency +
    `refund_payment_ref` gate, poll self-healing, silent failures, the `S`-vs-`A` assumption.
  - **PR3:** idempotent receipt upsert, en/es parity, snapshot-terms correctness, api-route contract.
  - **Folded in as passes:** CLAUDE.md-mandated **security-reviewer** (every PR) +
    **compliance-reviewer** (PR1/PR3), and **codex-review** (second model, findings verbatim) as an
    independent pass before the PR is offered.
- **Gate before the review workflow runs:** `pr-prep` (typecheck / lint / test) green.
- **Sessions:** one focused session per PR, `/clear` between (CLAUDE.md "one task per session").
- **Approvals:** I never merge; **push / open-PR / comment each need explicit go-ahead**; each PR
  branches from fresh `origin/main`.

## Slice-7 prerequisites (recorded now, resolved with real money)

- Reconcile disclosure wording ("submitted for payout" → Reg E "picked up or deposited").
- `AUTO_REFUND`: build the ops-trigger surface + flip the flag on once Bridge return semantics are
  verified in the pilot.
- Verify what Bridge returns on a failed payout (`S` vs `A`); if `A`, reverse the slippage leg.
- Real Stripe `voidFunding()`/`refund()` adapters; confirm ACH is cancelable inside the 30-min
  window (else add the void→refund fallback).
- Full compliant `SUBMITTED`/`IN_FLIGHT` cancel handling (pending-cancel resolution) + the
  error-resolution track it routes into.
- `PENDING_PAYMENT` cancel → void the real Stripe intent (once lingering intents have a cost).

## Verification

- **Unit + integration tests** alongside each change (Vitest + Supertest; DB tests under
  `RUN_DB_TESTS`, patterns in `payout-ledger.db.test.ts` / `payment-event-process.test.ts`). The PR1
  race test is the gate for the whole slice.
- **Local e2e on the dev stack** (`supabase start` + worker, `AUTO_REFUND=on`): drive the mock
  funding webhook to `FUNDED`, then (PR1) `POST /:id/cancel` → assert `REFUNDED` + ledger nets to
  zero; (PR2) synthesize a Bridge `refunded` event on a SUBMITTED transfer → assert `REFUNDED` + both
  refund batches balance; (PR3) drive `payment_processed` to `COMPLETED` → assert one `receipt`
  disclosure and `GET /:id/receipt` returns en+es.
- **`pnpm run typecheck`** + **`pnpm test`** (from `apps/api/`) green before each PR.
- Ledger invariants asserted in tests: every batch nets to zero; balances recompute from entries; no
  double-post under replay.
