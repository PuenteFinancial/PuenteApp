# Decision Log

**Started:** 2026-07-13 (seeded retroactively from PR history, design docs, and session notes).
One dated paragraph per decision: what, why, status. Newest first. Add an entry whenever a choice
would make a future engineer ask "why on earth…" — that question is the inclusion test.

---

**2026-09-03 · `transfers.funding_processor`: the rail is a property of the ROW, not the process
(audit 2026-09-02 corner 1).** Every job that acted on a transfer read `env.FUNDING_PROCESSOR` to
decide its rail: the reconcile-pending abandonment clock (30 min vs hours vs days), which adapter
`refund()`/`voidFunding()` runs on, whether an operator may record manual funding, the aging
watchdog's bound. Correct only while every row was funded under the deployment's current rail —
the K7 prod flip (`manual` → `stripe_crypto`) would have reaped every pending manual row at 30
minutes and sent manual refunds to Stripe. Now confirm and onramp-session stamp
`funding_processor`, and those readers go through `processorNameFor(row)` / `processorFor(row)`
(`services/funding/index.ts`), which fall back to the process value for a null. Two deliberate
non-choices: no CHECK on the column (the enum lives in `env.ts`; a CHECK turns a new rail into the
drop-and-re-add dance), and no backfill for `cos_` refs (`stripe_onramp` and `stripe_crypto` share
that namespace — a guess would be worse than the env fallback, which is today's behaviour). One
semantic change: `recordManualFunding` now reads the row FIRST and refuses on the row's rail, so a
`pi_` row is refused on a manual deployment and a manual row stays recordable after a flip. Left
on env on purpose (deployment-capability or no-row-yet decisions): the confirm/funding-session
gates, the webhook signature gate, `onramp-prepare`'s replay guard, Stripe receivables/orphan
sweeps. Reversal: drop the column; every reader degrades to the env fallback. **Status: active.**

**2026-09-03 · K6: DOB and tax ID are RELAYED once to Bridge — the 2026-08-27 custody rule's
degrade clause, invoked.** The rule said SSN through our servers is a hard never, degrading to
relay-never-persist only if Bridge's docs proved they require us in the middle. Proven in the
sandbox 2026-09-02 against `POST /v0/customers`: a create with name/email/DOB/address/SSN returns
201 and Bridge itself completes `sanctions_screen`, `pep_screen`, `blocklist_lookup` and
`database_lookup` from those fields; its requirement tree lists a document only as
`{ any_of: [database_lookup, government_id_document] }` (optional), while omitting the tax ID
moves `tax_identification_number` into `missing.all_of` (mandatory, no alternative). No sharing
endpoint exists and `kyc_links` is an alternative way to *collect*, not to accept verification done
elsewhere. So the K5 form's two values go once to `POST /v1/users/me/bridge-customer`, straight to
Bridge, and the custody line is now a six-part invariant instead of a convention: (a) exactly one
route schema carries them and no response schema does, (b) no migration column stores them,
(c) no log line ever contains them, (d) Sentry redacts them by key name, (e) the route's
preconditions/rate limit/no-op/duplicate mapping hold, (f) the web machine names `relay` as its
second and last PII-carrying effect (`schema-pii.test.ts`, `bridge-customer.test.ts`,
`sentry-scrub.test.ts`, `cryptoPayStep.test.ts`). Details that are not obvious from the code: the
relay gates on `stripe_kyc_tier IN (L1, L2)` rather than `stripe_kyc_tier_status`, because the
status column is whatever verification Stripe lists first; the Bridge Idempotency-Key is per-user
PLUS a body hash so a byte-identical retry replays the same customer while the one permitted
correction gets a fresh key (Bridge 422s same-key/different-body); `signed_agreement_id` lives in a
mutable `users` pointer beside the immutable `consents` evidence row because it is single-use at
Bridge; destinations are registered on the approval webhook, not at relay time, because an
unverified customer cannot hold external accounts (the 2026-08-28 probe). Persona is demoted to
the fallback for database-lookup failures. Open facts: Bridge's rejection-reason vocabulary and
duplicate-tax-ID error shape (classifier pinned to sandbox fixtures), whether customer-level
`approved` implies the `spei` endorsement, and ITIN behaviour on the Stripe side (its SDK types
`id_number` as `us_ssn` only). Supersedes the 2026-08-28 KNOWN GAP below (#269 + K6 resolve it).
**Status: active** (K6a).

**2026-08-28 · KNOWN GAP (deferred to the K6/custody session): destination-add requires an
approved Bridge customer, which KYC-at-first-send users don't have yet.** Found on the K5 live
drive: `POST /v1/recipients/:id/destinations` registers the CLABE with Bridge at save time and
hard-requires `bridge_customer_id` (`destinations.ts`), but under `web-kyc-at-first-send` no
Bridge customer exists until the first-send fallback — which itself needs a destination to quote
against. Circular; flag-ON users cannot reach the send flow with a fresh account. Probed
2026-08-28 against the Bridge sandbox: a TOS-signed, address-complete but UNVERIFIED customer
still gets `missing_required_endorsements` on external-account create, so "bare customer at
destination-add" is NOT viable — endorsements arrive only with approved KYC. Candidate fixes
(lazy CLABE registration at payout time · Persona at destination-add · sharing-derived customers)
all belong to the K6/Bridge-handoff custody conversation, which now owns this. The flag stays OFF
everywhere until it's resolved (fail-OFF design already enforces that). **Status: open — blocks
the K7 flag flip, not the K5 merge.**

**2026-08-28 · Persona/Bridge fallback sits BEFORE payment in the K5 send flow.** When Stripe KYC
verifies but the user has no `bridge_customer_id` (Bridge→Stripe sharing not live), the send flow
routes through Bridge TOS + hosted KYC *before* `collectPaymentMethod` — no money moves until the
payout side can accept it. The alternative (pay first, gate the payout) is faster-feeling but can
strand funds at FUNDED behind an abandoned or manually-reviewed Persona pass, making refund ops
the failure mode. `payout-submit`'s throw on a null `bridge_customer_id` remains the backstop,
not the mechanism. **Status: active** (K5).

**2026-08-28 · KYC-form address edits sync back to the profile.** The K5 KYC form prefills from
`users` (name + address); if the sender edits the address there, the client PATCHes
`/v1/users/me` (K2's all-or-none address group) before `submitKycInfo`, so our stored address
stays consistent with the identity Stripe verified. SSN/DOB are never part of that PATCH — they
go client→SDK only, and a unit test pins that no payload builder can emit them. **Status:
active** (K5).

**2026-08-27 · KYC moves from onboarding to first send (KYC rehaul, K-lane).** Identity
verification leaves onboarding entirely: onboarding collects information and consents only, and
ALL KYC happens at first send, in our own UI, via Stripe embedded components (private preview) —
Stripe verifies, Bridge accepts the verification via KYC sharing. Persona/Bridge-hosted KYC is
retained **as a fallback only** (relocated to first send) so the prod flip is not hostage to
Bridge's sharing timeline. Supersedes 2026-07-13 "shipped KYC is Bridge-hosted"; the Bridge
webhook + `kyc_status` machinery survives to serve the fallback. Canonical plan:
`~/.claude/plans/rehaul-kyc-and-onboarding-stripe-first-sunrise.md` (ratified after Q1–Q8 grill).
**Status: active** — K1 (consent foundation) is the first merged slice.

**2026-08-27 · Unified consent page + append-only `consents` table; E-SIGN scope expanded to all
electronic records (K1).** Two checkboxes (E-SIGN; Puente TOS+Privacy) with Stripe/Bridge terms
as disclosure links — assent to provider terms happens on their own surfaces at first send. The
E-SIGN consent scope is a **knowing expansion** from the 2026-08-19 receipt-only scope to all
electronic records, because the rehauled flow delivers agreements, disclosures, and statements
electronically end-to-end. Consent versions are code (`REQUIRED_CONSENTS` in packages/shared);
a version bump forces app-wide re-consent via the `/continue` router. Placeholder documents are
acceptable until the K7 prod flip, which gates on counsel-reviewed text (one-time paid review
agreed). **Status: active.**

**2026-08-27 · Stripe markup permanently unconfigured; all margin via Bridge
`developer_fee_percent`.** Stripe's onramp markup is account-level and sticky ("difficult to
change" per their SA); Bridge's developer fee is per-transfer and freely changeable. So the
Stripe knob stays at 0 forever and every future basis point of take lives on the Bridge leg.
Pricing itself is deferred to Stripe's fee-schedule follow-up + the #197 spread probe.
**Status: active.**

**2026-08-27 · Mobile lane frozen until K8.** The entire mobile lane — not just its KYC screens —
freezes while the rehaul lands on web (K1–K7). Old mobile KYC screens stay dead behind the flag;
new-flow demos are web-only until K8 brings the mobile arm (seamless sign-in is mobile-only and
needs app attestation prerequisites). **Status: active.**

**2026-08-19 · A sender's payment claim never releases the payout; release stays a human ops
action (funding-ops-automation PRD).** The manual rail is getting a sender-facing "I've sent the
payment" button, and the obvious automation — treat the claim as the release trigger — is
permanently off the table. Releasing (`kind: funded`) draws roughly the transfer total from the
treasury float immediately, with the sender's deposit reimbursing it days later; releasing on the
sender's own assertion would let any signed-in user drain the float by lying, which is the same
attack the manual funding processor's no-webhook design exists to prevent
(`apps/api/src/services/funding/manual.ts`). The claim therefore writes a timestamp
(`transfers.payment_claimed_at`), surfaces on the ops board, and nothing else; the release tap
remains an allowlisted operator's judgment under the 2026-08-18 evidence-of-initiation policy.
If a future rail makes releases safe to automate, it will be because the *evidence* became
machine-verifiable (a bank-confirmed debit, a processor webhook) — never because the claimant
said so. **Status: active**

**2026-08-10 · pnpm's `minimumReleaseAge` is never waived to satisfy a tool; the tool takes the
older version (#168).** `npx expo install` wanted expo 57.0.12 during the SDK 57 migration and
silently appended a 14-entry `minimumReleaseAgeExclude` to `pnpm-workspace.yaml` to get it — the
whole 57.0.12 release had gone out hours earlier, inside pnpm's 24h supply-chain window, on the
same day we spent repairing a lockfile that policy had correctly rejected. Punching a per-package
hole in a supply-chain control to save one patch version is the wrong trade every time it is
offered, and it *will* be offered again: `expo install` reaches for the exclusion list on any SDK
bump whose bundled set is fresher than the window, and it does it without asking. The standing
answer is to take the older version. Mobile therefore pins 57.0.11 (Aug 6) and its entire bundled
set, which clears the cutoff with no exclusions at all. The cost is `npx expo-doctor` reporting
patch-level version mismatches until the newer patches age out — 4 packages the day of #168, 5 the
next morning, which is the shape of this debt: it accrues slowly, then clears in one PR. Nothing
needs doing by hand, because the `expo` group in `.github/dependabot.yml` covers `expo*`/`@expo/*`
on minor and patch (only majors are ignored) under a 3-day cooldown deliberately stricter than
pnpm's own 24h — the bump lands on the first Monday run after the release ages out. **This is
timer-bound debt, and it is a different category from the SDK-managed pins in the same file**:
`react-native`, `react-native-safe-area-context`, `react-native-screens` and `@sentry/react-native`
are hard-ignored for *all* update types and move only inside a deliberate SDK upgrade, because
their versions come from the installed SDK's `bundledNativeModules.json` rather than from semver.
One waits on a clock and resolves itself; the other is frozen by decision and resolves only when
someone decides. Do not "tidy up" the second while clearing the first — that is precisely how
mobile drifted a full major ahead on Sentry and a minor ahead on react-native while still on SDK
56. **Status: active** — the 57.0.11 pin lapses on its own; the policy it illustrates does not.

**2026-08-01 · Ops v1.1 admin gate = double-control env pair, not RBAC/step-up; refusals are
non-2xx; JWT claims pinned (8.5-v1.1).** The promised "real admin-auth design" for the first
ops write path (`POST /v1/ops/cancellations/resolve` — refund/deny buttons on the
pending-cancellations panel) is deliberately small: identity (`OPS_ADMIN_USER_IDS`) ×
capability (`OPS_WRITE_ENABLED`), two env controls set independently in Doppler, both required
before the POST is even registered, both re-checked (plus membership) as the handler's first
statement with the same 404-never-403 byte-identical body. At an admin population of one,
env-var change control IS the approval workflow — a grant is a Doppler change plus a restart,
and there is no in-product path to self-escalate. Deliberately NOT built and why: SMS step-up
(Twilio A2P approval still pending, and the OTP machinery is login-shaped — it would need a new
action-token design), `app_metadata` role claims (revocation lags the access-token refresh — a
real hole on a money-writing path), RBAC tables (nothing to govern at N=1). The endpoint wraps
the SAME `cancellation-review.ts` services the CLI calls, per the 2026-07-27 decision — the CLI
stays break-glass; actor is `ops:<admin user id>` from the verified JWT, never from the body.
Two couplings worth remembering: **refusals map to non-2xx** because the idempotency plugin
stores/replays only 2xx — a 200-refusal would freeze a transient claim state into every retry
(and `refund_owed` / `claim_abandoned` / `deposit_evidence_conflict` get their own codes because
each demands different operator behavior); and `plugins/auth.ts` now pins issuer, audience, and
the asymmetric algorithm set — signature-only verification was tolerable while `sub` merely
selected your own rows, not once a token carries write authority over other people's money. The
algorithm pin is `['ES256','RS256']`, NOT the single ES256 key both JWKS hold today: both
projects advertise RS256 as well, so an exact-key pin would convert a routine Supabase signing-key
rotation into a total lockout of every user on every route. Excluding HS* is the part that carries
the security value (a forged `alg:HS256` verified with the published public key as an HMAC secret);
narrowing further only buys an outage. Issuer derivation and the advertised algorithm set were
read from each project's `/auth/v1/.well-known/openid-configuration`, not assumed. `actionsEnabled` on the overview wire tells the web whether to render buttons, so a
read-only deployment shows no dead buttons and capability is never probed.

**2026-08-01 · Ops page v1 = read-only, env-allowlisted, 404-never-403 (8.5-v1).** The
"where do I see what needs me" surface ships as `GET /v1/ops/overview` + `/dashboard/ops`
behind `OPS_ADMIN_USER_IDS` — a comma-separated user-UUID allowlist, FAIL-CLOSED (unset ⇒
the route is not even registered) with the dev-route double-check posture: the handler
re-verifies membership first and answers a 404 byte-identical to the router's own not-found,
so the surface never confirms it exists. This is deliberately NOT the real admin-auth design —
that arrives with v1.1's action buttons and its own security gate; v1 has no write path at
all, which is what makes the stopgap acceptable. Panel choices that would otherwise puzzle:
ledger balances come from the LATEST reconciliation run's snapshot (staleness explicit via
asOf) rather than a live RPC — the one balance that must be live, funding_receivable vs the
float ceiling, comes from the float panel; transfers-by-state is a new
`ops_transfer_state_counts()` SQL GROUP BY because a TS-side count over a bounded select
would hit the 1000-row loud-throw exactly when terminal states accumulate (i.e. when the
business works); the needs-you findings panel shows only the LATEST run's non-pass checks —
findings have no resolved-bit, so "latest" is the only honest read; recon check `summary`
objects are excluded from the ops wire entirely (schema is the output allowlist). The
open-transfers panel shows dwell + judgment annotations (hold reason, cleared flag, claimed
marker, cancel-tap) and deliberately does NOT re-run the stuck-watch whitelist — the page
shows inputs, the Sentry pager owns verdicts; a FUNDED row deliberately waiting will show
over-threshold WITH its explanation. No dashboard nav entry: direct URL only, so
non-admin dashboards never probe the endpoint.

**2026-08-01 · Stuck-watch pages on state-entry time from the transitions log; deliberate
waits are whitelisted by re-running payout-submit's own checks (O1).** The 5-min
`transfers.stuck-watch` cron anchors dwell on the transfer's latest `transfer_transitions`
entry into its current state — not `updated_at` (moves on any write, hiding a stuck row
exactly when something touches it) and not the write-once stamps alone (a round trip like
UNDER_REVIEW→COMPLETED→UNDER_REVIEW would misdate the current stay; the stamps serve only as
a cheap over-selecting pre-filter). A dwelling FUNDED row is exempt when payout-submit itself
would deliberately skip it, decided by literally the same checks: `payout_hold_reason`,
`WAIT_FOR_CLEARING`, flag-first `FIRST_TRANSFER_HOLD` + `hasClearedHistory`, and
`assessUnclearedCap` with the identical excludeTransferId/olderThan wait-die shape — a
re-derived approximation would drift from the gate the moment either changed. The exemptions
apply to UNCLAIMED rows only: payout-submit skips every wait gate on crash recovery
(`isRecovery` = `submit_attempted_at` set), so a claimed row's dwell is never deliberate and
always pages (codex-review finding). A live-state re-read guards the page against the
bulk-read snapshot racing a payment event (a just-completed transfer must not page as stuck),
and the episode fingerprint carries the state-entry time so a round trip back into the same
state opens a fresh issue instead of reopening history (both codex findings). The known
alert overlaps (payout-poll's stale-in-review, O2's daily aging) are deliberately NOT
deduped: each fingerprint answers a different question, and collapsing them would hide
whichever signal fired first. UNDER_REVIEW's 24h page is calendar-blind by design — the
statutory business-day clock waits for counsel's error-resolution adoption.

**2026-07-31 · Reconciliation = detection-only checks registry; Stripe legs never self-heal (O2).**
The daily `ledger.reconcile` cron runs a registry of independent checks (each returns
pass/findings/skipped/error) rather than one monolithic sweep: one check failing must not blind
the others, and the per-check rows in `reconciliation_runs` are what the 8.5 ops page will render.
The only auto-action in the registry is the Bridge state sweep, which literally re-runs
`payout.poll` — the existing idempotent replay path. The Stripe legs (PI status vs state,
orphans) **detect and page only**: funding webhooks are handled inline in the route, so there is
no funding-side replay job to hand a synthesized event to — the runbook action is resending the
event from the Stripe dashboard, which the route dedupes. Deliberately deferred: `cash_clearing`
↔ Stripe-balance/bank comparison (meaningless until settlement cash legs exist — nothing relieves
`funding_receivable` on `funding_cleared` today, which is also why the negative-balance guard
excludes `cash_clearing`), and fee-line reconciliation. The `state_postings` self-check encodes
the state⟺posting rules from the batch builders; `UNDER_REVIEW`/`FUNDING_REVERSED` get only the
FUNDED-posting rule because their open positions are entry-path-dependent (human investigation,
not a mechanical rule). Aging thresholds are constants, not env: they encode process clocks
(30-min auto-fail, SPEI seconds, ACH T+4), not tunable policy.

**2026-07-31 · Instant-only bank verification; microdeposits deferred (S3).** The Payment Element
mounts with the server-pinned `verification_method: 'instant'` (Financial Connections) and no
fallback. Microdeposit verification takes 1–2 business days, which collides with two clocks that
assume payment-or-fail within minutes: the 30-min `PENDING_PAYMENT` auto-fail (reconcile-pending)
and the 15-min FX rate lock — a microdeposit sender would systematically trip both, and doing it
right needs verification-aware dwell plus a requote/redisclose flow. Deferred until that exists
(likely alongside SetupIntents/saved accounts). An unconnectable bank gets clean en+es copy stating
we cannot take the payment and nothing was charged. Revisit with pilot data on FC coverage misses.

**2026-07-31 · Pay-step reload recovery = on-demand funding-session endpoint (S3).** The Stripe
`client_secret` existed only in the confirm response, which the web deliberately discards — so a
reload at `PENDING_PAYMENT` (or another device) couldn't mount the Element on a tracker URL that is
reload-safe by design. Options considered: thread the confirm body + sessionStorage (secret
persisted client-side, dies across tabs/devices, and the recovery path would rot as a rarely-run
branch) vs. a read-only endpoint. Chose `GET /v1/transfers/:id/funding-session`: the server
retrieves the live PI by `funding_payment_ref` on demand — the secret is never persisted in our DB,
never threaded through client state, never logged; every mount exercises the same path so it can't
rot. The publishable key rides on the same response (new `STRIPE_PUBLISHABLE_KEY`, required
alongside the two secrets under `FUNDING_PROCESSOR=stripe`) instead of a `NEXT_PUBLIC_` build-time
var: processor selection and key stay co-located in the API env, and the mock/stripe affordance
branch stays server-driven — a mock env never loads js.stripe.com at all.

**2026-07-31 · One uncleared send in flight per user; first-transfer hold built but OFF (slice-8 O3).**
Under instant-front the MXN leaves on `payment_intent.processing` while the sender's ACH debit can
still bounce for ~T+4, and nothing bounded *stacked unsettled debits* — the amount/velocity caps
(PR5) bound dollars per window, not how many revocable pulls are simultaneously in flight. New
control: `RISK_UNCLEARED_MAX_COUNT` (default **1**) committed-but-uncleared sends per user, a slot
held from `disclosure_accepted_at` until `funding_cleared` flips (or the send unwinds), with **no
time window** — COMPLETED-but-uncleared still counts, because a delivered payout with a revocable
debit IS the exposure. This **supersedes the 2026-07-27 PR5 note that dropped a concurrency cap as
redundant**: the locked 2026-07-29 decision adopts the PRD's pilot-simple *count* variant as the
uncleared-exposure control, and it doubles as the substrate for first-transfer holds. Count, not
dollar-sum, because the sum is still unbuildable (that entry's point (1) stands: `funding_receivable`
never drains on the happy path) while `transfers.funding_cleared` is maintained by both processors —
the dollar cap stays deferred. Enforcement mirrors PR5: friendly `403 transfer_in_progress` at
quote/create/confirm (commit-time, before acceptance is recorded, so a blocked send never occupies a
slot and a committed retry keeps its slot), plus the authoritative `FUNDED → SUBMITTED` backstop —
but there it's a **self-heal wait, not a hold** (the blocker clears or unwinds on its own; the 1-min
sweep resumes, Sentry `['uncleared-cap-wait', id]` warns per waiting transfer). The backstop counts
only strictly-**older** rows by `(disclosure_accepted_at, id)` — two sends can race-commit past the
confirm gate, and a symmetric count would deadlock both forever; older-wins picks exactly one.
**First-transfer hold** (`FIRST_TRANSFER_HOLD`, default OFF, WAIT_FOR_CLEARING-shaped silent skip):
an unproven sender — no send with `funding_cleared=true` outside `FUNDING_REVERSED` — waits for
their own clearing; ships dark, flips with real R01 data before widening past the trusted five.
Consequences owned explicitly: (a) a **bounced pull caps the sender indefinitely** — post-FUNDED
`funding_failed` is stale-logged and `funding_reversed` handling is deferred, so the slot never
frees until ops resolves the row; intended (their exposure is genuinely live), and blocking
repeat sends after a real `FUNDING_REVERSED` lands is the named slice-8+ follow-up. (b)
**Dev/staging clearing stays script-only** (2026-07-30): the simulate button fires only
`funding_succeeded`, so a second staging send 403s until
`pnpm tsx scripts/fire-funding-webhook.ts <id> cleared` — deliberate, staging mirrors prod timing
and the cap demos itself. (c) **O1 interplay**: the future FUNDED-dwell watch must account for the
three deliberate no-hold waits (WAIT_FOR_CLEARING, FIRST_TRANSFER_HOLD, the uncleared cap) or
first-transfer holds will page as stuck transfers.

**2026-07-30 · Settlement decides the undo mechanism, and the ledger branches on it (PR-S2).**
The Stripe adapter's undo ops resolve the LIVE PaymentIntent instead of trusting their nominal
mode: an uncleared ACH pull can only be VOIDED (`paymentIntents.cancel` — ACH is the one method
cancelable during `processing`; Stripe refuses to refund an unsettled charge, and a refund beside
a late dispute double-credits), while a settled one can only be REFUNDED (`refunds.create`, async:
`FundingUndo.status 'pending'`, resolved later by `refund.updated`/`refund.failed`). So
`voidFunding` falls back to a full refund when the PI settled first (sandbox settles instantly —
the fallback IS the sandbox path; closes the slice-7 "ACH-cancelable + void→refund fallback"
item), and `refund` voids while the PI is still processing — which under real ACH timing
(settlement ~T+4, payout failures in minutes) makes **void the MAIN path of the refund tails**,
not the edge. Three consequences. (1) `FundingUndo.mode 'voided'|'refunded'` +
`undoModeForRef()` — the ref prefix is the durable mode encoding, because crash-recovery replays
reach the settle holding only `refund_payment_ref` — and the REFUNDED/correction batches branch
on it: a void posts the FUNDED reversal (`voidRefundLedgerEntries`) or writes the receivable off
against the correction loss (`correctionVoidLedgerEntries`); posting the cash batch for a void
would credit `cash_clearing` for money that never moved and leave `funding_receivable` open
forever (ledger-rules.md has the variant postings). (2) Refund tails are recorded to
`payment_events` (source `'funding'` — the slice-5 CHECK admitted it from day one), handled
inline by the funding webhook route, and re-driven by the sweep→job path on a crash;
`refund_failed` pages `funding-refund-failed` (per-transfer fingerprint, manual-refund runbook) —
after a bounce the sender is STILL OWED and nothing auto-adjusts. (3) Stripe idempotency
sub-keys per POST arm (`…:cancel` / `…:create` under the callers' unchanged `:void`/`:refund`
roots), because Stripe caches failed POSTs under their key — a cancel that lost the settlement
race must not poison the fallback refund's key. The two sandbox experiments
(cancel-after-batch-cutoff semantics, dispute-after-refund) are deferred to the keys-in-hand
close-out session. **Status: active** (PR-S2)

**2026-07-30 · FUNDED fires on `payment_intent.processing`, not `succeeded` — instant-front is a
webhook mapping, not a policy switch.** The Stripe adapter (PR-S1) maps `payment_intent.processing`
→ `funding_succeeded` (drives PENDING_PAYMENT → FUNDED, posts the funding ledger batch, enqueues
the payout) and `payment_intent.succeeded` → `funding_cleared` (the flag `WAIT_FOR_CLEARING`
consults). ACH is delayed-notification: `processing` means the debit was submitted to the network;
settlement lands ~T+4. Fronting the payout at submission IS the product (family gets pesos today);
the exposure containment is elsewhere — per-user caps (PR5), the float ceiling, and slice-8's
uncleared-exposure controls. The failure tails map likewise: a pre-settlement return arrives as
`payment_intent.payment_failed` → `funding_failed`; a post-settlement return arrives as
`charge.dispute.created` → `funding_reversed` (final, no appeal — Stripe ACH disputes cannot be
contested). Two consequences recorded now: (1) dispute payloads carry no metadata echo, so
`FundingEvent.transferRef` went nullable and the webhook route joins through the persisted
`transfers.funding_payment_ref`; (2) a `funding_failed` that arrives AFTER the instant-front (state
already FUNDED) currently surfaces as a logged `transition_conflict` and nothing else — the
money-truth tail for that case is PR-S2's settlement-aware undo work plus the O-lane
reconciliation, deliberately not smuggled into the adapter PR. **Status: active** (PR-S1)

**2026-07-29 · The aggregate Reg E double-pay guard is an hourly cron over the ledger, not an
alert at write time.** `ledger.correction-watch` sums `loss_cancellation_correction` over a rolling
window (`LOSS_CORRECTION_WINDOW_DAYS`, default 7) and pages `loss-correction-threshold` (warning)
at `LOSS_CORRECTION_ALERT_MINOR` (default 20000 = $200 — about the second correction at launch
limits). Why a cron and not the write path: the write is a human-driven CLI that already pages
per-transfer at owed-time and executes deliberately — a TREND question belongs on the aggregate,
where it also catches anything a future writer posts to the account. The sum is SIGNED
(debits − credits, the account's normal balance): the append-only ledger reverses an erroneous
correction with a new credit, and a debit-only sum would keep alarming on money already clawed
back. Reads fail closed (a broken read throws to pg-boss retry, never "no corrections"); two
queries instead of an embedded join so a typo'd account code throws via `.single()` instead of
reading as a quiet week. Knobs are hard-defaulted (RISK_* style) so the tripwire stays armed when
unset; episode dedupe is the global Sentry fingerprint (float-ceiling mechanism), no persisted
state. **Status: active** (slice-7 debt pass)

**2026-07-29 · Every Bridge call gets a hard deadline, and the refund-claim staleness window drops
30 → 10 minutes.** `bridgeFetch` now sets `AbortSignal.timeout(BRIDGE_TIMEOUT_SECONDS × 1000)`
(default 15s, env-tunable 1–120) — the one helper all nine Bridge functions route through, so the
bound is universal. A fired timeout rejects on the SAME non-`BridgeApiError` path as undici's
network `TypeError`, and no caller branches on either class (routes map to 502/503, jobs rethrow
into pg-boss retry), so the only behavior change is failing in seconds instead of undici's ~300s
defaults. The `FundingProcessor` seam gains a matching contract: network-bound adapters (Stripe,
slice 4b) MUST bound their own calls. That removes the entire basis of the 2026-07-28 entry's
"**30 minutes, not 10**" derivation for `CLAIM_STALE_AFTER_MS` — the window existed to keep an
abandoned-claim page from firing on a merely-slow call, and bounded calls cannot be 10-minutes
slow. It now matches the submit claim's 10 minutes; the asymmetry that REMAINS is what stale
*means* (submit self-heals by idempotent re-POST; an abandoned refund claim pages a human, is
never machine-retaken, and the sender may already have been paid — so page sooner). Caller error
mapping deliberately NOT redesigned here. **Status: active** (slice-7 debt pass)

**2026-07-28 · A post-submission cancel routes through `UNDER_REVIEW` on the COMPLETED tail ONLY —
and that is not a return to "cancellation = error resolution."** Slice-7 PR6b records every
post-submission cancel as a `cancellation_requests` row and resolves it when the payout settles. The
shape needs defending because an earlier design said post-submission cancels route through
`UNDER_REVIEW` generally, and [transfer-state-machine.md](transfer-state-machine.md) superseded that
as **wrong on the law**: §1005.34 cancellation is not §1005.33 error resolution. They have different
clocks, different remedies, and different lawful denials. Treating a cancellation as a dispute would
put the sender on the wrong clock and invite us to "investigate" a request that needs no
investigation — they have an unconditional right, exercised in time or not. So the binding rule is
**state-keyed**: a timely cancel at `SUBMITTED`/`IN_FLIGHT` owes a full refund once the payout
resolves, whichever way it resolves. Two tails follow. **Payout fails** → the existing refund tail
already makes the sender whole; nothing further is owed and the request just closes. **Payout
completes** → §1005.34's second condition decides it: the refund is owed only if the request was
made **before the funds were deposited** (both conditions are evaluated as of the request — see the
research memo). On an instant rail that matters enormously: SPEI deposits in seconds while the
window runs 30 minutes, so most in-window cancels arrive *after* the deposit and are owed nothing —
a human denies them on the record with Bridge's deposit timestamp as evidence. Only a request that
genuinely **beat the deposit** is owed the full refund — the recipient keeps the money and the
sender gets theirs back. That accepted, bounded double-pay is the price of the statutory right,
now confined to a seconds-wide race. (Initially implemented on the clock condition alone, which
over-committed to paying twice on every in-window cancel; corrected 2026-07-28 same-day, before
merge.)
`UNDER_REVIEW` appears on that second tail alone, and **not because the cancel is a dispute** —
because `COMPLETED → UNDER_REVIEW → REFUNDED` is the only modeled post-delivery correction path and
already carries the right ledger treatment. It is a holding state meaning "a human owes this transfer
a decision," not a claim that anything is being adjudicated. Three consequences. **(1) The correction
gets its own expense account.** `loss_cancellation_correction`, not the existing
`loss_funding_reversed`: an ACH return is a credit/fraud loss, this is a compliance cost, and sharing
a bucket means the ledger cannot answer "what did Reg E cost us" without a per-transfer join. Cheap
to separate while PR6b is the only writer; a data migration over append-only entries later. **(2)
Denial is never automatic, and a request that beat the deposit can never be denied at all.** Denial
has exactly two lawful grounds, mirroring the statute's two conditions: out-of-window (provable from
our own `cancelable_until`) and deposit-preceded-request (provable only from Bridge's deposit
timestamp — which is why `--deposited-at` is load-bearing in the deny guard, compared against
`requested_at`, not merely recorded). Either way the transfer stays/returns to `COMPLETED` — flipping
a delivered transfer's state for a request we will not honour would be a lie in the state log. The
resolution tool refuses `--deny` when both conditions held; if such a request genuinely must not be
paid, that is an escalation, not a flag. **(3) The correction payment takes the same refund claim as the PAYOUT_FAILED tail.** Both
disburse against `refund_payment_ref` on one transfer, so they contend on one lock rather than two
implementations of the same predicate. **Status: active** (slice 7 PR6b)
([runbooks/pending-cancellation.md](runbooks/pending-cancellation.md); supporting research incl. the
reg text, the commentary's silence, and Remitly's request-time completion definition:
[research/reg-e-cancellation-after-delivery.md](research/reg-e-cancellation-after-delivery.md) —
counsel-gated via PR7).

**2026-07-28 · Cancellation timeliness is RECORDED, not enforced at the door.** The 202 that answers
a post-submission cancel fires on **state alone** — it never consults `cancelable_until` — so a cancel
tapped on a transfer stalled at `IN_FLIGHT` for days gets the same 202 as one tapped a minute after
submission. Two ways to handle that, and we picked the second. **Rejected: gate the 202 on the
window**, answering a flat 409 once it has passed. That refuses to even acknowledge a request the
sender is entitled to make, and destroys the evidence that they made it — which is exactly what a
regulator would ask us to produce. **Chosen: record every request, and stamp it `within_window`.**
The wire shape does not change; the row carries the fact. Only a timely request creates an automatic
obligation; an untimely one is still recorded, still visible, and still resolved by a human on the
record. `within_window` is computed inside `record_cancellation_request` from the row being recorded,
so timeliness is evaluated atomically with the record rather than read separately by a caller whose
view may already be stale — and once written it is frozen, because the answer to "was this in time"
must not change with the clock. The corollary is that recording must never fail the request: a
persistence error logs, pages, and still returns the 202, because our bookkeeping problem must not
present to the sender as a rejection of their statutory ask. **Status: active** (slice 7 PR6b).

**2026-07-28 · Two atomic claims that behave OPPOSITELY when stale — and that asymmetry is the
decision.** Slice-7 PR6b-0 adds the **refund claim** (`transfers.refund_claimed_at` /
`refund_claimed_by`): a guarded UPDATE one run wins before calling the funding processor. It closes a
real hole in PR6a — `refund_payment_ref IS NULL` was a *read separated from its write*, so a poller
re-drive and an operator's `trigger-refund.ts` could both read null and both pay the sender. That was
survivable only in theory: the exactly-once guarantee rested on the processor's idempotency key, and
[`MockFundingProcessor.refund()`](/apps/api/src/services/funding/mock.ts) **ignores that key by
design**, so today the claim is the *only* defence, not a second one. The shape mirrors the shipped
**submit claim** ([`claimForSubmission`](/apps/api/src/jobs/payout-submit.ts)) — and then deliberately
diverges on the one question that matters: **what a stale claim means.** A stale submit claim means
*re-POST to Bridge idempotently and skip the guards*, because Bridge dedupes on the key, so recovery
cannot double-pay; the sweep can safely treat 10 minutes as stale and re-enqueue. A stale refund claim
means **stop and page a human**, because nothing gives the funding seam that guarantee: a claim that
was taken but never recorded a `refund_payment_ref` may mean the sender was already paid, and only a
person checking the processor can tell. So it is never retaken by a machine. Four consequences worth
recording. **(1) The window is NOT in the claim predicate.** The guard is bare
`refund_claimed_at IS NULL`; the staleness window *(30 minutes at the time — 10 since 2026-07-29,
see above)* lives in the backlog classification, the alert, and
`releaseStaleRefundClaim`. Putting it in the predicate would silently restore auto-retake — the exact
behaviour this rejects — so a test asserts the predicate has no staleness term. **(2) There is no
release-on-throw.** An earlier draft cleared the claim when the processor threw, to keep transient
errors from becoming pages. Dropped: `FundingProcessor` has no error taxonomy, so a timeout (money may
have left) and a definitive rejection (it did not) throw identically, and releasing would green-light
a retry that may pay twice. A processor throw leaves the claim standing and it goes abandoned. **(3) A claim refusal must not retire the payment
event.** Both claim refusals mean the refund has *not* happened, so the job leaves the event
`received` for `payout.sweep` to re-drive. Marking it processed strands the sender deterministically:
the processor throws (claim stands, by design), pg-boss retries ~15s later, and that retry loses the
claim to *its own* dead claim — well inside the window, so it reads as `claim_taken`. Retiring it there
drops the row out of the sweep's `status='received'` selection, and nothing else re-drives it
(`payout.poll` enqueues only when `recordEvent` reports `inserted`, i.e. at most once per
`(source,state)`), so the claim never ages into `claim_abandoned` and no alert ever fires. **(4)
The operator exit is a separate named operation, not a `force` flag** — `releaseStaleRefundClaim`,
guarded to only-if-abandoned and only-if-undisbursed, reached by `--reclaim`. It bypasses no policy
(the principal interlock, the `PAYOUT_FAILED` guard, `--operator` and `--confirm` all still run), which
is what keeps it clear of the bypass-parameter shape the entry below rejects. **30 minutes, not 10**,
because no Bridge or processor call sets an `AbortSignal` — they inherit undici's ~300s defaults, so a
hung-but-alive refund can hold a claim ~10 minutes, and an alert that needs a human must not fire on a
call that is merely slow. *(Amended 2026-07-29 — see above: 10 minutes once every Bridge call is
bounded; the derivation's premise no longer holds.)* **Status: active** (slice 7 PR6b-0)
([runbooks/manual-refund.md](runbooks/manual-refund.md)).

**2026-07-27 · One refund implementation, with the policy gate at the caller — and an operator CLI,
not an ops endpoint.** Slice-7 PR6a lifts the `PAYOUT_FAILED → REFUNDED` tail out of the
payment-event job into [`services/refunds.ts`](/apps/api/src/services/refunds.ts), so the automated
path and the human path execute the *same* code. The alternative — a second, by-hand procedure —
is how the two drift: the SQL an operator would otherwise write skips both ledger batches and never
actually returns the money, leaving the books claiming a refund the sender never received.
`AUTO_REFUND` shipped default-off with "a human refunds by runbook" (2026-07-21, below) and
**neither the runbook nor the trigger existed**, so every parked row was unclearable in practice —
and the poller cannot heal them later, because flipping the flag on re-synthesizes an event
`recordEvent` dedupes. Three shape choices worth recording. **(1) The `AUTO_REFUND` check stays at
the call site, never inside the service.** A `force: true` parameter on a money-moving service is an
invitation for the next caller to bypass policy; keeping the gate in the job makes the policy visible
per caller (the job checks the flag; the script does not, because the operator *is* the gate).
**(2) The operator surface is a CLI, not an authenticated HTTP route.** A money-moving prod endpoint
is the admin console the PRD rules out, and the script is strictly safer than the Supabase SQL editor
the runbooks already use because it posts through the ledger RPC. A future support dashboard is
additive — it calls the same service, and the script stays as break-glass. **(3) A
principal-returned interlock, refusing on disagreement.** `bridge_return` books
`DR cash_clearing / CR due_from_bridge` — it *asserts* Bridge sent our cash back — so the script
requires both a recorded terminal `returned`/`refunded` event **and** a live Bridge `GET` confirming
it, and refuses if they disagree. `refund_failed` (principal stuck at Bridge) is refused outright:
fronting from float would book an unreconciled receivable under a ledger rule that does not exist.
The service takes a transfer **id**, not a caller-supplied row, so the amounts and the
never-refund-a-delivered-transfer guard always come from the database. **Status: active** (slice 7
PR6a) ([runbooks/manual-refund.md](runbooks/manual-refund.md)).

**2026-07-27 · Per-user transaction limits (the AML launch limits) ship commit-gated; the dollar
"outstanding-uncleared" cap waits for ACH clearing.** Slice-7 PR5 adds `services/risk.ts` enforcing
the **AML "Transaction Limits at Launch"** policy per user: a per-transaction send cap **($1,500)**
plus rolling-window **send-amount** caps — **day $1,500 / month $3,000 / 6 months $18,000** — with a
belt-and-suspenders **5 sends/day** count (the count is ours, not in the AML doc). Amounts are the
**send principal** in USD minor units — fees excluded, because the policy caps the amount
*transmitted*, not the total charged (so a max $1,500 send sits exactly at the $1,500/day cap). Values
live in env (`RISK_PER_TXN_MAX_MINOR` / `RISK_DAILY_MAX_MINOR` / `RISK_MONTHLY_MAX_MINOR` /
`RISK_SEMIANNUAL_MAX_MINOR` / `RISK_VELOCITY_MAX_COUNT`), **on-by-default** at the policy values so an
unset env still enforces. The source of truth is the AML policy doc (kept out of the repo by
decision), so **code defaults and policy must be reconciled by hand** — the first cut shipped
placeholder numbers precisely because the values weren't in the codebase. Windows are rolling 30/180
days, not calendar. Three shape choices a future engineer will question: **(1) no dollar
outstanding-uncleared cap** — even though the PRD (§10) frames it as the purpose-built control —
because `funding_receivable` is never drained on the happy path (the `ACH CLEARS` batch is
documented-only) and `funding_cleared` posts no ledger entry, so a per-user outstanding sum is
*monotonic* today; it can only be correct once ACH clearing is wired (slice 8 / post-Stripe).
SPEI-seconds-vs-ACH-days makes these send-amount caps — not a concurrency cap — what actually bounds
the R01 double-pay exposure, so a concurrency cap was dropped as redundant. **(2) Counts from COMMIT
(`disclosure_accepted_at`), enforced at confirm before funding is initiated** — counting only *funded*
sends lets the multi-day ACH lag hide a rapid burst (each new send sees "nothing funded yet"); commit
is the first irreversible intent, so it's both the honest counting point and the right pre-money gate.
**(3) Canceled / refunded / payment-failed sends don't count** (but `PAYOUT_FAILED` / `UNDER_REVIEW`
do — the sender was charged and not yet refunded) — since we reject at commit, counting an unwound
mistake would lock an honest re-send out. Enforcement: a UX gate at confirm (`403 limit_exceeded`) +
an authoritative backstop at `FUNDED → SUBMITTED` (the last gate before the irreversible MXN payout)
that places a `velocity_review` ops hold on a trip (a new `payout_hold_reason` — migration
`20260727191425` extends the CHECK) — **not** a self-heal, because a per-user tally
(unlike the aggregate float ceiling) doesn't drain on its own, so self-heal would strand the funded
transfer for up to a full window. Config names track the ERD `user_limits` columns (`per_transfer` /
`daily` / `monthly`) for the slice-8 per-user/tier table + `risk_tier` lift; the **6-month tier has no
ERD column yet** (a slice-8 gap). **Status: active** (slice 7 PR5) ([erd.md](erd.md) `user_limits`,
[prds/remittance-mvp.md](prds/remittance-mvp.md) §10, [transfer-state-machine.md](transfer-state-machine.md),
[glossary.md](glossary.md)).

**2026-07-24 · Transfer history shows only *money-moved* transfers; abandoned sends are hidden, not
deleted.** The sender-facing transaction history (`/dashboard/transfers`, slice-7 PR4) lists only
transfers where payment was actually made — `FUNDED` and beyond — via a new
`GET /v1/transfers?scope=history` filter (`state NOT IN (PENDING_PAYMENT, PAYMENT_FAILED)`);
`scope=all` (the default) still returns everything for ops. A `transfer` row is created at the
"Continue" step (`POST /transfers` → `PENDING_PAYMENT`) *before* the sender pays, and an abandoned one
reconciles to `PAYMENT_FAILED` after 30 min — so listing every row would fill a sender's history with
attempts they never completed (and, while prod is mock-funding-locked, with `PAYMENT_FAILED` for
*every* transfer). Real payment apps don't surface abandoned attempts, so we filter. Crucially this is
a **view filter, not a delete**: the rows + audit log are retained (append-only; abandoned rows carry
zero ledger postings), so nothing about compliance retention changes — only what the sender is shown.
Why a future engineer will ask "why on earth does the list take a `scope` param and hide failed
transfers?" — because history is a product *view*, not the `transfers` table. **Status: active**
(slice 7 PR4) ([api-contract.md](api-contract.md), [glossary.md](glossary.md)).

**2026-07-24 · The receipt view ships ahead of counsel-final receipt wording, rendering server content
verbatim.** Slice-7 PR4 adds a receipt view (`/dashboard/send/:id/receipt`) backed by
`GET /v1/transfers/:id/receipt`. That endpoint's content is currently the *prepayment* copy reused
(`buildReceiptDisclosure` delegates to `buildPrepaymentDisclosure`) — it does not yet carry the
receipt-specific §1005.31(b)(2)(vi) elements (funds-availability date, receipt identification), a
deferred counsel item (PR7, the hard pre-real-money gate). We ship the view now because it is
**content-agnostic**: it renders `content[lang]` verbatim, so counsel's real wording swaps in
server-side with no web change. Safe because the feature is behind the `web-send-money` dark-launch
flag (off in prod) and the pilot is Joshua-only; the web chrome stays neutral ("Transfer receipt" +
date) and invents no legal elements client-side. Why a future engineer will ask "why does the receipt
show prepayment copy?" — because the display surface landed before the counsel wording, and the swap
is server-only. **Status: active** (slice 7 PR4); receipt wording stays on the PR7 gate
([transfer-state-machine.md](transfer-state-machine.md)).

**2026-07-21 · Cancel-at-`FUNDED` is a *void*, not a refund (slice-6 two-verb model).** When a sender
cancels a `FUNDED`-pre-claim transfer, no payout has gone out and no float was fronted, so the inbound
ACH is *voided* (canceled before it settles) and the ledger is a **clean reversal** of the `FUNDED`
batch — not the `refunds_payable`/`cash_clearing` refund-from-float path. Two verbs, keyed to where
the money actually is: **void** (never moved — the cancel path) vs **refund** (moved and returned —
the `PAYOUT_FAILED → REFUNDED` path, which keeps ledger-rules.md's template). The `FundingProcessor`
seam gets both `voidFunding()` and `refund()`; `CANCELED → REFUNDED` carries no ledger. Why a future
engineer will ask "why on earth doesn't cancel post through `refunds_payable` like ledger-rules.md's
CANCELED variant 2?" — because at `FUNDED`-pre-claim nothing has moved. Verify in slice 7: real Stripe
ACH is cancelable inside the 30-min window; if not, add a void→refund fallback. **Status: active**
(slice 6) ([transfer-state-machine.md](transfer-state-machine.md), [ledger-rules.md](ledger-rules.md)).

**2026-07-21 · Human-gate the first real payout-failure refunds (`AUTO_REFUND`, default-safe).**
Slice 6 builds the full auto-refund path for `PAYOUT_FAILED → REFUNDED`, but gates the disbursement
behind a default-safe `AUTO_REFUND` flag — mechanism now, policy via flag, same pattern as
`funding_cleared` and the float ceiling. Off (prod default) → a real payout failure stops at
`PAYOUT_FAILED` + ops alert and a human triggers the refund by runbook; on (dev/test) → the e2e proves
the full path. The trigger is that Bridge's `returned`/`refunded` semantics are **sandbox-unverified**
(the sandbox stalls at `funds_received`) and the refund fronts float. Flip it on once verified in the
slice-7 pilot; the ops-trigger surface is deferred human-shaped work. **Status: active** (slice 6)
([transfer-state-machine.md](transfer-state-machine.md)).

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
