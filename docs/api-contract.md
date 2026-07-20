# API Contract (v1) — USD → MXN Remittance MVP

**Date:** 2026-06-26
**Status:** v1 draft for review
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
| 403 | `limit_exceeded` | User limit or float ceiling hit |
| 404 | `not_found` | Unknown resource |
| 409 | `conflict` | Illegal state transition |
| 409 | `idempotency_conflict` | Idempotency-Key reused with different body |
| 409 | `quote_expired` | Quote past `expires_at` |
| 409 | `transfer_not_cancelable` | Not in `FUNDED` / past cancel window |
| 422 | `provider_rejected` | Upstream provider rejected the request (e.g. bank refused the account) |
| 429 | `rate_limited` | Throttled |
| 500 | `internal_error` | Unexpected failure; details never leak — use `requestId` |
| 502 | `provider_unavailable` | Upstream provider (Bridge/KYC) unreachable |
| 503 | `not_configured` | Endpoint disabled pending configuration (e.g. webhook secret unset) |
| 503 | `rate_unavailable` | Bridge indicative rate unavailable |

## Auth & onboarding

| Method | Path | Auth | Notes |
|---|---|---|---|
| POST | `/v1/auth/otp/request` | public | Body `{ phone }`. Sends Twilio SMS OTP. Requires prior TCPA consent record. |
| POST | `/v1/auth/otp/verify` | public | Body `{ phone, code }`. Wraps Supabase Auth; returns session JWT + whether profile is new. |

## Profile & consent

| Method | Path | Auth | Notes |
|---|---|---|---|
| GET | `/v1/me` | ✓ | Current profile incl. `kyc_status`, `risk_tier`. |
| PATCH | `/v1/me` | ✓ | Update `full_name`, `preferred_locale`. |
| POST | `/v1/consents` | ✓ | Body `{ type, doc_version }` — `tos`\|`privacy`\|`esign`\|`tcpa_sms`. Append-only. |
| GET | `/v1/consents` | ✓ | List grants/revocations. |

## KYC (Sumsub, behind `IdentityVerifier`)

| Method | Path | Auth | Notes |
|---|---|---|---|
| POST | `/v1/kyc/session` | ✓ | Creates Sumsub applicant; returns SDK access token for the client. |
| GET | `/v1/kyc/status` | ✓ | `none`\|`pending`\|`approved`\|`rejected`\|`review`. |

KYC result arrives via the Sumsub webhook (below), not a client call.

## Recipients & payout destinations

| Method | Path | Auth | Notes |
|---|---|---|---|
| POST | `/v1/recipients` | ✓ | Body `{ full_name, relationship, country }`. |
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
| GET | `/v1/transfers` | ✓ | — | List (owner-scoped). |
| GET | `/v1/transfers/:id` | ✓ | — | Status, snapshotted terms, disclosure. |
| POST | `/v1/transfers/:id/cancel` | ✓ | **required** | Only valid in `FUNDED` within the window; server re-checks state under a row lock. Else `transfer_not_cancelable`. |
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
  "disclosure": { "id": "uuid", "type": "prepayment", "locale": "es", "presentedAt": "..." }
}
```
Errors: `quote_expired` (409), `conflict` (409 — quote already used / destination archived since
quoting), `kyc_required` (403), `not_found` (404), `idempotency_conflict` (409),
`not_configured` (503 — funding processor unavailable). `limit_exceeded` arrives with the
slice-8 per-user caps. Rate-limited 10/min/user. The disclosure content (en + es, built from the
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
  "funding": { "provider": "mock", "method": "ach", "clientFields": {} }
}
```
Server refuses with `conflict` (409) if the transfer is past `PENDING_PAYMENT` or already
confirmed, 400 if `disclosureId` doesn't match, and `quote_expired` (409) past the original
quote's `expires_at` — **the firm-offer window applies at confirm** (decided 2026-07-17): the
disclosed rate is never staler than the quote window; re-quote on timeout. A retry after a failed
initiation (acceptance recorded, no funding ref) re-initiates. `clientFields` carries whatever
the active processor's client SDK needs (Stripe: a client_secret; mock: empty); the **funding
webhook** drives `FUNDED`.

## Webhooks  (public, signature-verified, idempotent)

| Method | Path | Drives |
|---|---|---|
| POST | `/v1/webhooks/funding` | `FUNDED` (payment captured/initiated), `PAYMENT_FAILED`, `funding_cleared` flag (ACH settled), `FUNDING_REVERSED` (ack + log only until slice 5/6). From the active `FundingProcessor` — **mock** today (Stripe-shaped HMAC signature), **Stripe** in slice 4b. 503 `not_configured` unless the processor's webhook secret is set — the mock secret is never provisioned in production (the lock). |
| POST | `/v1/webhooks/bridge` | `IN_FLIGHT`, `COMPLETED`, `PAYOUT_FAILED` (slice 5). Today: KYC customer status. |

Slice-4 posture: no worker/queue yet, so the funding webhook transitions **synchronously** via
`transition_transfer` (state + transition row + ledger batch in one DB transaction; 500 on
failure so the provider redelivers into a clean row). Exactly-once comes from the transition
guard + the ledger's `(transfer_id, transition)` uniqueness; `payment_events` dedupe + the async
worker + the 30-min stale-`PENDING_PAYMENT` sweep arrive in slice 5 (a stuck `PENDING_PAYMENT`
row has no postings and no funds moved — a dead row, not lost money).

## Endpoint → state transition map

| Trigger | Transition |
|---|---|
| `POST /transfers` | → `PENDING_PAYMENT` (disclosure generated) |
| `POST /transfers/:id/confirm` | records acceptance → initiates funding (stays `PENDING_PAYMENT`) |
| Funding webhook: payment ok | `PENDING_PAYMENT → FUNDED` |
| Funding webhook: payment fail | `PENDING_PAYMENT → PAYMENT_FAILED` |
| Worker (gate passes) | `FUNDED → SUBMITTED` (Bridge payout call, idempotent) |
| `POST /transfers/:id/cancel` | `FUNDED → CANCELED → REFUNDED` |
| Bridge webhook: accepted | `SUBMITTED → IN_FLIGHT` |
| Bridge webhook: delivered | `IN_FLIGHT → COMPLETED` |
| Bridge webhook: failed | `SUBMITTED/IN_FLIGHT → PAYOUT_FAILED → REFUNDED` |
| Funding webhook: ACH return | `COMPLETED → FUNDING_REVERSED` |
| `POST /transfers/:id/disputes` | `FUNDED`/`SUBMITTED`/`IN_FLIGHT`/`COMPLETED` → `UNDER_REVIEW` (terminal states: dispute recorded, no transition) |

## Cross-cutting (per CLAUDE.md)

- Every route: Fastify input + response schema; `@puente/shared` types.
- Auth middleware default-on; `public: true` only on OTP + webhooks.
- Audit-log entry on every authenticated route touching PII or money.
- Rate limiting on OTP + quote + transfer creation.
- No Twilio/Bridge/funding-processor/KYC secret calls from the client — server-side services only.
