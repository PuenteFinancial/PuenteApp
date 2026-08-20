# PRD — Funding Ops Automation: from CLI runbook to one button

**Owner:** Joshua
**Build target:** Claude Code
**Goal:** A real transfer under `FUNDING_PROCESSOR=manual` runs end-to-end with the only human
action being Joshua tapping **Release payout** on the ops board from his phone.

**Context:** The first real production transfer (2026-08-18, $5) and its staging dry run proved
the manual rail works — and that every transfer costs an operator session: laptop, Doppler, two
CLI scripts, and a raw curl with five documented gotchas (`docs/runbooks/manual-funding-run.md`).
Two of the three commands already have authenticated ops API endpoints (#190, #203); nothing has
ever called them except tests. This PRD puts buttons on them, automates the onramp curl out of
existence, gives the sender an in-app way to say "I've paid," and adds the ad-hoc float top-up
entry (Joshua, 2026-08-19: "if I know I sent 100 into the wallet, I want to enter the amount and
hit enter"). Release policy stays as decided 2026-08-18: the payout releases on evidence the
sender's ACH was *initiated*, and that evidence judgment stays human.

---

## 1. What we're building

Five slices. Each is one PR; slice 5 is specced here but deferred.

1. **Ops transfer buttons** — kills the SSH-and-CLI session for attach / release / deposit-landed;
   the run becomes taps on `/dashboard/ops`.
2. **Ad-hoc float top-up card** — kills `record-float-topup.ts` for out-of-band wallet deposits;
   amount-first entry on the ops board.
3. **Auto-onramp at confirm** — kills the error-prone curl (runbook §2) and the attach step;
   deposit coordinates appear on the sender's pay step with zero operator action.
4. **Sender payment claim** — the sender tells us the money is on the way; Joshua still releases.
   A claim is a signal, never a release.
5. **Webhook auto-clear + top-up (DEFERRED)** — when Bridge says the onramp deposit landed, book
   `cleared` + the float top-up automatically.

### Decisions locked (2026-08-19)

- **A sender claim never releases the payout.** `--kind funded` draws ≈ the transfer total from
  the treasury float immediately; auto-releasing on the sender's *assertion* would let any
  signed-in user drain the float by lying — the exact attack the manual processor's design
  comment exists to prevent (`apps/api/src/services/funding/manual.ts`). The claim records a
  timestamp and surfaces on the ops board; the release tap stays Joshua's, per the 2026-08-18
  evidence-of-initiation policy.
- **The claim is a flag, not a state.** `PENDING_PAYMENT` keeps zero substates; a new
  `transfers.payment_claimed_at` lifecycle column (mutable under the terms-frozen trigger)
  carries it. A state would ripple through every watched/abandoned/history filter for zero
  machine value.
- **Confirm never fails on Bridge being down.** The transfer is already `PENDING_PAYMENT` and the
  money moves out of band — onramp creation is asynchronous and retryable, and the slice-1 attach
  button is the break-glass fallback.
- **`funding_payment_ref` keeps the `manualpay_` prefix.** The onramp id is already durably tied
  to the transfer via `deposit_instructions.bridge_transfer_ref` and the funding assertion's
  `externalRef`; making the ref the onramp id would couple confirm success to Bridge availability
  (contradicting the bullet above) and put onramp ids into columns the Stripe recon checks filter
  by `pi_%` prefix.
- **Onramp Bridge Idempotency-Key stays `onramp-<transferId>`** — the same convention the runbook
  curl already uses, so a mixed manual/auto history can never double-create an onramp for one
  transfer.
- **Deposit-landed is one button doing both books** (`cleared` + float top-up). Both legs are
  idempotent on the shared onramp ref (`cleared_skipped` outcome; ledger key
  `float_topup:<ref>`), so a re-tap after a partial failure heals rather than double-counts.
- **CLI scripts stay, demoted to break-glass** — the standing posture (decisions.md 2026-07-27):
  the dashboard is additive, the CLI is the recovery path when the web is what's broken.
- **Every new ops write uses the existing double-control gate** (`OPS_ADMIN_USER_IDS` ×
  `OPS_WRITE_ENABLED`, route registered only when enabled, onRequest + handler re-check,
  refusals 404 byte-identical to the router's not-found) and mirrors the ops.test.ts five-test
  gate template. No new auth machinery.

---

## 2. Non-goals

- **No auto-release on sender claim.** Stated above; restated because it is the one shortcut that
  turns a UX feature into a treasury drain.
- **No push-notification infrastructure.** The ops board is the record of pending claims; a
  fingerprinted Sentry info event is the interim phone ping (see slice 4). APNs/FCM/email wait
  for real notification work.
- **No RBAC, SMS step-up, or role claims** — the 8.5-v1.1 decision stands: at an admin population
  of one, the env-pair gate *is* the approval workflow.
- **No state-machine changes.** No new states, no substates; the claim is a column.
- **No onramp mutation from the dashboard.** Cancel/recreate stays in the Bridge dashboard; the
  re-attach button covers pointing a transfer at a replacement onramp.
- **No mobile ops surface.** The web ops page on a phone browser is the requirement, and it
  already renders fine there.
- **No slice-5 build yet.** The event guard in slice 3 only *ignores* onramp events; acting on
  them is deferred until the guard has soaked in production.
- **No shared ops action-button component.** Three sibling components following the
  `CancellationActions` ceremony is the house style; extract when a fourth appears.

---

## 3. Slice 1 — Ops transfer buttons

**Today:** `POST /v1/ops/transfers/funding` (`funded`/`cleared`, idempotency-keyed) and
`POST /v1/ops/transfers/deposit-instructions` exist in `apps/api/src/routes/v1/ops.ts` with full
gate + refusal mapping and tests — and no caller besides supertest. The run requires a laptop.

**Build:**
- **Overview row additions** for open transfers, via the established four-edit pattern
  (`OpenRow` select + mapping in `apps/api/src/services/ops-overview.ts` → `OpsOpenTransfer`
  interface → response-schema allowlist in `ops.ts` → *optional* mirror fields in
  `apps/web/lib/opsOverview.ts` for deploy skew): `feeAmountMinor` (buttons must state the total
  to the cent or the endpoint 409s `amount_mismatch`), `hasDepositInstructions` and `onrampRef`
  (from `deposit_instructions.bridge_transfer_ref`, one extra read in `buildOpsOverview`, prefills
  `externalRef`), `fundingInitiated` (`funding_payment_ref` non-null — actions render only on
  confirmed rows).
- **New composite endpoint `POST /v1/ops/transfers/deposit-landed`**
  `{ transferId, externalRef, amountMinor, currency: 'USD' }`: runs
  `recordManualFunding(kind: 'cleared')` then `recordFloatTopUp({ amountMinor, externalRef })`.
  No `config: idempotency` — both legs are naturally idempotent on the ref (precedent: the
  deposit-instructions route's stated no-key rationale), and the ordering invariant (cleared
  first) means a crash between legs leaves a state a re-tap heals. Same gate, same refusal
  mapping as the funding route.
- **Web proxies** mirroring `apps/web/app/api/ops/cancellations/resolve/route.ts`:
  `ops/transfers/funding` (forwards `Idempotency-Key` via `forwardIdempotencyKey`),
  `ops/transfers/deposit-instructions` and `ops/transfers/deposit-landed` (no key).
- **`apps/web/components/ops/TransferActions.tsx`** on each open-transfer row, rendered only when
  `actionsEnabled === true`, following the `CancellationActions` ceremony exactly: inline
  two-step confirm, `Phase` machine (idle/busy/success/error), `useIdempotencyKey()`
  take/clear-on-success for the release button, `router.refresh()` after any write. Buttons:
  - **Attach instructions** — onramp-id input (also slice 3's break-glass); visible while
    `PENDING_PAYMENT` without instructions.
  - **Release payout** — kind `funded`; confirm step restates the total (`send + fee`) and the
    release policy line ("evidence ACH initiated").
  - **Deposit landed** — prefilled ref + amount; confirm restates that this books arrival
    (`cleared` + top-up), not intent.
- **i18n:** extend `t.ops.actions` in `packages/shared/src/i18n/translations.ts`, en + es.

**Gate:** the ops.test.ts five-test gate template for the new route; validation + outcome-mapping
describes; a double-tap test proving the composite endpoint re-run is a no-op at both books.

---

## 4. Slice 2 — Ad-hoc float top-up card

**Today:** `recordFloatTopUp` (`apps/api/src/services/payouts.ts`) posts
`DR bridge_wallet_float / CR cash_clearing` with ledger key `float_topup:<ref>` — and has no HTTP
surface. Topping up the wallet means the CLI.

**Build:**
- **`POST /v1/ops/treasury/float-topup`** `{ amountMinor, currency: 'USD', externalRef? }`,
  `config: { idempotency: true }`. When `externalRef` is blank the handler derives
  `adhoc:<Idempotency-Key>` — belt and braces: a held key replays the stored 2xx; the same ref is
  a ledger no-op; a fresh key with no ref is a legitimately new booking. Response returns the
  posted amount and the `bridge_wallet_float` balance after.
- **`TopUpCard`** on the ops board next to the ledger-balances panel: amount-first input, optional
  reference field (the Bridge transaction id when there is one — unprefixed, so a later
  deposit-landed or slice-5 webhook on the same ref dedupes against it), two-step confirm
  restating the parsed amount.
- **Money parsing:** port `parseUsdToMinor` from `apps/api/scripts/record-float-topup.ts` (strict
  regex + BigInt) into a web lib. `Number(x) * 100` never touches an amount — the QuoteScreen
  float path is *not* the precedent here.

**Gate:** gate template + a test pinning the derived-ref semantics (same key → replay; same ref →
ledger no-op; fresh key + blank ref → new booking).

---

## 5. Slice 3 — Auto-onramp + auto-attach at confirm

**Today:** the operator creates the onramp with a raw curl (five gotchas documented in the
runbook) or the Bridge dashboard, then runs the attach script. `apps/api/src/services/bridge.ts`
has no onramp-create function — `createBridgePayout` is payout-shaped and
`getBridgeDepositInstructions` is a read. `ManualFundingProcessor.initiateFunding` ignores its
input and mints a `manualpay_` ref; the confirm route holds the transfer row but nothing looks up
`users.bridge_customer_id`.

**Build:**
- **`createBridgeOnramp()` in `services/bridge.ts`:** `POST /v0/transfers`, Bridge
  `Idempotency-Key: onramp-<transferId>`, fixed key order (the `buildPayoutBody`
  byte-identical-retry rule): `amount` = decimal string from the transfer total (cent-exact by
  construction — the attach-time mismatch check becomes a tautology for auto-created onramps),
  `on_behalf_of` = the sender's `bridge_customer_id`, `developer_fee: '0'`, source
  `{ payment_rail: 'ach_push', currency: 'usd' }`, destination
  `{ payment_rail: 'base', currency: 'usdc', bridge_wallet_id: BRIDGE_TREASURY_WALLET_ID }`,
  `client_reference_id` = the transfer id.
- **Seam: a pg-boss job (`funding.onramp_prepare`)** enqueued from the confirm route after
  `funding_payment_ref` persists. The job loads the transfer + `users.bridge_customer_id`,
  creates the onramp, and calls `attachDepositInstructions` with system attribution. Confirm
  latency is untouched; Bridge downtime becomes pg-boss retries; the sender's tracker already
  polls every 5 s, so coordinates appear seconds after confirm. The slice-1 attach button covers
  the tail where retries exhaust.
- **Migration:** `deposit_instructions.attached_by` → nullable; `null` = attached by the system
  at confirm (the column's meaning stays "which human vouched for these coordinates").
- **env:** `config/env.ts` superRefine — `FUNDING_PROCESSOR=manual` requires
  `BRIDGE_TREASURY_WALLET_ID` (mirrors the Stripe key-trio refinement).
- **REQUIRED: the onramp-event guard in `apps/api/src/jobs/payment-event-process.ts`.** Verified
  2026-08-19: Bridge *onramp* webhook events already flow into the *payout* state machine. The
  webhook resolves `client_reference_id → transfers.id`; `resolveTransfer` never checks the
  event's Bridge id against the transfer's `provider_transfer_ref`; `mapBridgeState` maps
  `payment_processed` → drive to `COMPLETED` (ledger batch + receipt) and `returned` → the
  refund-from-float tail. An onramp's deposit landing days after the payout completed is what
  masks this today; auto-onramp universalizes the exposure. The guard: before `drive`/
  `failTransfer`, an event whose `provider_ref` differs from the transfer's
  `provider_transfer_ref` and matches `deposit_instructions.bridge_transfer_ref` →
  `markIgnored('onramp lifecycle event')`. This is also the seam slice 5 later upgrades to act.
- **Side effect worth stating:** auto-created onramps always carry `client_reference_id`, so the
  reconciliation `bridge_orphans` second-chance match stays clean — the runbook §7 known gap
  closes for all future onramps.
- **Docs land with this slice:** runbook rewrite (see §9).

**Gate:** security-reviewer (user action now creates Bridge objects — bounded by the existing
transfer-creation and AML caps, but it's a new external side effect on an authenticated user
path). Regression tests for the guard: onramp `payment_processed` / `canceled` / `returned`
against a transfer in every forward state → `markIgnored`, no drive, no failTransfer, no refund
tail.

---

## 6. Slice 4 — Sender payment claim

**Today:** the pay step renders the deposit coordinates and stops — no control, no signal. "The
sender says they paid" happens over text message, and nothing timestamps it.

**Build:**
- **Migration:** `transfers.payment_claimed_at timestamptz` — lifecycle column, mutable under the
  terms-frozen trigger; verified no such column exists (`refund_claimed_*` is a worker lease,
  unrelated).
- **`POST /v1/transfers/:id/payment-claim`** — owner-scoped, requires `PENDING_PAYMENT` +
  `funding_payment_ref` set. Set-once: `update … set payment_claimed_at = now() where id = ? and
  payment_claimed_at is null`; a replay returns the existing timestamp. No `Idempotency-Key`
  (monotone flag, no money — the body-vs-path-param collision trap doesn't apply because there is
  no keyed claim to collide).
- **Sender UI:** button in `PayStep.tsx`'s `'offline'` arm ("I've sent the payment"), using the
  simulate-arm mechanics (busy state, POST, `posthog.capture('send_payment_claimed')`,
  `await onAdvanced()`); once claimed, confirmation copy replaces the button ("Thanks — we'll
  release your transfer once we confirm the payment is on its way"). Copy must not promise
  instant release.
- **Ops board:** `paymentClaimedAt` on open-transfer rows (four-edit pattern again) — a claimed
  `PENDING_PAYMENT` row is the "your move" signal, rendered distinctly.
- **Notification:** the ops board is the record; plus one fingerprinted Sentry `captureMessage`
  (info) per claim as the zero-new-infra phone ping. Acknowledged smell — a business event in the
  alert channel — revisit when real notification infra exists.
- **i18n:** `t.send.track.pay.*` additions, en + es.

**Gate:** compliance-reviewer on the sender-facing copy (it describes money movement timing);
tests: set-once semantics, replay stability, wrong-state 409, never a state change.

---

## 7. Slice 5 — DEFERRED: webhook auto-clear + auto-top-up

Specced so slice 3's guard is built with this upgrade in mind; **not built now.**

Upgrade the guard's ignore branch: an onramp `payment_processed` event →
`recordManualFunding(kind: 'cleared', operator: system)` + `recordFloatTopUp` with
`externalRef` = the onramp's Bridge transfer id — the shared ref is what makes a manual
deposit-landed tap and the webhook mutually no-op, in either order. The deposit-landed button
stays as the override for the day Bridge's webhook doesn't come. Onramp `returned` / `canceled`
→ alert only — an ACH deposit return is `FUNDING_REVERSED` territory and must never route into
the payout refund tail. Do not ship before the slice-3 guard has soaked in production; note the
possible overlap with the existing "onramp application" queue item before filing.

### Risk — onramp events in the payout pipeline

The hazard the slice-3 guard closes is latent **today**: every curl-created onramp sets
`client_reference_id`, its webhook events resolve to our transfer id, and only timing (deposits
land days after payouts complete; `drive()` no-ops at `COMPLETED`) has kept an onramp
`payment_processed` from completing a payout that never delivered, or an ACH return from
triggering a false refund tail. Treat any unexplained `payout-success-after-terminal` page or
premature `COMPLETED` on a manual-rail transfer as this hazard until the guard ships.

---

## 8. Sequencing & sizing

| # | Slice | Size | Depends on |
|---|---|---|---|
| 1 | Ops transfer buttons | M/L | — |
| 2 | Ad-hoc float top-up card | S | — |
| 3 | Auto-onramp at confirm (+ event guard) | L | 1 (attach button is the break-glass fallback) |
| 4 | Sender payment claim | M | 1 (same four-edit overview files; land after) |
| 5 | Webhook auto-clear (deferred) | M | 3 (guard), 2 (ref conventions) |

2 is a filler that can ride alongside 1. Definition of done for this PRD (slices 1–4): a real
transfer runs confirm → coordinates → claim → release → deposit-landed with zero CLI, and the
float can be topped up from a phone.

---

## 9. Runbook & docs updates (mandated, land with slice 3)

- **`docs/runbooks/manual-funding-run.md`** — §2 (curl) and §3 (attach) collapse to "automatic at
  confirm — verify on the ops board"; §5/§6 become button descriptions; every CLI command moves
  to a break-glass appendix. The §0 float-sizing caution and §4 release policy survive verbatim.
- **`docs/runbooks/driving-the-product.md` §8** — pointer updates.
- **`docs/runbooks/reconciliation.md`** — bridge_orphans: auto-created onramps match by
  `client_reference_id`; a persistent orphan is once again a true anomaly.
- **`docs/api-contract.md`** — the new ops endpoints + payment-claim.
- **`docs/decisions.md`** — claim-never-releases entry (lands with this PRD).

---

## 10. Acceptance criteria

- [ ] A full manual-rail transfer (confirm → coordinates on pay step → sender claim → release →
      deposit landed) completes with zero CLI; the only human taps are Release and Deposit
      landed, from a phone
- [ ] Every new ops write passes the five-test gate template; refusals byte-identical 404;
      non-2xx responses never stored by the idempotency plugin
- [ ] Double-tap safety proven at both layers (HTTP replay + ledger no-op) for deposit-landed and
      float top-up
- [ ] Bridge unreachable at confirm: confirm still 200s, the onramp job retries, the ops board
      shows the row without instructions, the attach button recovers it
- [ ] Onramp webhook events (`payment_processed`, `canceled`, `returned`) against a transfer in
      every forward state → `markIgnored`; no drive, no failTransfer, no refund tail
- [ ] Sender claim: set-once, replay-stable, never changes state, never releases, visible on the
      ops board
- [ ] `bridge_orphans` clean for an auto-created onramp
- [ ] en + es parity for every new string
- [ ] Every slice: tests alongside, typecheck green, security-reviewer on financial paths,
      compliance-reviewer on the sender-facing claim copy

---

## 11. Reference

- `docs/runbooks/manual-funding-run.md` — the operator run this PRD automates (written 2026-08-18
  from the staging dry run + first prod transfer).
- Existing ops writes: `POST /v1/ops/transfers/funding` (#190) and
  `POST /v1/ops/transfers/deposit-instructions` (#203, for #199), both in
  `apps/api/src/routes/v1/ops.ts`; gate + test template in `apps/api/src/routes/v1/ops.test.ts`.
- Web write ceremony: `apps/web/components/ops/CancellationActions.tsx` +
  `apps/web/app/api/ops/cancellations/resolve/route.ts` + `apps/web/lib/idempotency.ts`.
- Ledger legs: `recordFloatTopUp` / `floatTopUpLedgerEntries` in
  `apps/api/src/services/payouts.ts`; `recordManualFunding` in
  `apps/api/src/services/funding-apply.ts`.
- The hazard path: `apps/api/src/routes/v1/webhooks.ts` (client_reference_id resolution) →
  `apps/api/src/jobs/payment-event-process.ts` (`resolveTransfer`) →
  `apps/api/src/services/payment-events.ts` (`mapBridgeState`).
- Prior PRDs this follows: `docs/prds/remittance-mvp.md` (slices 5–8: webhooks, ops page,
  cancellations); `docs/prds/account-lifecycle.md` (format).
- Rail-mapping fix the curl gotchas produced: #208; deposit-rail canonicalization context in
  `docs/runbooks/manual-funding-run.md` §2.
