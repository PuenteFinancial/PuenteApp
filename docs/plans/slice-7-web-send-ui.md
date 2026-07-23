# Slice 7 — Web Send-Money UI (unblocked half)

## Context

The USD→MXN remittance rail is **API-complete**. Slices 1–5 shipped the ledger, recipients, quotes,
transfers, funding intake, and the async payout layer; slice 6 (cancel/refund/receipts, merged
2026-07-22) closed the "undo + proof" seams. What's missing is the **surface**: a customer can't yet
*send* money from the web app — the verified dashboard's only action today is a link to manage
recipients ([StatusCard.tsx](/apps/web/components/onboarding/StatusCard.tsx), `variant="dashboard"`).

Slice 7 as originally scoped ([remittance-mvp.md](/docs/prds/remittance-mvp.md) §9) bundles the web
send UI **with** the first real-money pilot send. But funding is **mock-only** — Stripe has no keys
yet (not even test mode), and the mock-funding prod lock (`MOCK_FUNDING_WEBHOOK_SECRET` unset in prod
→ `503 not_configured` on create/confirm) keeps prod inert. So this plan **re-cuts slice 7** into the
half we can build and drive end-to-end **now** (on staging, via the mock funding webhook) vs. the half
that **waits for Stripe keys**. Outcome: a fully working, mock-driven send flow on staging that real
Stripe Elements drops into at the pay step when keys land — everything else is pure API-integration UI.

## Decisions

**Locked at kickoff:** re-cut slice 7 into unblocked-now (this plan) vs Stripe-gated (recorded);
funding stays mock-only behind the `FundingProcessor` seam; `AUTO_REFUND` stays default-off; the
mock-funding prod lock stays default-safe; send UI ships on **web first** (mobile follows once the
flow is proven, per [decisions.md](/docs/decisions.md) 2026-07-13). Slice-8 per-user risk controls are
pulled **forward** into this slice (they gate exercising the flow and need no Stripe).

**Locked in kickoff Q&A (2026-07-23):**
1. **Flag-gate from PR1** — the whole send flow sits behind a PostHog feature flag (`web-send-money`).
   Net-new plumbing (no flag usage exists in the repo yet); PR1 establishes the read pattern.
2. **Web flow first**, then the API backstops (risk controls, AUTO_REFUND surface, cancel handling,
   counsel package). All mock-driven, so the visible milestone leads.
3. **Reg E copy = doc + staged code behind a counsel gate** — draft the counsel-review package AND
   stage the [disclosures.ts](/apps/api/src/services/disclosures.ts) wording change on a branch,
   **merge-gated on counsel sign-off + human-ES review**. The pilot keeps existing copy verbatim
   (slice-6 decision); the change gates *real users*, not the pilot.

**Folded leaf-decisions:**
- **Idempotency: browser mints, proxy forwards, API dedupes.** The key is minted once per commit in
  the browser and forwarded verbatim by the Next.js proxy; the proxy mints nothing (a proxy-minted key
  would defeat browser-retry dedup). See Shared substrate A.
- **Error envelope → localized message, mapped once.** Clients branch on the stable `code`, never on
  message text; raw API messages are never surfaced.
- **Dev "simulate pay" reuses the existing signer**, exposed as a dev-gated API endpoint — the mock
  webhook secret never enters the web env. See Shared substrate E.
- **Prepayment disclosure gets a read endpoint.** The web renders *server-authored* Reg E copy, so
  PR2 adds `GET /v1/transfers/:id/disclosure` (mirrors the receipt endpoint) rather than re-rendering
  the disclosure client-side.

**⚠️ Flag:** the prepayment disclosure **content** is not returned by any existing endpoint today
(create/GET return only a summary `{id,type,locale,presentedAt}`; only the receipt endpoint returns
`content`). PR2 closes this with the new read endpoint above — a compliance-load-bearing addition, not
a nicety.

## Domain model updates (captured in decisions.md alongside this plan)

New [decisions.md](/docs/decisions.md) entries:
- *Slice 7 re-cut: web send UI decoupled from the real-money pilot.* Why a future engineer will ask:
  "why is there a mock-only send flow shipped before any Stripe adapter?" — because the rail was
  API-complete and Stripe keys were the only blocker, so the entire customer surface was built and
  proven on the mock funding seam first.
- *Client idempotency convention (browser mints, proxy forwards).* The per-endpoint/per-user dedup
  ([idempotency.ts](/apps/api/src/plugins/idempotency.ts)) only covers proxy→API; browser→proxy retries
  need the key minted in the browser and passed through, or each retry becomes a duplicate transfer.

---

## The re-cut: unblocked-now vs Stripe-gated

| Unblocked NOW (this plan) | Stripe/pilot-gated (recorded, waits) |
|---|---|
| **Web send flow**: quote → pick recipient/destination → create + Reg E disclosure → confirm → track → receipt + history (PRs 1–4) | Real **Stripe** `FundingProcessor` adapter + Stripe Elements in the pay step (`FUNDING_PROCESSOR='stripe'`) |
| **Per-user risk controls** (slice-8 pulled forward): outstanding-uncleared cap + velocity (PR5) | **Pilot send** (~$20, prod, Joshua → own MX recipient); resolve buy_rate-vs-execution question |
| **AUTO_REFUND ops-trigger surface** + full `SUBMITTED`/`IN_FLIGHT` cancel handling mechanism (PR6) | Verify **Bridge `S` vs `A`** return on failed payout; if `A`, reverse the slippage leg |
| **Reg E disclosure-wording counsel package** (doc + staged copy, counsel-gated) (PR7) | **Flip `AUTO_REFUND` on**; ACH-cancelable-in-30-min check + void→refund fallback; `PENDING_PAYMENT`→void real intent; prod worker (`railway.worker.toml`) + real Bridge `transfer.*` webhook against prod |

Everything in the left column is mock-safe and Joshua-only until Stripe. Live-money credentials remain
Joshua-only.

## Out of scope this slice (explicit non-goals)

The send flow is a single linear path: quote → confirm+disclosure → track → receipt + history. Not built:

- **Real pay UI (Stripe Elements)** — the mock "Simulate payment" button stands in; real card/ACH
  collection is Stripe-gated.
- **Mobile (Expo/RN) send UI** — web-first by decision; mobile follows once the flow is proven.
- **Recipient / CLABE management UI** — already exists
  ([RecipientsManager.tsx](/apps/web/components/recipients/RecipientsManager.tsx)); the send flow
  **reuses and links to it**, at most adding a thin "add recipient" entry point. No rebuild.
- **Admin / ops console** — none exists; ops = scripts + runbooks ("scripts over console",
  [remittance-mvp.md](/docs/prds/remittance-mvp.md) §10). PR6 is backend + a CLI script, **not** a UI.
- **Customer dispute / error-resolution UI** (Reg E §1005.33) — the `SUBMITTED`/`IN_FLIGHT` cancel
  surfaces the server's "contact support" message; no in-app dispute form (that track is a
  counsel-gated proposal, [error-resolution.md](/docs/runbooks/proposals/error-resolution.md)).
- **Notification delivery** (email/SMS/push receipts) — receipts are in-app only.
- **Deferred niceties** — saved/favorite recipients, recurring/scheduled sends, edit-a-quote,
  funding-source management, corridors beyond USD→MXN, locales beyond en/es.

---

## Shared substrate (PR1 introduces it; PRs 2–4 reuse)

### A. Idempotency-key forwarding (browser → proxy → API)

The API requires an `Idempotency-Key` header on the three money POSTs (create, confirm, cancel) and
dedupes on `(user_id, "METHOD /v1/route/:id-pattern", key)` + a canonical body hash
([idempotency.ts:62-70](/apps/api/src/plugins/idempotency.ts)). Two rules fall out:

- **Browser mints once per commit.** New [idempotency.ts](/apps/web/lib/idempotency.ts) —
  `useIdempotencyKey()` holds the key in a `useRef`: `take()` lazily mints `crypto.randomUUID()` and
  caches it; `clear()` resets **on success only**. The mint happens inside the submit handler (not
  render), so React strict-mode double-invoke and network-retry/double-click reuse the **same** key; a
  fresh logical action (new transfer, the confirm step, a cancel) gets its **own** key.
- **Proxy forwards verbatim, mints nothing.** Each money-POST proxy reads
  `req.headers.get('idempotency-key')` and passes it through `apiFetch(path, token, { method, body,
  headers: { 'idempotency-key': key } })` — exactly the mechanism
  [auth/otp/verify](/apps/web/app/api/auth/otp/verify/route.ts) uses for `x-client-ip`. `apiFetch`
  needs **no change** ([session.ts](/apps/web/lib/session.ts) already spreads `init.headers` last).
- **Body carries the discriminator.** Create sends `{quoteId}`, confirm `{disclosureId, accepted:true}`,
  cancel `{transferId}` — cancel *must* include `transferId` because the idempotency identity excludes
  the `:id` path param (slice-6 caveat; a bodyless cancel would replay a different transfer's result).

### B. Error-envelope → localized message layer

New [apiError.ts](/apps/web/lib/apiError.ts): parse `{error:{code,message,requestId}}`, map `code` → a
key in the `send.errors` i18n namespace, resolve via `useLanguage()`. Covers the client-facing taxonomy
(`validation_error`, `kyc_required`, `limit_exceeded`, `quote_expired`, `transfer_not_cancelable`,
`conflict`, `idempotency_conflict`, `not_configured`, `rate_limited`, `rate_unavailable`,
`provider_rejected`, `provider_unavailable`, `internal_error`) **plus** the non-envelope `202`
`cancellation_requires_support` (top-level `code` + `messages{en,es}` — show the server text directly).

### C. `send` i18n namespace

Add a `send: {...}` top-level key to the `Translations` type in
[translations.ts](/apps/web/lib/translations.ts) and fill **both** `en` and `es` (parity is
type-enforced; default lang is `es`). Consume via `const { t } = useLanguage()`. Apply the `i18n` skill.

### D. Feature flag `web-send-money`

New [flags.ts](/apps/web/lib/flags.ts) — server read via `getPostHogClient().isFeatureEnabled(...)`
(mirror [posthog-server.ts](/apps/web/lib/posthog-server.ts)), client read via `posthog.isFeatureEnabled`.
Gates the `/dashboard/send` entry (server redirect when off) and the dashboard CTA. Apply `feature-flag`.

### E. Dev-only "simulate pay" (reuses the existing driver)

Extract the signing logic in [fire-funding-webhook.ts](/apps/api/scripts/fire-funding-webhook.ts) into a
shared helper and expose a **dev-gated** `POST /v1/dev/transfers/:id/simulate-funding` (`404` unless
non-prod **and** the mock secret is set). It fires the signed `funding_succeeded` event through the
normal `/v1/webhooks/funding` path (→ `FUNDED`). Web proxies it; a "Simulate payment" button renders
only in non-prod. Secret stays in the API env only. Real Stripe Elements replaces this at the pay step.

---

## PR1 — Foundation: proxy layer + idempotency + error layer + quote screen

**Files to modify / add:**
- **Substrate**: [idempotency.ts](/apps/web/lib/idempotency.ts) (A), [apiError.ts](/apps/web/lib/apiError.ts)
  (B), `send` namespace in [translations.ts](/apps/web/lib/translations.ts) (C),
  [flags.ts](/apps/web/lib/flags.ts) (D).
- **Proxy routes** (house-style whitelist-and-passthrough; money POSTs forward `Idempotency-Key`):
  `app/api/quotes/route.ts` (POST) + `app/api/quotes/[id]/route.ts` (GET); `app/api/transfers/route.ts`
  (POST create + GET list), `app/api/transfers/[id]/route.ts` (GET), `.../confirm` (POST), `.../cancel`
  (POST), `.../receipt` (GET). PR1 lands the whole proxy layer; later PRs add the consuming screens.
- **Quote screen**: `app/dashboard/send/page.tsx` (server: copy the KYC guard from
  [dashboard/page.tsx](/apps/web/app/dashboard/page.tsx) + flag gate + fetch recipients/destinations)
  → `components/send/QuoteScreen.tsx` (client: amount entry, recipient/destination picker reusing the
  existing `/api/recipients` list, `POST /api/quotes`, render rate + fee + MXN received + a 15-min
  expiry countdown, errors via `apiError`).
- **Entry**: flag-gated "Send money" CTA on the [StatusCard](/apps/web/components/onboarding/StatusCard.tsx)
  dashboard variant.
- **Analytics**: `send_quote_requested`, `send_quote_received` (amounts/currency only — PII discipline).

Quotes carry **no** idempotency by design (a duplicate quote is harmless).

**Tests**: idempotency-hook take/clear semantics (same key across retries, fresh per action);
`apiError` mapping incl. unknown-code fallback + the 202 shape; proxy forwarding (idempotency-key
passthrough, status+body passthrough, 401 when unauthenticated); Playwright happy-path to the quote.

## PR2 — Create transfer + Reg E disclosure + confirm

**New API read endpoint** (small; needed by the UI): `GET /v1/transfers/:id/disclosure` mirroring
`GET /:id/receipt` in [transfers.ts](/apps/api/src/routes/v1/transfers.ts) — owner-scoped, returns the
**prepayment** disclosure `content`. Web renders server-authored Reg E copy verbatim, not a
client re-render. Add its proxy `app/api/transfers/[id]/disclosure`. Apply `api-route`; `compliance-reviewer`.

**Files**: `components/send/ReviewConfirm.tsx` — "Continue" → `POST /api/transfers {quoteId}` (key #1) →
`GET /api/transfers/:id/disclosure` → render Reg E prepayment copy (en/es) → "I have read and accept" →
`POST /api/transfers/:id/confirm {disclosureId, accepted:true}` (key #2). Handle `409 quote_expired`
(offer re-quote), `400 validation_error`, `503 not_configured`. **Analytics**: `send_transfer_created`,
`send_disclosure_viewed`, `send_disclosure_accepted`.

**Tests**: disclosure endpoint owner-scoping (404 non-owner / pre-create) + en/es content; create→confirm
happy path; quote-expired re-quote branch; disclosure-mismatch 400.

## PR3 — Track + cancel + simulate-pay

**Files**: `components/send/TransferTracker.tsx` — poll `GET /api/transfers/:id` (reuse the
[PendingPoller](/apps/web/components/onboarding/PendingPoller.tsx) interval + `visibilitychange` pattern),
render a status timeline (`PENDING_PAYMENT→FUNDED→SUBMITTED→IN_FLIGHT→COMPLETED`, plus
`CANCELED`/`REFUNDED`/`PAYOUT_FAILED`), show the `cancelableUntil` countdown while `FUNDED` pre-claim.
Cancel = two-tap confirm button (the [ArchiveButton](/apps/web/components/recipients/RecipientsManager.tsx)
idiom) → `POST /api/transfers/:id/cancel {transferId}` (key #3): handle `200` REFUNDED,
`202 cancellation_requires_support` (show `messages{en,es}`), `409 transfer_not_cancelable`. Simulate
pay = the dev-gated API endpoint (E) + web proxy + non-prod-only button. **Analytics**:
`send_funding_simulated` (dev), `send_transfer_canceled`.

**Tests**: poll state-timeline rendering across states; cancel branches (200 / 202 / 409); dev endpoint
`404` in prod-like env; Playwright cancel path.

## PR4 — Receipt + transfer history

**Files**: a receipt view backed by `GET /api/transfers/:id/receipt` (renders Reg E receipt content
en/es once `COMPLETED`; `404` before then); `app/dashboard/transfers/page.tsx` — `GET /api/transfers`
(cursor-paginated) → list with state badges linking to tracker/receipt. **Analytics**: `send_receipt_viewed`.

**Tests**: receipt render en/es + pre-COMPLETED 404; history pagination + empty state; Playwright
end-to-end (quote→confirm→simulate→completed→receipt).

*PRs 1–4 give a fully mock-driven send flow on staging. The API-side PRs below run after.*

## PR5 — Per-user risk controls (slice-8 pulled forward) *[API]*

New [risk.ts](/apps/api/src/services/risk.ts): **outstanding-uncleared cap** (SUM of the user's
not-yet-cleared `funding_receivable` entries vs a config ceiling; pilot-simple variant = one in-flight
transfer per user until ACH clears) + **velocity** (count + amount per rolling window). Config in
[env.ts](/apps/api/src/config/env.ts). **Enforcement**: at `POST /v1/transfers` (UX-facing) → wire the
defined-but-unthrown `403 limit_exceeded`; **authoritative backstop** at the `FUNDED→SUBMITTED` gate in
[payout-submit.ts](/apps/api/src/jobs/payout-submit.ts), mirroring the aggregate `FLOAT_CEILING_MINOR`
check. Web already maps `limit_exceeded` (PR1). Skills: `ledger`, `api-route`, `tdd`,
`financial-schema-checklist` (if a migration is needed). **Tests**: cap boundary (at/over), velocity
window, backstop rejects at submit, idempotent-safe.

## PR6 — AUTO_REFUND ops-trigger surface + full SUBMITTED/IN_FLIGHT cancel handling *[API]*

Backend + services/jobs + one operator CLI script — **no UI, not an admin dashboard** ("scripts over
console"). **AUTO_REFUND ops trigger**: `apps/api/scripts/trigger-refund.ts`, run by runbook to drive
`PAYOUT_FAILED→REFUNDED` while the flag stays **off** in prod (flipping it on is Stripe/pilot-gated).
**Full `SUBMITTED`/`IN_FLIGHT` cancel handling**: `submissionInProgressResponse`
([transfers.ts:137](/apps/api/src/routes/v1/transfers.ts)) returns a bare `202` today — build the
pending-cancel record + `UNDER_REVIEW` routing + ops-resolution surface, driven on mock. **Gated**: the
counsel-adopted error-resolution process (proposal, not adopted) and real-money execution wait — this
PR delivers the mechanism only. Skills: `api-route`, `ledger`, `migration` (if needed), `tdd`;
`security-reviewer` + `compliance-reviewer`.

## PR7 — Reg E disclosure-wording counsel package *[doc + staged copy, counsel-gated]*

**Doc** `docs/compliance/reg-e-disclosure-counsel-package.md`: the current copy (from
[disclosures.ts](/apps/api/src/services/disclosures.ts) `renderEn`/`renderEs`), the required changes —
cancellation wording "submitted for payout" → Reg E "picked up or deposited", and §1005.31(b)(2)(vi)
Receipt heading + date-available line for `buildReceiptDisclosure` — the statutory basis, and the
human-ES review ask. **Staged code**: a branch editing `disclosures.ts` (en+es), tests updated,
**merge-gated on counsel sign-off + human-ES review**. `compliance-reviewer`.

---

## Build sequence & workflow

- **Order**: PR1 → PR2 → PR3 → PR4 (web) → PR5 → PR6 → PR7 (API/compliance).
- **TDD-first** each PR. Web adds the **first Playwright harness** in the repo (net-new:
  `playwright.config.ts` + `test`/`e2e` script + turbo wiring) with a happy-path send spec; API work
  stays on Vitest + Supertest.
- **Per-PR gate**: `pr-prep` (typecheck + lint + test) green, then reviewers.
- **Skills**: `i18n` (every user-facing string, en+es), `feature-flag` (PR1), `api-route` (PR2/PR5/PR6),
  `ledger`/`financial-schema-checklist`/`migration` (PR5/PR6 as relevant).
- **Branch each PR from fresh `origin/main`.** **Never merge/push/open-PR/comment without explicit
  per-action approval.** Live-money credentials are Joshua-only.

## Subagent & review orchestration

**Implementation — main agent, not fanned out.** Each PR is built TDD-first, one at a time. The
idempotency/retry-dedup logic (PR1), risk-control enforcement + ledger reads (PR5), and Reg E / cancel
compliance surfaces (PR2/PR6/PR7) need single-context coherence, so they are not split across
build-subagents. Explore agents are used only if a PR surfaces an unknown.

**Review — parallel specialized agents per PR, run against the branch diff after `pr-prep` is green**,
then synthesize → fix → re-review:

| PR | security | compliance | code-review | silent-failure | test-analyzer | type-design |
|---|---|---|---|---|---|---|
| PR1 foundation | ✓ idempotency+proxies | — | ✓ | ✓ error layer | ✓ | ✓ new types |
| PR2 disclosure+confirm | ✓ | ✓ Reg E | ✓ | ✓ | ✓ | — |
| PR3 track+cancel+sim | ✓ dev-endpoint gating | — | ✓ | ✓ | ✓ | — |
| PR4 receipt+history | — | ✓ | ✓ | — | ✓ | — |
| PR5 risk controls | ✓ bypass+backstop | — | ✓ | ✓ | ✓ | ✓ |
| PR6 refund/cancel mech | ✓ | ✓ | ✓ | ✓ | ✓ | — |
| PR7 disclosure copy | — | ✓ primary | ✓ | — | — | — |

Plus **`codex-review`** (second model, findings verbatim) before each financial PR — currently blocked
on the OpenAI limit (resets ~Jul 29). CLAUDE.md mandates `security-reviewer` on every auth/financial PR
and `compliance-reviewer` on every consent surface; both are folded in above. **Optional "Max" pass
(opt-in):** for **PR1** (idempotency) and **PR5** (risk enforcement), a Workflow-orchestrated
adversarial review (parallel dimensions → refute-by-default verify → synthesize). Token-heavy.

## Where this leaves the product

Engineering scope, not calendar; mobile is a separate later track. Remaining blockers are mostly
**external approvals** and a **human/compliance track**, not code.

| Milestone | Before | After slice 7 | Gated on |
|---|---|---|---|
| Rail/API | ✓ | ✓ | — |
| Web send experience | 0% | **~done** (mock, e2e staging) | — |
| Per-user risk controls | 0% | **✓** (PR5) | — |
| **Pilot readiness (first real $)** | ~40% | **~85% (code)** | Stripe keys/MCC · Bridge KYB · prod worker · Bridge webhook + `S`/`A` |
| **Real-user launch** | ~40% | **~70%** | above + counsel sign-off · human-ES · slice-8 ops remainder |

**Still missing after this slice:** Stripe (keys + real adapter + Elements); the pilot (prod worker,
real Bridge webhook verification, `S`-vs-`A`, buy_rate-vs-execution); compliance human track (counsel
sign-off + human-ES; PR7 only *stages* the copy); slice-8 ops-floor remainder (daily reconciliation,
stuck-transfer alerts); `AUTO_REFUND` flip-on + ACH-cancelable check; mobile + niceties. **The single
biggest gate is Stripe.**

---

## Slice-8 remainder & Stripe-gated follow-ups (recorded now, resolved with real money)

- Real Stripe `FundingProcessor` adapter (`initiateFunding`/`verifySignature`/`parseEvent`/`voidFunding`/
  `refund`) + Stripe Elements at the pay step; confirm ACH is cancelable inside the 30-min window (else
  void→refund fallback); `PENDING_PAYMENT` cancel → void the real intent.
- The pilot send (~$20, prod, Joshua → own MX recipient); resolve buy_rate-vs-execution
  ([decisions.md](/docs/decisions.md) 2026-07-21); stand up the prod worker (`railway.worker.toml`);
  verify real Bridge `transfer.*` webhook signature against the prod endpoint.
- Verify Bridge `S` vs `A` return on failed payout; if `A`, reverse the slippage leg; then flip
  `AUTO_REFUND` on.
- Slice-8 ops floor beyond PR5's caps: daily reconciliation job, Sentry alerts on transfers stuck in a
  non-terminal state, the rest of "before anyone but Joshua sends."
- Reg E: counsel sign-off on the reconciled disclosure wording (PR7 stages it) + adopt the
  error-resolution process; human-ES review of disclosure copy before real users.

## Verification

- **End-to-end on staging via the mock funding webhook** (primary proof): quote → create → accept
  disclosure → confirm → **Simulate payment** (drives `FUNDED`) → watch the tracker advance
  `FUNDED→SUBMITTED→…→COMPLETED` → view the receipt. Also the cancel branch: create → confirm →
  simulate → **Cancel** while `FUNDED` pre-claim → assert `REFUNDED`. Mirrors
  [run-payout-e2e.ts](/apps/api/scripts/run-payout-e2e.ts) but through the UI.
- **Browser preview loop**: run the web dev server, drive the flow, check console/network + screenshot
  each screen (quote, disclosure, tracker, receipt) in en and es.
- **Playwright** happy-path spec (seed an approved session, quote→confirm→simulate→completed→receipt).
- **API tests** (Vitest + Supertest, DB tests under `RUN_DB_TESTS`) for PR5/PR6.
- **`pnpm run typecheck` + `pnpm test`** green before each PR.
