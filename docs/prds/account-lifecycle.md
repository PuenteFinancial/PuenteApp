# PRD — Account Lifecycle: Returning Users, Rejected KYC, Sessions

**Owner:** Joshua
**Build target:** Claude Code
**Goal:** Every user who is *not* mid-happy-path — returning, rejected, expired session, broken row — lands on the right screen with a truthful message and a way forward. Onboarding/login must be fully done before remittance MVP work starts.

**Context:** The onboarding pipeline (see `user-onboarding.md`) was verified end-to-end in production on 2026-07-08, including a real rejection propagating to the DB via webhook (PR #42). Live testing that day exposed every gap this PRD covers.

---

## 1. What we're building

Five slices, ordered. Each is one PR.

1. **Rejected KYC state + retry** — rejected users currently see "verifying your identity" forever.
2. **State-aware sign-in routing (`/continue`) + users-row upsert** — returning users currently get a blank profile form that overwrites their data; a deleted `users` row 500s every profile save.
3. **Session refresh** — sessions silently die after ~1 hour; every user becomes a "returning user" within the hour.
4. **Sign-in event tracking** — durable per-sign-in record (device, IP) as a risk data point.
5. **Truthful notifications** — the pending screen promises an approval email nobody sends.

### Decisions already made (2026-07-08)

- **Single door:** `/signup` is both signup and login (identity = phone number; Supabase creates-or-signs-in). Add a "Sign in" link on the landing page pointing at the same flow; adjust copy so returning users aren't told they're "creating an account."
- **Routing is server-side** (`/continue` page), not client-side in `OtpForm`. Stale client bundles must not be able to run yesterday's routing — this bit us in production on 2026-07-08.
- **Retry uses the same Bridge customer:** re-issue a hosted KYC link via `GET /v0/customers/{id}/kyc_link` (plumbing exists in `apps/api/src/services/bridge.ts`). Deleting the Bridge customer is an *admin* reset path, not the user-facing retry (the `customer.deleted` webhook self-heal is live and verified).

### Post-login routing matrix (the contract for `/continue`)

| User state | Route |
|---|---|
| No `users` row (upsert failed / legacy) | `/onboarding/profile` |
| Missing first/last name or email | `/onboarding/profile` (prefilled with whatever exists) |
| `kyc_status = not_started` | `/onboarding/kyc` |
| `kyc_status = pending` or `manual_review` | `/onboarding/pending` |
| `kyc_status = rejected` | `/onboarding/rejected` |
| `kyc_status = approved` | `/dashboard` |

Every entry point converges here: post-OTP verify, landing-page "Sign in," and any protected page that finds a valid session but a user in the wrong place.

---

## 2. Non-goals

- No remittance functionality (recipients, FX, funding, ledger) — explicitly sequenced after this PRD is done.
- No email/password or social auth — phone OTP stays the only credential.
- No admin/manual-review tooling; no support-ticket system (rejected screen links to a mailto).
- No device *fingerprinting* (canvas/audio entropy etc.) — user-agent + IP only.
- No mobile app changes.

---

## 3. Slice 1 — Rejected KYC state + retry

**Today:** `/dashboard` bounces every non-approved status to `/onboarding/pending`, which claims "we're verifying your identity" — false for rejected users, forever.

**Build:**
- New `/onboarding/rejected` page (server component, session-gated like siblings): honest headline, short explanation, two actions — **Try again** and **Contact support** (mailto).
- **Try again** → `POST /v1/users/me/kyc-link/retry` (new, auth) → re-issues hosted KYC link for the existing `bridge_customer_id` → redirect to Persona. Surface Bridge's `rejection_reasons` from `GET /v0/customers/{id}` when available ("your ID photo couldn't be read") — generic fallback copy otherwise.
- Retry limit: **3 self-serve retries**, tracked as `kyc_retry_count` on `users`; after that, support-only copy. (Bridge hard rejects — sanctions/fraud — come back rejected immediately; same ceiling handles them.)
- `/onboarding/pending` and `/dashboard` route `rejected` → `/onboarding/rejected`.

**Compliance guardrails:**
- Copy is strictly about *identity verification* — never imply a credit denial (no ECOA/FCRA adverse-action trigger, and wording must not suggest one).
- `rejection_reasons` may reference documents — show category, never log it, never put it in URLs.
- en + es parity for all strings; run compliance-reviewer before merge (user-facing consent-adjacent flow).

---

## 4. Slice 2 — `/continue` routing + users-row upsert

**Today:** `OtpForm` always pushes to `/onboarding/profile` (blank form, overwrites the row). A `users` row deleted out-of-band while the auth user survives makes every `PATCH /v1/users/me` 500 (the row is created only by DB trigger on *auth-user* creation — verified in production 2026-07-08).

**Build:**
- `apps/web/app/continue/page.tsx` — server component implementing the routing matrix above. `OtpForm` pushes here and nowhere else.
- OTP verify handler (`apps/api/src/routes/v1/auth.ts`) **upserts** the `users` row (id = auth user id, `kyc_status 'not_started'`) before the `sms_consent_at` write, so a missing row self-heals at sign-in.
- `ProfileForm` prefills from `GET /users/me`; `/onboarding/kyc` redirects approved users to `/dashboard`.
- Landing page gets a "Sign in" link → `/signup`.

*(Queued as a session task chip with full file-level detail — this PRD is the decision record.)*

---

## 5. Slice 3 — Session refresh

**Today:** httpOnly cookie holds the Supabase access token with `maxAge = expiresIn` (~1 h). No refresh token is stored. Past the hour, the next server-rendered page bounces to `/signup`.

**Decision (2026-07-08):** store the Supabase **refresh token in a second httpOnly cookie** (`puente_refresh`, `path=/api/auth`), add a `POST /api/auth/refresh` proxy that exchanges it via the API (`POST /v1/auth/refresh` → `supabase.auth.refreshSession`), and have `apiFetch`-consuming server pages attempt one refresh before redirecting to `/signup`. Target session: **30 days rolling** (Supabase default refresh-token behavior), re-OTP after that.

Rationale: remittance users return weekly-to-monthly to send money; forcing SMS OTP every hour burns Twilio spend and goodwill. Financial-app norm is a durable session with re-auth for sensitive actions — we can add step-up OTP on money movement when remittance lands.

Constraint: refresh tokens are rotating and single-use in Supabase — the proxy must handle the rotation atomically and clear both cookies on refresh failure.

---

## 6. Slice 4 — Sign-in event tracking (risk data point)

**Today:** IP + user-agent hit the audit log (Railway stdout — ephemeral, not queryable). PostHog has device analytics but is an analytics store, not a system of record for risk.

**Build:**
- Migration: `sign_in_events` — `id`, `user_id` (FK), `created_at`, `ip inet`, `user_agent text`, `auth_method text default 'sms_otp'`. RLS: no client access; service-role writes only (follow `financial-schema-checklist`).
- OTP verify handler inserts one row per successful verify (non-blocking — a failed insert must not block sign-in; log a warning).
- No UI. This is a queryable substrate for later risk work (new-device flags, velocity checks, impossible travel).

**Privacy guardrails:** IP + UA live only in this table (never in logs — existing rule), never exposed to the client, and get a **retention policy: 13 months** then purge (scheduled job or manual until ops exist). Note in the privacy policy at legal review.

---

## 7. Slice 5 — Truthful notifications

**Today:** pending screen says "we'll email you as soon as you're approved" — nothing sends email.

**Decision (2026-07-08):** fix the copy now, defer real email.
- **Now:** change the copy to "check back here — verification usually takes a few minutes," and make the pending page poll `GET /users/me` on a 30 s interval (or on tab focus) and route on status change, so "check back" mostly happens by itself.
- **Deferred:** approval/rejection emails from the webhook handler on status transition — revisit alongside remittance notifications (receipts, transfer status) so email infra (provider choice, en/es templates, GLBA-adjacent content review) is built once.

---

## 8. Sequencing & sizing

| # | Slice | Size | Depends on |
|---|---|---|---|
| 1 | Rejected state + retry | M | — |
| 2 | `/continue` + upsert | M | 1 (routes to `/onboarding/rejected`; falls back to pending if 1 slips) |
| 3 | Session refresh | M | — |
| 4 | Sign-in events | S | — |
| 5 | Pending copy + poll | S | — |

5 and 4 are fillers that can ride along with any PR. Definition of done for this PRD: a rejected user retries and passes; a returning approved user lands on `/dashboard` in one step; a 3-day-old session still works; every sign-in has a row in `sign_in_events`; no screen makes a false promise. Then — and only then — remittance MVP.

---

## 9. Acceptance criteria

- [ ] Rejected user sees `/onboarding/rejected` (en + es), can retry up to 3× via re-issued KYC link, sees support contact after
- [ ] Rejected copy passes compliance-reviewer; no adverse-action implication
- [ ] Post-OTP, every user state in the routing matrix lands on the specified page (test all 6 rows)
- [ ] Missing `users` row self-heals at OTP verify; profile save never 500s for a signed-in user
- [ ] ProfileForm shows existing name/email; landing page has a Sign in entry point
- [ ] Session survives past 1 h via refresh; refresh failure cleanly returns to `/signup`
- [ ] `sign_in_events` row written per verify, RLS denies client reads, retention documented
- [ ] Pending page makes no email promise (or the email actually sends); status change while on pending routes forward without manual URL entry
- [ ] All new API routes: Fastify schema validation, auth by default, tests alongside; security-reviewer before merge (auth logic)

---

## 10. Reference

- Verified 2026-07-08 in production: ToS minting (PR #41), webhook event types + `customer.deleted` self-heal (PR #42), rejection propagating to `users.kyc_status`.
- Bridge event types: `customer.created` / `customer.updated` / `customer.updated.status_transitioned` / `customer.deleted`; status at `event_object.status`.
- Identity = phone number: one account per phone, forever. Shared test numbers = one shared account (source of the 2026-07-08 poisoned-row incident). Use Supabase test phone numbers (fixed OTP, no Twilio) for multi-tester work.
- KYC statuses (`@puente/shared`): `not_started`, `pending`, `manual_review`, `approved`, `rejected`.
