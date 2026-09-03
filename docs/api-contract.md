# API Contract (v1) — USD → MXN Remittance MVP

**Date:** 2026-07-21
**Status:** v1 — slices 1–5 shipped (payout + async layer live); slices 6–8 pending
**Pairs with:** `transfer-state-machine.md`, `ledger-rules.md`, `erd.md`

The Fastify `/v1` surface for the send-money flow. The mobile client talks **only** to this API; the
API alone talks to Bridge, the funding processor, the KYC provider, and Twilio (never the client). Every route has Fastify
input + response schema validation; authenticated routes write an audit-log entry.

## Conventions

- **Base / versioning:** all routes under `/v1`. Breaking changes → `/v2`.
- **Auth:** `Authorization: Bearer <JWT>` (Supabase session). Auth middleware applies by default;
  public routes are explicitly `config: { public: true }` (OTP + webhooks only).
- **Money shape:** every amount is `{ "amountMinor": <int>, "currency": "<ISO-4217>" }`. Integer minor
  units, never floats. USD ledger positions carry `"currency": "USD"`; display-only MXN destination
  amounts carry `"currency": "MXN"` and are never ledger positions.
- **Amount semantics on quotes / transfers:** `totalAmount` = what the sender is debited;
  `sendAmount` = principal delivered to the recipient; `feeAmount` = Puente's fee.
  Invariant: `totalAmount = sendAmount + feeAmount`.
- **Wire casing:** JSON fields are **camelCase** (the shipped slices 1–3 convention, matching
  `@puente/shared` types). DB columns stay snake_case; routes map at the boundary.
- **Idempotency:** the money-moving POSTs — `POST /v1/transfers`, `POST /v1/transfers/:id/confirm`,
  and `POST /v1/transfers/:id/cancel` — require an `Idempotency-Key` header (**not** `/quotes` — a
  duplicate quote is harmless). Keyed per
  endpoint + user, stored ~24h: a replay returns the original result; the same key with a different
  body → `idempotency_conflict`.
- **Errors:** uniform envelope — stable `code` (clients branch on this, never on message text),
  human `message`, a `requestId` for support/tracing, and `details` carrying field-level issues
  on `validation_error`. **Live on every route since the error-envelope PR (2026-07-17).**
  ```json
  { "error": { "code": "validation_error", "message": "Invalid request.",
      "requestId": "req-1a2b3c",
      "details": [ { "path": "body/totalAmount/amountMinor", "issue": "must be >= 1" } ] } }
  ```
  Convention: wrong-**state** conditions (archived resource, illegal transition) are `409 conflict`;
  wrong-**input** is `400 validation_error`.
- **Exchange rate:** `fx_rate` is a **decimal string** with fixed scale (e.g. `"17.3400"`), never a
  float — it feeds money math, so it's computed in decimal/integer arithmetic, never IEEE-754.
- **Lists:** cursor pagination — `?limit=&cursor=`, response `{ data: [...], next_cursor }`.
- **Webhooks:** signature-verified, `public`, idempotent (dedupe on `payment_events`), ack `200` fast,
  process async on the worker.
- **Async state changes:** transfer state advances via webhooks/worker, never a client request.
  Clients learn of changes by polling `GET /v1/transfers/:id`; a push notification fires on terminal
  states (`COMPLETED`, `PAYOUT_FAILED`, `REFUNDED`). Clients never read the database directly.

### Error taxonomy

| HTTP | `code` | When |
|---|---|---|
| 400 | `validation_error` | Schema/shape violation |
| 401 | `unauthorized` | Missing/expired JWT |
| 403 | `forbidden` | Not the owner of the resource |
| 403 | `kyc_required` | Sender KYC not `approved` |
| 403 | `limit_exceeded` | Per-user transaction limit hit (per-transaction / day / month / 6 months / sends per day) |
| 403 | `transfer_in_progress` | Uncleared-exposure cap: the sender already has a committed send awaiting ACH settlement |
| 403 | `funding_unsupported` | Onramp rail (#213): the funding processor can't serve this sender's location/profile (Stripe supportability pre-check at confirm) |
| 404 | `not_found` | Unknown resource |
| 409 | `conflict` | Illegal state transition |
| 409 | `link_auth_required` | Embedded onramp (K5): no stored Link OAuth token / no crypto customer — client restarts Link auth (distinct from `conflict`, which means recollect payment / start the attempt over) |
| 409 | `duplicate_identity` | K6 relay: Bridge already holds a customer with this identity (tax id / email) that is not this user's — terminal for self-serve, support route only, never auto-linked (decision 9) |
| 409 | `idempotency_conflict` | Idempotency-Key reused with different body |
| 409 | `quote_expired` | Quote past `expires_at` |
| 409 | `transfer_not_cancelable` | Not in `FUNDED`, or already claimed for payout submission |
| 409 | `refund_owed` | Ops deny refused: the request met both §1005.34 conditions — a refund is owed; no tool may deny it |
| 409 | `claim_abandoned` | Ops resolve refused: a prior refund run abandoned its claim — manual-refund runbook, never retry |
| 409 | `deposit_evidence_conflict` | Ops deny refused: cited `depositedAt` provably wrong; `details[]` carries the legal bounds |
| 422 | `provider_rejected` | Upstream provider rejected the request (e.g. bank refused the account) |
| 429 | `rate_limited` | Throttled |
| 500 | `internal_error` | Unexpected failure; details never leak — use `requestId` |
| 502 | `provider_unavailable` | Upstream provider (Bridge/KYC) unreachable |
| 503 | `not_configured` | Endpoint disabled pending configuration (e.g. webhook secret unset) |
| 503 | `rate_unavailable` | Bridge indicative rate unavailable |

## Auth & onboarding

| Method | Path | Auth | Notes |
|---|---|---|---|
| POST | `/v1/auth/otp/send` | public | Body `{ phone, smsConsent }`. `smsConsent` is schema-pinned to `const: true` — TCPA consent is collected on the same submit that sends the SMS, not looked up from a prior record. Sends Twilio SMS OTP. |
| POST | `/v1/auth/otp/verify` | public | Body `{ phone, token }`. Wraps Supabase Auth. Returns `{ accessToken, refreshToken, expiresIn, userId }` — **not** a "profile is new" flag; callers route on `GET /v1/users/me` instead (`apps/web/app/continue/page.tsx`, `apps/mobile/lib/auth/routeAfterSignIn.ts`). Also self-heals a missing `users` row, stamps `sms_consent_at`, and writes a `sign_in_events` record. **Per-phone brute-force bound (K7a):** admitted and counted before GoTrue is asked; past the window/day caps (`OTP_VERIFY_*`) → `429 rate_limited` + `Retry-After`, same shape as the send leg. |
| POST | `/v1/auth/refresh` | public | Body `{ refreshToken }`. Same response shape as verify. Supabase rotates refresh tokens single-use — the rotated token must be persisted or the session dies at the next expiry. |
| GET | `/v1/kyc/tos-return` | public | Mobile KYC return leg. Query `{ state, signed_agreement_id }`, both pattern-constrained; answers `302` to `puente://kyc/tos-return` with the same two params. Exists because iOS does not surface a custom scheme reached by a page's own `location.href` to `ASWebAuthenticationSession` (which is how Bridge ends its ToS flow), but does intercept a `302`. Reads and writes nothing; the nonce check in the app is the security boundary. Needs `PUBLIC_API_URL`. |

## Profile & consent

| Method | Path | Auth | Notes |
|---|---|---|---|
| GET | `/v1/users/me` | ✓ | Current profile: `firstName`, `lastName`, `email`, `phone` (login identity, E.164 — K5 Link-registration prefill), `kycStatus`, `bridgeCustomerId`, address fields (K2), `profileComplete` (name+email+address — the router's profile gate), `consentsCurrent` (K1 — GET only; the web `/continue` router gates on both), `bridgeTosAccepted` (K6 — GET only; true once a `bridge_tos` row at `BRIDGE_TOS_VERSION` exists; the pay step skips the Bridge ToS click-through on this or on `bridgeCustomerId`). |
| PATCH | `/v1/users/me` | ✓ | Update `firstName`, `lastName`, `email` (all required) + optional address group `addressLine1/2`, `addressCity`, `addressState`, `addressPostalCode` (K2 — all-or-none when present, `line2` optional; state validated against shared `US_STATES`; absent group never nulls a stored address, so the frozen mobile app's name-only PATCH is unaffected). |
| GET | `/v1/config/web` | ✓ | K6. `{ stripePublishableKey: string \| null }` — the publishable key for surfaces that have no transfer to fetch a funding session for (the profile page's AddressElement). Server-side var, never `NEXT_PUBLIC_`; null when unset (the page degrades to plain inputs, so this never 503s). |
| GET | `/v1/users/me/consents` | ✓ | `{ required, granted, missing }` against `REQUIRED_CONSENTS` (packages/shared). |
| POST | `/v1/users/me/consents` | ✓ | Body `{ consents: [{type, version}], locale }`. Only pairs the server **currently requires** are accepted (stale client → 400 `validation_error`); `bridge_tos` is refused here (first-send paths write it server-side with `signed_agreement_id` evidence). Idempotent: re-grant of an existing (user, type, version) is a no-op that keeps the original evidence. |
| POST | `/v1/users/me/bridge-customer` | ✓ | **K6 — the KYC relay; the only route whose body carries identity numbers.** Body `{ dob: 'YYYY-MM-DD', taxId: { type: 'ssn'\|'itin', number } }` (`additionalProperties:false`; `schema-pii.test.ts` pins this as the single such schema). Ladder: 404 → 403 `forbidden` (profile incomplete) → **200 no-op** `{ bridgeCustomerId, status }` if a customer exists (Bridge never called twice) → 403 `kyc_required` unless `stripe_kyc_tier ∈ {L1,L2}` → 409 `conflict` `details[{path:'bridge_tos'}]` without an unconsumed agreement id → create at Bridge (identity + `base`,`spei` endorsements; per-user+body-hash Idempotency-Key) → guarded persist of `bridge_customer_id` (+ clears the agreement pointer) → `kyc_verifications` row. Errors: 409 `duplicate_identity` (support only), 409 `conflict` `details[{path:'signed_agreement_id'}]` (consumed — pointer cleared, ToS re-runs), 422 `provider_rejected` (one correction), 502 `provider_unavailable`. Rate-limited 5 / 15 min per user. Never echoes inputs; handler never logs or rethrows with the body. |
| POST | `/v1/users/me/bridge-tos` | ✓ | K6. Body `{ signed_agreement_id, locale? }` (id pattern-pinned like the kyc-link leg). The web return leg of Bridge's standalone ToS click-through: writes the append-only `consents` row (`bridge_tos` @ `BRIDGE_TOS_VERSION`, evidence = ip, user-agent, `signed_agreement_id`; re-acceptance keeps the first row) AND `users.bridge_signed_agreement_id`, the mutable pointer to the LATEST id that the relay presents to Bridge and clears on use. Returns `{ bridgeTosAccepted: true }`. |

**Consents** (K1, 2026-08-27): the append-only `consents` table is live — one row per
(user, type, version), immutability-triggered like `disclosures`, evidence jsonb (ip,
user-agent), locale recorded. Required versions are code (`REQUIRED_CONSENTS`); bumping a
version there forces app-wide re-consent via the `/continue` router. This supersedes the
earlier "deferred until a consent needs versioning" note — the KYC rehaul's consent page
(E-SIGN scope expanded to all e-records + Puente TOS/Privacy) is that need.

## Crypto onramp — embedded components (K3, KYC rehaul)

Server surface for Link OAuth + Stripe crypto status. **Dark until Doppler carries the OAuth
pair** — every route 503s `not_configured` without it. Built for the K5 send flow. Endpoint
shapes: Stripe's public embedded-components guide (fetched 2026-08-27), except
`transaction_limits` (SA-doc only, smoke-validated). `scripts/smoke-stripe-crypto.ts`
classifies the provisioning state (creds missing / flags unprovisioned / ready).

| Method | Path | Auth | Notes |
|---|---|---|---|
| POST | `/v1/crypto/link-auth-intent` | ✓ | Creates or REUSES the user's LinkAuthIntent (web reuse rule — a fresh intent per page load forces re-OTP). Email read from the user's own row, never the request. `linkAccountExists: false` = the SDK must register the user first. |
| POST | `/v1/crypto/link-auth-intent/exchange` | ✓ | Exchanges the STORED intent for tokens; banks the refresh token AES-256-GCM-encrypted (AAD = user id). Refuses any lai_ not minted for this user (identity-grafting guard). Access tokens never surface. |
| POST | `/v1/crypto/customer` | ✓ | Persists the crc_ id from the SDK's authenticate callback — verify-then-persist: retrieved under the user's own OAuth token before it lands on their row. |
| GET | `/v1/crypto/kyc-status` | ✓ | Customers poll; caches tier on `users` (display/routing hints — never authorization). 409 `link_auth_required` = re-authenticate with Link (K5 — distinct from `conflict`). |
| GET | `/v1/crypto/quote?amount=` | ✓ | Headless onramp quote for the fixed USDC-on-Base corridor (native fee display, decision 7). |
| GET | `/v1/crypto/limits` | ✓ | `transaction_limits` pass-through; response schema deliberately unpinned until smoke proves the shape. |
| POST | `/v1/crypto/transfers/:id/onramp-session` | ✓ | K4 pay-step: creates the headless onramp session for a confirmed PENDING_PAYMENT transfer — amount pinned from the transfer row, delivery hard-wired to the treasury address, `metadata[transfer_id]` as the webhook join key. Body `{ paymentTokenId: cpt_… }` (from the SDK). **New session per attempt, never resume**: replaces a prior session only while it provably hasn't moved money (`fulfillment_*` → 409). KYC step-ups → 400 `kyc_required` with the exact Stripe code in `details`; geo refusals → 403 `funding_unsupported`. Live only under `FUNDING_PROCESSOR=stripe_crypto`. |
| POST | `/v1/crypto/transfers/:id/onramp-checkout` | ✓ | Executes checkout for the CURRENT session (a replaced/stale session id → 409). Called ONLY from inside the SDK's `performCheckout` callback. Body `{ sessionId, paymentMethodType }`; ACH carries the online mandate evidence (accepting browser's ip + user agent). Returns `{ clientSecret }` — never persisted, never logged. |

**Confirm under `stripe_crypto` (deferred initiation):** `POST /transfers/:id/confirm` records
acceptance and returns `funding: { provider, method: 'onramp' }` WITHOUT
creating a session or writing `funding_payment_ref` — the SDK must mint a payment token first,
so the session is created by the pay-step route above, which is also what first writes the ref.
Acceptance alone is confirmed-ness (re-confirm → 409). Webhook side is UNCHANGED from the
widget rail: same `crypto.onramp_session.updated` event, same status map, same delivered-amount
guard before FUNDED.

## KYC (Bridge-hosted — the FALLBACK since K6)

Under `web-kyc-at-first-send` the sender verifies with **Stripe in our UI** at first send (K5,
`/v1/crypto/*`) and the Bridge customer is created by the **relay** (`POST /v1/users/me/bridge-customer`,
above) — Bridge runs its own database checks from the relayed identity. The Bridge-**hosted** flow
below (Persona under the hood) is now the fallback for database-lookup failures (K6 decisions 5–6)
and the legacy flag-OFF onboarding path. There is still **no `/v1/kyc/*` surface** — the API mints
Bridge links from these routes and reads state back off `users.kyc_status` (history in
`kyc_verifications`).

| Method | Path | Auth | Notes |
|---|---|---|---|
| POST | `/v1/users/me/tos-link` | ✓ | Mints a server-scoped Bridge **ToS acceptance** link (`{ url }`); the sender accepts Bridge's terms before verification. |
| POST | `/v1/users/me/kyc-link` | ✓ | Returns the **Bridge-hosted KYC link** (`{ url }`) for a `signed_agreement_id`; requests the `spei` (MXN payout) endorsement and creates the Bridge customer on first call. Requires `first_name`/`last_name`/`email` on the profile. |
| POST | `/v1/users/me/kyc-link/retry` | ✓ | Re-issues the KYC link after a rejection (retry-counted). |
| GET | `/v1/users/me/kyc-rejection` | ✓ | Rejection detail for a `rejected` sender. |

`kyc_status` (`not_started`\|`pending`\|`approved`\|`rejected`\|`manual_review`) is read via
`GET /v1/users/me`; the gate raises `kyc_required` (403) until it is `approved`. The result
**arrives via the Bridge webhook `customer.*` branch** (`customer.created`/`updated`/
`status_transitioned` → `users.kyc_status`; see Webhooks), never a client call.

**Gate rework (K4, KYC rehaul):** the shared gate is now `requireOnboardedUser`
(recipients.ts). Under legacy rails it still means `kyc_status = 'approved'`; under
`FUNDING_PROCESSOR=stripe_crypto` (deferred initiation) it means **profile complete + consents
current** — identity verification moved inside the send flow (Stripe refuses sessions until
verified), so a kyc_status gate would deadlock new-flow users out of the flow that IS their KYC.

**Deferred (not built):** the `/v1/kyc/*` endpoints, the Sumsub webhook, and the ERD's `kyc_records`
table — Sumsub was superseded by Bridge-hosted KYC for the MVP. `IdentityVerifier` is retained only
as the swap-seam if a second KYC provider is ever added.

## Recipients & payout destinations

| Method | Path | Auth | Notes |
|---|---|---|---|
| POST | `/v1/recipients` | ✓ | Body `{ firstName, lastName, relationship, country }`. |
| GET | `/v1/recipients` | ✓ | List (owner-scoped). |
| GET | `/v1/recipients/:id` | ✓ | One. |
| PATCH | `/v1/recipients/:id` | ✓ | Update / `archive`. |
| POST | `/v1/recipients/:id/destinations` | ✓ | Body `{ method, currency, details, label }`. `details` validated per (country, method); sensitive fields encrypted server-side. |
| GET | `/v1/recipients/:id/destinations` | ✓ | List destinations. |
| PATCH | `/v1/destinations/:id` | ✓ | Update / `archive`. |

## Quotes  (Puente's firm offer)

| Method | Path | Auth | Notes |
|---|---|---|---|
| POST | `/v1/quotes` | ✓ | Create a firm, time-boxed offer. |
| GET | `/v1/quotes/:id` | ✓ | Fetch (incl. `expires_at`, `status`). |

**`POST /v1/quotes`** *(as shipped — slice 3)*
```jsonc
// request — totalAmount is the full amount the sender will be debited
{ "payoutDestinationId": "uuid", "totalAmount": { "amountMinor": 20000, "currency": "USD" } }
// response 201 — worked example at the config defaults (1% fee, 50 bps buffer, buy_rate 20.100251)
{
  "id": "uuid",
  "payoutDestinationId": "uuid",
  "totalAmount":   { "amountMinor": 20000,  "currency": "USD" },  // = sendAmount + feeAmount, exactly
  "sendAmount":    { "amountMinor": 19801,  "currency": "USD" },  // principal delivered to recipient
  "feeAmount":     { "amountMinor": 199,    "currency": "USD" },  // Puente's fee (residual: flat + bps, sub-cent rounds up)
  "receiveAmount": { "amountMinor": 396014, "currency": "MXN" },  // display/Reg E only
  "fxRate": "19.9997",         // decimal string, fixed 4 dp; customer-facing (buy_rate minus buffer)
  "expiresAt": "2026-07-17T14:15:00Z",
  "status": "active",          // active | expired | consumed; expiry is derived on read
  "createdAt": "2026-07-17T14:00:00Z"
}
```
403 (`kyc_required`) if sender not approved. 503 (`rate_unavailable`) if the Bridge indicative
rate can't be fetched or fails validation. 409 (`conflict`) for archived destinations/recipients;
400 (`validation_error`) for wrong-corridor destinations and amounts too small to price. POST is rate-limited (10/min/user) on top of the global limiter.
No `Idempotency-Key` — a duplicate quote is harmless. `sourceRate`/`fxRateAt` are stored for
reconciliation but never cross the wire.

## Transfers  (the state machine)

| Method | Path | Auth | Idempotent | Notes |
|---|---|---|---|---|
| POST | `/v1/transfers` | ✓ | **required** | Create transfer from a quote (`PENDING_PAYMENT`) + generate Reg E **prepayment disclosure**. No funding set up yet. |
| POST | `/v1/transfers/:id/confirm` | ✓ | **required** | Record disclosure acceptance → initiate funding via `FundingProcessor`. Server refuses without recorded acceptance. Returns processor-neutral funding details. |
| GET | `/v1/transfers` | ✓ | — | List (owner-scoped). `?scope=history` hides abandoned (never-funded) sends — `PENDING_PAYMENT`/`PAYMENT_FAILED`; `?scope=all` (default) returns everything. |
| GET | `/v1/transfers/:id` | ✓ | — | Status, snapshotted terms, disclosure. |
| GET | `/v1/transfers/:id/funding-session` | ✓ | — | Pay-step bootstrap (S3): `{ provider, clientSecret?, publishableKey? }`. `PENDING_PAYMENT` only. |
| POST | `/v1/transfers/:id/cancel` | ✓ | **required** | Pre-claim `FUNDED` → cancels. `SUBMITTED`/`IN_FLIGHT`/`FUNDED`-post-claim → **202**, request recorded (below). Else `transfer_not_cancelable`. |

**202 `cancellation_requires_support`** — the payout is already with Bridge, so the cancel is
*recorded* and resolved when the payout settles (slice-7 PR6b). The wire shape is unchanged from
slice 6 apart from `requestedAt`; the shipped web client branches on `code`, so that string is stable.

```jsonc
{
  "id": "uuid",
  "state": "SUBMITTED",
  "code": "cancellation_requires_support",
  "requestedAt": "2026-07-28T12:00:00Z",  // when the ask was recorded — the statutory clock.
                                          // ABSENT (not null) if recording failed: we do not
                                          // assert a clock we did not start.
  "messages": { "en": "…", "es": "…" }    // server-authored, rendered verbatim
}
```

Recording is best-effort **in one direction only**: a persistence failure logs, pages ops, and still
returns the 202 — our bookkeeping problem must not present to the sender as a rejection of a
statutory ask. It is the only sanctioned swallow on this path. Note the idempotency interaction:
the plugin caches any 2xx for 24h, so a record-failure 202 (no `requestedAt`) is what a same-key
retry replays — **the client's own retry can never re-attempt the record**. Recovery is the
`cancellation-record-failed` page plus manual entry per the runbook, or a fresh key from a new tap;
do not assume "the client will just retry" heals it.
| GET | `/v1/transfers/:id/receipt` | ✓ | — | Reg E receipt. |
| POST | `/v1/transfers/:id/disputes` | ✓ | — | Open error resolution. Body `{ type, description }`. Moves the transfer to `UNDER_REVIEW` only from `FUNDED`/`SUBMITTED`/`IN_FLIGHT`/`COMPLETED` (per state machine); a dispute on an already-terminal transfer (`REFUNDED`, `PAYMENT_FAILED`, …) is recorded in `disputes` without a state change. |
| GET | `/v1/transfers/:id/disputes` | ✓ | — | List. |

**`POST /v1/transfers`** — create + disclose (no funding yet). *(Shipped 2026-07-17, slice 4.)*
```jsonc
// request   (header: Idempotency-Key required)
{ "quoteId": "uuid" }
// response 201 — real slice-4 numbers: $200.00 total at buy 20.100251 − 50 bps
{
  "id": "uuid",
  "quoteId": "uuid",
  "payoutDestinationId": "uuid",
  "state": "PENDING_PAYMENT",
  "totalAmount":   { "amountMinor": 20000, "currency": "USD" },  // = sendAmount + feeAmount
  "sendAmount":    { "amountMinor": 19801, "currency": "USD" },  // principal to recipient
  "feeAmount":     { "amountMinor": 199, "currency": "USD" },
  "receiveAmount": { "amountMinor": 396014, "currency": "MXN" },
  "fxRate": "19.9997",
  "fundingSourceType": "ach",
  "fundingCleared": false,
  "paymentAt": null,            // set at FUNDED (funding captured/initiated)
  "cancelableUntil": null,      // set at FUNDED; close of the 30-min cancel window
  "cancellationRequestedAt": null, // set when a post-submission cancel is RECORDED (slice-7 PR6b);
                                //   a flag orthogonal to state — the payout keeps advancing
  "providerTransferRef": null,  // the Bridge transfer id, set at SUBMITTED
  "completedAt": null,          // set when Bridge confirms the SPEI deposit
  "disclosure": { "id": "uuid", "type": "prepayment", "locale": "es", "presentedAt": "..." }
}
```
Errors: `quote_expired` (409), `conflict` (409 — quote already used / destination archived since
quoting), `kyc_required` (403), `not_found` (404), `idempotency_conflict` (409),
`not_configured` (503 — funding processor unavailable), `limit_exceeded` (403 — a per-user
transaction limit would be breached; see `services/risk.ts`), `transfer_in_progress` (403 — the
uncleared-exposure cap: a committed send is still awaiting settlement; also emitted by
`POST /v1/quotes` as the earliest friendly gate). Rate-limited 10/min/user. The disclosure content (en + es, built from the
quote snapshot, incl. cancellation right and the §1005.33(h) wrong-account warning) is stored
append-only on `disclosures`; the response carries the summary.

**`POST /v1/transfers/:id/confirm`** — accept disclosure + initiate funding
```jsonc
// request   (header: Idempotency-Key required)
{ "disclosureId": "uuid", "accepted": true }   // accepted is literally `true`; declining = not confirming
// response 200
{
  "id": "uuid",
  "state": "PENDING_PAYMENT",
  "disclosureAcceptedAt": "2026-07-17T19:40:00Z",
  "funding": { "provider": "mock", "method": "ach" }
}
```
Server refuses with `conflict` (409) if the transfer is past `PENDING_PAYMENT` or already
confirmed, 400 if `disclosureId` doesn't match, and `quote_expired` (409) past the original
quote's `expires_at` — **the firm-offer window applies at confirm** (decided 2026-07-17): the
disclosed rate is never staler than the quote window; re-quote on timeout. A retry after a failed
initiation (acceptance recorded, no funding ref) re-initiates. Confirm returns **no processor
secrets** (#243): the pay step bootstraps from `GET /transfers/:id/funding-session`, which serves the
client_secret live and on demand; the **funding webhook** drives `FUNDED`. Under the manual rail, a successful confirm also enqueues
`funding.onramp_prepare` (funding-ops slice 3): the worker creates the Bridge onramp and
attaches deposit instructions with system attribution — confirm never fails on Bridge or the
queue being down (the ops attach button is the break-glass).

**`GET /v1/transfers/:id/funding-session`** — pay-step bootstrap *(S3; deferred-rail bootstrap K5)*
```jsonc
// response 200 — stripe processor
{ "provider": "stripe", "clientSecret": "pi_…_secret_…", "publishableKey": "pk_test_…" }
// response 200 — mock processor (web falls back to the simulate affordance)
{ "provider": "mock" }
// response 200 — stripe_crypto with no session yet (the NORMAL deferred state):
// the SDK bootstrap — the publishable key is deliberately not a NEXT_PUBLIC_ env
{ "provider": "stripe_crypto", "publishableKey": "pk_test_…" }
```
Owner-scoped. The tracker calls this once per pay-step mount (never on the poll) so a reload at
`PENDING_PAYMENT` can re-mount the Payment Element: the `clientSecret` is retrieved from the
processor **on demand and never persisted or logged** on our side — Stripe stays the only store of
the credential. Errors: `not_found` (404 — missing or not yours; never leaks existence), `conflict`
(409 — the transfer left `PENDING_PAYMENT`, or — eager rails only — funding was never initiated:
that confirm-crashed window is recovered by confirm's own idempotent retry, not this route; on the
deferred rail a null ref serves the bootstrap instead, and a failing live-session read also degrades
to the bootstrap since sessions are never resumed), `not_configured` (503 —
same posture as confirm; in prod-mock this endpoint cannot serve). Deliberately **no KYC gate and
no uncleared-cap check** — a read-only bootstrap for an already-committed send must not strand a
sender mid-window on a KYC flip (same rationale as cancel's shortened guard ladder).

## Webhooks  (public, signature-verified, idempotent)

| Method | Path | Drives |
|---|---|---|
| POST | `/v1/webhooks/funding` | `FUNDED` (payment captured/initiated), `PAYMENT_FAILED`, `funding_cleared` flag (ACH settled), `FUNDING_REVERSED` (ack + log only until slice 5/6). From the active `FundingProcessor` — **mock** today (Stripe-shaped HMAC signature), **Stripe** in slice 4b. 503 `not_configured` unless the processor's webhook secret is set — the mock secret is never provisioned in production (the lock). |
| POST | `/v1/webhooks/bridge` | `IN_FLIGHT`, `COMPLETED`, `PAYOUT_FAILED` (slice 5). `transfer.*` events are recorded into `payment_events` (dedupe on `(source, external_event_id)`) and enqueued to `payment-event.process`, which drives those transitions async. KYC customer status (`customer.created`/`updated`/`status_transitioned`) and the `customer.deleted` unlink are one branch among several. |

Slice-4 posture: no worker/queue yet, so the funding webhook transitions **synchronously** via
`transition_transfer` (state + transition row + ledger batch in one DB transaction; 500 on
failure so the provider redelivers into a clean row). Exactly-once comes from the transition
guard + the ledger's `(transfer_id, transition)` uniqueness; `payment_events` dedupe + the async
worker + the 30-min stale-`PENDING_PAYMENT` sweep arrive in slice 5 (a stuck `PENDING_PAYMENT`
row has no postings and no funds moved — a dead row, not lost money).

## Ops (admin overview + resolve-cancellation — slices 8.5-v1/v1.1)

| Method | Path | Auth | Idempotent | Notes |
|---|---|---|---|---|
| GET | `/v1/ops/overview` | bearer + `OPS_ADMIN_USER_IDS` allowlist | read-only | Non-admins get **404 `not_found`** with a body identical to a missing route — never 403. Route is not even registered when the allowlist is unset (fail closed). |
| POST | `/v1/ops/cancellations/resolve` | bearer + allowlist + `OPS_WRITE_ENABLED` (double control) | `Idempotency-Key` required | Same 404 posture, both layers: not registered unless BOTH env controls are set, handler re-checks both + membership first. Wraps the SAME services as `resolve-cancellation.ts` (the CLI stays break-glass). |
| POST | `/v1/ops/transfers/funding` | double control | `Idempotency-Key` required | Out-of-band funding assertion (#190): `kind: funded` releases the payout (`PENDING_PAYMENT → FUNDED`), `kind: cleared` settles the receivable when the deposit lands. Body: `{ transferId, kind, externalRef, amountMinor, currency }` — amount checked to the cent (409 `conflict` on mismatch). CLI `record-manual-funding.ts` is break-glass. |
| POST | `/v1/ops/transfers/deposit-instructions` | double control | naturally idempotent (no key) | Attach (#203, for #199): pulls the deposit coordinates off a Bridge onramp and upserts them onto the transfer. Body: `{ transferId, bridgeTransferId }`. Re-attach overwrites. Since funding-ops slice 3 attach is **automatic at confirm** (the `funding.onramp_prepare` job, `attached_by` null = system) — this route and CLI `attach-deposit-instructions.ts` are the break-glass for the job's dead ends (Sentry `onramp-prepare-*`). |
| POST | `/v1/ops/transfers/deposit-landed` | double control | naturally idempotent (no key) | Slice 1, funding-ops-automation: one action, both books — `recordManualFunding(kind: cleared)` then `recordFloatTopUp`, idempotent on the shared onramp ref (cleared replays as `cleared_skipped`; ledger key `float_topup:<ref>`). Ordering invariant: cleared FIRST, and the top-up runs on `cleared_skipped` too, so a re-tap after a mid-action crash heals. When instructions are attached, `externalRef` MUST match `deposit_instructions.bridge_transfer_ref` (409 `conflict` otherwise) — the ledger key is global, so a cross-transfer ref typo would silently consume another transfer's top-up. Body: `{ transferId, externalRef, amountMinor, currency }` → 200 `{ transferId, outcome: cleared \| cleared_skipped }`. |
| POST | `/v1/ops/treasury/float-topup` | double control | `Idempotency-Key` required | Slice 2, funding-ops-automation: ad-hoc treasury top-up (`DR bridge_wallet_float / CR cash_clearing` via `recordFloatTopUp`; CLI `record-float-topup.ts` is break-glass). Body `{ amountMinor, currency: 'USD', externalRef? }` — blank/absent ref derives `adhoc:<Idempotency-Key>` so the HTTP and ledger layers agree on booking identity (held key → replay; same ref → ledger no-op; fresh key + blank ref → new booking). → 200 `{ amountMinor, externalRef, floatBalanceMinor }` (balance after the post; replays echo the original). No transferId — a transfer's own deposit goes through `deposit-landed`, not here. |

One aggregate for the ops page (`/dashboard/ops`, no nav entry — direct URL).
**The response schema is the output allowlist**: every field is enumerated; recon check
`summary` objects are deliberately excluded from this wire (name/status/findingsCount/error
only — detail lives in `reconciliation_runs` and Sentry). PII discipline: ids, amounts,
timestamps, states, hold reasons, booleans; never names, destinations, or user ids.

```jsonc
// GET /v1/ops/overview → 200
{
  "generatedAt": "2026-08-01T12:00:00.000Z",
  "actionsEnabled": true,          // v1.1: the write capability is live on this deployment — web renders buttons only when true
  "pendingCancellations": [        // status='pending' cancellation_requests (bounded 1000, loud throw at cap)
    { "transferId": "…", "state": "UNDER_REVIEW", "sendAmountMinor": 50000,
      "feeAmountMinor": 550, "requestedAt": "…", "withinWindow": false,
      "refundPaymentRef": null }   // non-null ⇒ a refund is already in motion
  ],
  "openTransfers": [               // every PENDING_PAYMENT|FUNDED|SUBMITTED|IN_FLIGHT|UNDER_REVIEW row (bounded 1000)
    { "transferId": "…", "state": "FUNDED", "sendAmountMinor": 30000,
      "feeAmountMinor": 500,       // slice 1: buttons must state the total to the cent
      "enteredStateAt": "…",       // coarse stamp anchor — may predate the current stay on a state round trip
      "dwellMinutes": 83, "thresholdMinutes": 15,  // PENDING_PAYMENT thresholds on MANUAL_PENDING_MAX_AGE_DAYS (the sweep's clock), not a pager knob
      "overThreshold": true,       // page marker only; the stuck-watch Sentry pager owns verdicts
      "holdReason": null,          // fx_drift | payability | submit_error | velocity_review | null
      "fundingCleared": false, "submitAttempted": false, "cancellationRequested": false,
      "fundingInitiated": true,    // slice 1: funding_payment_ref set — actions render only on confirmed rows
      "onrampRef": null }          // slice 1: Bridge onramp id from deposit_instructions (prefills deposit-landed); null = nothing attached
  ],
  "floatCeiling": {                // live funding_receivable vs FLOAT_CEILING_MINOR
    "configured": true,            // false when the env knob is unset in the API process (not an error)
    "tripped": false, "balanceMinor": 123400, "ceilingMinor": 500000 },
  "transferCounts": [              // ops_transfer_state_counts() — SQL GROUP BY, all states, any scale
    { "state": "COMPLETED", "count": 87 } ],
  "ledgerBalances": {              // the LATEST reconciliation run's snapshot (staleness explicit); null before the first run
    "asOf": "2026-08-01T06:00:04Z",
    "balances": [ { "code": "funding_receivable", "amountMinor": 123400, "currency": "USD" } ] },
  "reconciliationRuns": [          // latest 7, newest first — the reconciliation runbook's own read
    { "createdAt": "…", "status": "findings", "findingsCount": 2,
      "checks": [ { "name": "bridge_wallet_float", "status": "findings", "findingsCount": 2 } ] } ],
  "workerHeartbeats": [            // one row per logical worker service; [] before the first beat
    { "worker": "worker", "beatAt": "2026-08-01T11:58:00Z",
      "ageSeconds": 120,           // age at generatedAt
      "stale": false } ]           // no beat in 15 min — same threshold as the Sentry cron monitor
}
```

### POST /v1/ops/cancellations/resolve (slice 8.5-v1.1)

`transferId` lives in the **body**, not the path: the idempotency identity is route pattern +
body hash, so a path param would hash identically across transfers (the known collision — see
the cancel route note). One endpoint spans both decisions; a key reused with a different body
(other transfer, flipped decision, corrected evidence) is a 409 `idempotency_conflict` — except
after a non-2xx, which releases the claim so a corrected retry may reuse the key.

```jsonc
// POST /v1/ops/cancellations/resolve  (Idempotency-Key required)
{ "transferId": "…", "decision": "refund" }                                   // refund: no depositedAt allowed
{ "transferId": "…", "decision": "deny", "depositedAt": "2026-08-01T15:04:05Z" } // deny: depositedAt REQUIRED
// → 200
{ "transferId": "…", "outcome": "refunded" }  // refunded | denied | already_disbursed | already_refunded
//   already_disbursed / already_refunded = crash-recovery settles: state closed, NO money moved this run
```

**Refusals are non-2xx by design** — the idempotency plugin stores and replays only 2xx, so a
200-refusal would freeze a transient claim state into every retry. Mapping (`ReviewOutcome` →
HTTP): `transfer_not_found` → 404 `not_found`; `not_under_review` / `no_pending_request` /
`claim_taken` → 409 `conflict`; and three codes with their own operator behavior:

| Code | Status | Meaning / required behavior |
|---|---|---|
| `refund_owed` | 409 | The request met BOTH §1005.34 conditions — a refund is owed; no tool may deny it. Refund instead. |
| `claim_abandoned` | 409 | A prior refund run abandoned its claim (may have disbursed without recording). NEVER retry — `runbooks/manual-refund.md`. |
| `deposit_evidence_conflict` | 409 | Cited `depositedAt` is provably wrong; `details[]` carries the legal bounds so the operator corrects the input. |

Actor attribution: the services record `ops:<admin user id>` on the transition and the request
resolution — the durable decision record (the audit plugin only logs the hit).

## Endpoint → state transition map

| Trigger | Transition |
|---|---|
| `POST /transfers` | → `PENDING_PAYMENT` (disclosure generated) |
| `POST /transfers/:id/confirm` | records acceptance → initiates funding (stays `PENDING_PAYMENT`) |
| Funding webhook: payment ok | `PENDING_PAYMENT → FUNDED` |
| Funding webhook: payment fail | `PENDING_PAYMENT → PAYMENT_FAILED` |
| Worker (gate passes) | `FUNDED → SUBMITTED` (Bridge payout call, idempotent) |
| `POST /transfers/:id/cancel` (pre-claim `FUNDED`) | `FUNDED → CANCELED → REFUNDED` |
| `POST /transfers/:id/cancel` (`SUBMITTED`/`IN_FLIGHT`/`FUNDED`-post-claim) | **no transition** — 202, request RECORDED (slice-7 PR6b) |
| Bridge webhook: delivered, in-window request that **beat the deposit** | `COMPLETED → UNDER_REVIEW` (system; no ledger) |
| Bridge webhook: delivered, request in-window but **after the deposit** | **no transition** — stays `COMPLETED`, ops alerted to deny with Bridge's timestamp |
| Bridge webhook: delivered, request out of window | **no transition** — stays `COMPLETED`, ops alerted to deny |
| `POST /ops/cancellations/resolve` `decision:refund` (ops; CLI `resolve-cancellation.ts --refund` is break-glass) | `UNDER_REVIEW → REFUNDED` (correction payment) |
| `POST /ops/cancellations/resolve` `decision:deny` (ops; CLI `--deny` is break-glass) | `UNDER_REVIEW → COMPLETED`, or no transition if never routed |
| Bridge webhook: accepted | `SUBMITTED → IN_FLIGHT` |
| Bridge webhook: delivered | `IN_FLIGHT → COMPLETED` |
| Bridge webhook: failed | `SUBMITTED/IN_FLIGHT → PAYOUT_FAILED → REFUNDED` |
| Funding webhook: ACH return | `COMPLETED → FUNDING_REVERSED` |
| `POST /transfers/:id/disputes` *(not built — deferred)* | `FUNDED`/`SUBMITTED`/`IN_FLIGHT`/`COMPLETED` → `UNDER_REVIEW` (terminal states: dispute recorded, no transition) |

## Cross-cutting (per CLAUDE.md)

- Every route: Fastify input + response schema; `@puente/shared` types.
- Auth middleware default-on; `public: true` only on OTP + webhooks.
- Audit-log entry on every authenticated route touching PII or money.
- Rate limiting on OTP + quote + transfer creation.
- No Twilio/Bridge/funding-processor/KYC secret calls from the client — server-side services only.
