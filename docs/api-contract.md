# API Contract (v1) — USD → MXN Remittance MVP

**Date:** 2026-06-26
**Status:** v1 draft for review
**Pairs with:** `transfer-state-machine.md`, `ledger-rules.md`, `erd.md`

The Fastify `/v1` surface for the send-money flow. The mobile client talks **only** to this API; the
API alone talks to Bridge, Stripe, Sumsub, and Twilio (never the client). Every route has Fastify
input + response schema validation; authenticated routes write an audit-log entry.

## Conventions

- **Base / versioning:** all routes under `/v1`. Breaking changes → `/v2`.
- **Auth:** `Authorization: Bearer <JWT>` (Supabase session). Auth middleware applies by default;
  public routes are explicitly `config: { public: true }` (OTP + webhooks only).
- **Money shape:** every amount is `{ "amountMinor": <int>, "currency": "<ISO-4217>" }`. Integer minor
  units, never floats. USD ledger positions carry `"currency": "USD"`; display-only MXN destination
  amounts carry `"currency": "MXN"` and are never ledger positions.
- **Amount semantics on quotes / transfers:** `total_amount` = what the sender is debited;
  `send_amount` = principal delivered to the recipient; `fee_amount` = Puente's fee.
  Invariant: `total_amount = send_amount + fee_amount`.
- **Idempotency:** unsafe money-moving POSTs require an `Idempotency-Key` header. The server persists
  key → response; a replay returns the original result; the same key with a different body →
  `idempotency_conflict`.
- **Errors:** uniform envelope, stable `code`s (table below):
  ```json
  { "error": { "code": "quote_expired", "message": "Quote has expired.", "details": {} } }
  ```
- **Lists:** cursor pagination — `?limit=&cursor=`, response `{ data: [...], next_cursor }`.
- **Webhooks:** signature-verified, `public`, idempotent (dedupe on `payment_events`), ack `200` fast,
  process async on the worker.

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
| 429 | `rate_limited` | Throttled |
| 503 | `rate_unavailable` | Bridge indicative rate unavailable |

## Auth & onboarding

| Method | Path | Auth | Notes |
|---|---|---|---|
| POST | `/v1/auth/otp/request` | public | Body `{ phone }`. Sends Twilio SMS OTP. Requires prior TCPA consent record. |
| POST | `/v1/auth/otp/verify` | public | Body `{ phone, code }`. Returns session JWT + whether profile is new. |

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

**`POST /v1/quotes`**
```jsonc
// request — total_amount is the full amount the sender will be debited
{ "payout_destination_id": "uuid", "total_amount": { "amountMinor": 20000, "currency": "USD" } }
// response 201
{
  "id": "uuid",
  "total_amount":   { "amountMinor": 20000, "currency": "USD" },  // echoed; = send_amount + fee_amount
  "send_amount":    { "amountMinor": 19800, "currency": "USD" },  // principal delivered to recipient
  "fee_amount":     { "amountMinor": 200,   "currency": "USD" },  // Puente's fee
  "receive_amount": { "amountMinor": 340000, "currency": "MXN" }, // display/Reg E only
  "fx_rate": 17.34,            // customer-facing (source minus buffer)
  "expires_at": "2026-06-26T19:45:00Z",
  "status": "active"
}
```
`kyc_required` if sender not approved. `rate_unavailable` if Bridge indicative rate can't be fetched.

## Transfers  (the state machine)

| Method | Path | Auth | Idempotent | Notes |
|---|---|---|---|---|
| POST | `/v1/transfers` | ✓ | **required** | Confirm a quote → create transfer (`PENDING_PAYMENT`) + Stripe payment intent + Reg E **prepayment disclosure**. |
| GET | `/v1/transfers` | ✓ | — | List (owner-scoped). |
| GET | `/v1/transfers/:id` | ✓ | — | Status, snapshotted terms, disclosure. |
| POST | `/v1/transfers/:id/cancel` | ✓ | yes | Only valid in `FUNDED` within the window; server re-checks state under a row lock. Else `transfer_not_cancelable`. |
| GET | `/v1/transfers/:id/receipt` | ✓ | — | Reg E receipt. |
| POST | `/v1/transfers/:id/disputes` | ✓ | — | Open error resolution (`UNDER_REVIEW`). Body `{ type, description }`. |
| GET | `/v1/transfers/:id/disputes` | ✓ | — | List. |

**`POST /v1/transfers`**
```jsonc
// request   (header: Idempotency-Key: <uuid>)
{ "quote_id": "uuid" }
// response 201
{
  "id": "uuid",
  "state": "PENDING_PAYMENT",
  "total_amount":  { "amountMinor": 20000, "currency": "USD" },  // = send_amount + fee_amount
  "send_amount":   { "amountMinor": 19800, "currency": "USD" },  // principal to recipient
  "fee_amount":    { "amountMinor": 200, "currency": "USD" },
  "receive_amount": { "amountMinor": 340000, "currency": "MXN" },
  "payment": { "provider": "stripe", "client_secret": "pi_..._secret_..." },
  "disclosure": { "type": "prepayment", "locale": "es", "presented_at": "..." },
  "cancelable_until": "2026-06-26T20:15:00Z"
}
```
Errors: `quote_expired`, `kyc_required`, `limit_exceeded` (user limit / float ceiling), `idempotency_conflict`.
The client completes payment via the Stripe SDK using `client_secret`; the **Stripe webhook** drives `FUNDED`.

## Webhooks  (public, signature-verified, idempotent)

| Method | Path | Drives |
|---|---|---|
| POST | `/v1/webhooks/stripe` | `FUNDED` (payment captured/initiated), `PAYMENT_FAILED`, `funding_cleared` (ACH settled), `FUNDING_REVERSED` (ACH return / chargeback). |
| POST | `/v1/webhooks/bridge` | `IN_FLIGHT`, `COMPLETED`, `PAYOUT_FAILED`. |
| POST | `/v1/webhooks/sumsub` | KYC result → updates `kyc_records` + `profile.kyc_status`. |

Each: verify signature → write `payment_events` (dedupe on `(source, external_event_id)`) → return
`200` → enqueue worker job → job posts the ledger transaction + writes a `transfer_transition`.

## Endpoint → state transition map

| Trigger | Transition |
|---|---|
| `POST /transfers` | → `PENDING_PAYMENT` |
| Stripe webhook: payment ok | `PENDING_PAYMENT → FUNDED` |
| Stripe webhook: payment fail | `PENDING_PAYMENT → PAYMENT_FAILED` |
| Worker (gate passes) | `FUNDED → SUBMITTED` (Bridge payout call, idempotent) |
| `POST /transfers/:id/cancel` | `FUNDED → CANCELED → REFUNDED` |
| Bridge webhook: accepted | `SUBMITTED → IN_FLIGHT` |
| Bridge webhook: delivered | `IN_FLIGHT → COMPLETED` |
| Bridge webhook: failed | `SUBMITTED/IN_FLIGHT → PAYOUT_FAILED → REFUNDED` |
| Stripe webhook: ACH return | `COMPLETED → FUNDING_REVERSED` |
| `POST /transfers/:id/disputes` | any → `UNDER_REVIEW` |

## Cross-cutting (per CLAUDE.md)

- Every route: Fastify input + response schema; `@puente/shared` types.
- Auth middleware default-on; `public: true` only on OTP + webhooks.
- Audit-log entry on every authenticated route touching PII or money.
- Rate limiting on OTP + quote + transfer creation.
- No CRS/Twilio/Bridge/Stripe secret calls from the client — server-side services only.
