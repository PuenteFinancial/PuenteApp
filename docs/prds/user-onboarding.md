# PRD — User Onboarding: Account Creation + Identity Verification

**Owner:** Joshua
**Build target:** Claude Code
**Goal:** A user can sign up on the Puente web app with their phone number, provide basic profile info, and complete Bridge's hosted KYC — leaving them approved (or pending review) to transact when remittance launches.

---

## 1. What we're building

Two steps, web only (Next.js, `apps/web`):

1. **Create account** — phone OTP auth + first name, last name, email.
2. **Verify identity** — redirect to Bridge's hosted KYC flow; handle the return and webhook.

End state: user has a `public.users` row, a Bridge `customer_id`, and a `kyc_status` of `pending` or `approved`.

### User journey
```
/signup
  → enter phone → POST /v1/auth/otp/send → OTP sent via Supabase/Twilio
  → enter 6-digit code → POST /v1/auth/otp/verify → JWT issued, httpOnly cookie set
  → /onboarding/profile
  → enter first name, last name, email → PATCH /v1/users/me → saves to public.users
      → Supabase sends email verification (non-blocking — user can proceed)
  → /onboarding/kyc
  → click "Verify my identity"
      → redirect to Bridge ToS: https://dashboard.bridge.xyz/accept-terms-of-service?redirect_uri=<return_url>
      → user accepts Bridge ToS
      → Bridge redirects back to /onboarding/kyc/tos-return?signed_agreement_id=<id>
      → POST /v1/users/me/kyc-link { signed_agreement_id }
          → create Bridge customer (first_name, last_name, email, type, signed_agreement_id)
          → store bridge_customer_id
          → get Bridge KYC link (with endorsements: [base, spei])
          → redirect to Bridge hosted KYC URL
  → Bridge collects: DOB, address, SSN/ITIN, ID document
  → Bridge redirects back to /onboarding/kyc/return
  → show pending or approved state
  → Bridge webhook → POST /v1/webhooks/bridge → update kyc_status in DB
  → /dashboard (stub, only reachable when kyc_status = approved)
```

---

## 2. Non-goals

- No sending money, no recipient management, no Stripe payment methods.
- No mobile app (web only this session).
- No tiered KYC — every user goes through full Bridge KYC before transacting.
- No email/password auth — phone OTP only.
- No admin UI, no manual review tooling.
- ITIN support is handled by Bridge's hosted flow — we pass them the customer record; they collect the TIN.

---

## 3. Prerequisites (already built)

- `public.users` table exists with: `id`, `phone`, `email`, `first_name`, `last_name`, `status`, `created_at`, `updated_at`.
- Supabase phone auth enabled with Twilio + test number (`15555555555=123456`).
- Fastify API live on Railway (`puenteapi-production.up.railway.app`).
- `apps/api/src/services/supabase.ts` — `supabaseAdmin` singleton.
- `apps/api/src/plugins/audit.ts` — audit hook.
- `apps/web` — Next.js app deployed to Vercel, Doppler synced.

---

## 4. Architecture

```
Browser → Next.js server action/API route → Fastify API → Supabase Auth / Supabase DB / Bridge API
```

- Puente never touches funds. Bridge holds the MTLs.
- No Supabase client on the web frontend — all calls go through Fastify.
- JWT from Supabase (issued by Fastify's `/v1/auth/otp/verify`) is stored in an httpOnly cookie by a Next.js API route.
- Fastify reads the JWT from `Authorization: Bearer` header; Next.js server actions read the cookie and attach the header.

---

## 5. Tech + config

### New env vars

```
# Bridge — server-side only, never NEXT_PUBLIC_
BRIDGE_API_KEY=
BRIDGE_API_BASE=https://api.bridge.xyz
BRIDGE_WEBHOOK_SECRET=   # HMAC secret for validating Bridge webhook payloads
```

Add to:
- `apps/api/.env.example`
- `apps/api/src/config/env.ts` (Zod schema, all required)
- Doppler `puente-api` production + staging

### New dependencies

`apps/api`:
- `jose` — JWT verification via JWKS (for auth middleware)

No new deps for `apps/web` — uses existing `fetch` + existing Tailwind + existing translation pattern.

### New DB migration

`supabase/migrations/20260707000000_add_bridge_kyc_fields.sql`:
```sql
alter table public.users
  add column bridge_customer_id text unique,
  add column kyc_status         text not null default 'not_started'
                                check (kyc_status in ('not_started','pending','approved','rejected','manual_review')),
  add column email_verified_at  timestamptz;
```

---

## 6. Build steps

### Step 1 — DB migration

Apply `20260707000000_add_bridge_kyc_fields.sql`:
```bash
supabase link --project-ref namdkmsmdkmdffgscqgd && supabase db push  # staging
supabase link --project-ref goyfagidfkjyhyepsaup && supabase db push  # production
```

---

### Step 2 — Fastify auth middleware + shared type setup

**`apps/api/src/plugins/auth.ts`** (new):
- `fastify-plugin` wrapping `server.addHook('onRequest', ...)`
- Skip if `request.routeOptions.config?.public === true`
- Parse `Authorization: Bearer <token>`; return 401 if missing/malformed
- Cache `createRemoteJWKSet(new URL(env.SUPABASE_JWKS_URL))` at plugin init — not per request
- `jwtVerify(token, JWKS)` → set `request.user = { id: payload.sub as string }`
- Return 401 on any verification failure

**`apps/api/src/types/fastify.d.ts`** (extend existing):
```typescript
interface FastifyRequest {
  user?: { id: string }
}
```

**`packages/shared/src/types/kyc.ts`** (new):
```typescript
export type KycStatus = 'not_started' | 'pending' | 'approved' | 'rejected' | 'manual_review'
export interface KycLinkResponse { url: string }
```

Register auth plugin in `apps/api/src/server.ts` AFTER rate-limit, BEFORE routes:
```typescript
await server.register(authPlugin)
```

---

### Step 3 — Bridge service

**`apps/api/src/services/bridge.ts`** (new):

```typescript
const BASE = env.BRIDGE_API_BASE  // https://api.bridge.xyz (production)
const headers = { 'Api-Key': env.BRIDGE_API_KEY, 'Content-Type': 'application/json' }

export async function createBridgeCustomer(data: {
  firstName: string; lastName: string; email: string; signedAgreementId: string
}): Promise<{ id: string }>
// POST /v0/customers — include Idempotency-Key: crypto.randomUUID()
// body: { type: 'individual', first_name, last_name, email, signed_agreement_id }

export async function getKycLink(
  customerId: string, redirectUri: string
): Promise<{ kyc_link: string }>
// GET /v0/customers/{id}/kyc_link?endorsement=spei&redirect_uri=<encoded>
```

- Use `crypto.randomUUID()` for `Idempotency-Key` on every POST.
- Throw a typed error with Bridge's response body on non-2xx.
- Never log `BRIDGE_API_KEY`.

### Step 3b — Bridge ToS redirect (client-side, no backend needed)

The `/onboarding/kyc` page redirects the browser directly to:
```
https://dashboard.bridge.xyz/accept-terms-of-service?redirect_uri=<encoded /onboarding/kyc/tos-return>
```
Bridge returns to `/onboarding/kyc/tos-return?signed_agreement_id=<id>`. That page reads the ID from the URL and immediately calls `POST /v1/users/me/kyc-link` with it, then redirects to Bridge's KYC URL.

Add `/onboarding/kyc/tos-return` as a new web page (server component — reads search params, calls API, redirects).

---

### Step 4 — Fastify auth routes

**`apps/api/src/routes/v1/auth.ts`** (new) — both routes `config: { public: true }`:

**`POST /v1/auth/otp/send`**
- Body: `{ phone: string }` (required, minLength: 1)
- Calls `supabaseAdmin.auth.signInWithOtp({ phone, options: { channel: 'sms' } })`
- Returns `{ message: 'OTP sent' }`
- Never log phone number

**`POST /v1/auth/otp/verify`**
- Body: `{ phone: string, token: string }` (both required)
- Calls `supabaseAdmin.auth.verifyOtp({ phone, token, type: 'sms' })`
- Returns `{ accessToken, refreshToken, expiresIn, userId }`
- Returns 401 if Supabase rejects the token
- Never log phone or token

---

### Step 5 — Fastify user + KYC routes

**`apps/api/src/routes/v1/users.ts`** (new):

**`PATCH /v1/users/me`** — auth required, audit log:
- Body: `{ firstName: string, lastName: string, email: string }` (all required)
- Validates email format
- Upserts into `public.users`: `first_name`, `last_name`, `email` where `id = request.user.id`
- Calls `supabaseAdmin.auth.admin.updateUserById(userId, { email })` to trigger email verification (non-blocking)
- Returns updated user row (omit PII from logs)
- Does NOT create Bridge customer — that happens in kyc-link after ToS acceptance

**`POST /v1/users/me/kyc-link`** — auth required, audit log:
- Body: `{ signed_agreement_id: string }` (required)
- Reads user from `public.users` for `request.user.id`
- If `bridge_customer_id` is null: calls `createBridgeCustomer({ firstName, lastName, email, signedAgreementId })` → saves `bridge_customer_id`
- Calls `getKycLink(bridge_customer_id, redirectUri, ['base', 'spei'])` where `redirectUri = ALLOWED_ORIGINS[0] + '/onboarding/kyc/return'`
- Returns `{ url: string }`

**`apps/api/src/routes/v1/webhooks.ts`** (new):

**`POST /v1/webhooks/bridge`** — `config: { public: true }`, but validates Bridge HMAC:
- Read raw body (must not be parsed by Fastify JSON parser for this route — use `addContentTypeParser` or raw body hook)
- Validate HMAC-SHA256 signature against `BRIDGE_WEBHOOK_SECRET` using `crypto.createHmac`
- Return 400 on invalid signature
- On `customer.kyc_status_updated` event: map Bridge `kyc_status` → our enum → `update public.users set kyc_status = $1 where bridge_customer_id = $2`
- On `approved`: also set `status = 'active'`
- Write audit log entry for every webhook received (include Bridge customer_id, not PII)

Register all routes in `apps/api/src/server.ts`:
```typescript
await server.register(authRoute, { prefix: '/v1' })
await server.register(usersRoute, { prefix: '/v1' })
await server.register(webhooksRoute, { prefix: '/v1' })
```

---

### Step 6 — Next.js session handling

**`apps/web/app/api/auth/callback/route.ts`** (new):
- `POST` — receives `{ accessToken, refreshToken }` from client after OTP verify
- Sets `puente_session` httpOnly cookie (`Secure`, `SameSite=Lax`, path `/`)
- Returns `{ ok: true }`

**`apps/web/app/api/auth/signout/route.ts`** (new):
- `POST` — clears `puente_session` cookie
- Returns `{ ok: true }`

**`apps/web/lib/session.ts`** (new):
- `getSession(cookies)` — reads `puente_session` cookie, returns token string or null
- `apiFetch(path, options, token)` — wrapper: `fetch(INTERNAL_API_URL + path)` with `Authorization: Bearer <token>`, throws on non-2xx

---

### Step 7 — Web pages

All pages are server components where possible; client components only for forms. Use existing Tailwind setup. All user-facing strings go through `apps/web/lib/translations.ts` (add `onboarding` key to both `en` and `es`).

**`/signup` — `apps/web/app/signup/page.tsx`**
- Phone number input (`type="tel"`)
- Submit → `POST /v1/auth/otp/send` via server action
- On success → redirect to `/signup/verify?phone=<encoded>`
- Show error inline on failure

**`/signup/verify` — `apps/web/app/signup/verify/page.tsx`**
- Reads `phone` from search params
- 6-digit code input (`maxLength=6`, `inputMode="numeric"`)
- Submit → `POST /v1/auth/otp/verify` → on success: `POST /api/auth/callback` to set cookie → redirect to `/onboarding/profile`
- "Resend code" link → calls send again
- Error inline

**`/onboarding/profile` — `apps/web/app/onboarding/profile/page.tsx`**
- Requires session (server component checks cookie; redirect to `/signup` if missing)
- First name, last name, email inputs
- Submit → `PATCH /v1/users/me` → on success: redirect to `/onboarding/kyc`

**`/onboarding/kyc` — `apps/web/app/onboarding/kyc/page.tsx`**
- Requires session
- Static explainer: "We're required to verify your identity before you can send money. This takes about 2 minutes."
- "Verify my identity" button → redirect to Bridge ToS URL (see Step 3b)

**`/onboarding/kyc/tos-return` — `apps/web/app/onboarding/kyc/tos-return/page.tsx`**
- Server component — Bridge redirects here with `?signed_agreement_id=<id>`
- Reads `signed_agreement_id` from search params; return 400 if missing
- Calls `POST /v1/users/me/kyc-link { signed_agreement_id }` → gets Bridge KYC URL
- Immediately redirects to Bridge KYC URL (no UI shown)

**`/onboarding/kyc/return` — `apps/web/app/onboarding/kyc/return/page.tsx`**
- Bridge redirects here after the user completes their hosted flow
- Server component: fetch current user from `GET /v1/users/me` (add this lightweight endpoint)
- If `kyc_status = approved` → redirect to `/dashboard`
- Otherwise → redirect to `/onboarding/pending`

**`/onboarding/pending` — `apps/web/app/onboarding/pending/page.tsx`**
- "Your identity is being verified."
- "This usually takes a few minutes but can take up to 1 business day."
- "You'll receive an email when you're approved."
- No action needed; the Bridge webhook will update status and email the user (or we can add a polling refresh later)

**`/dashboard` — `apps/web/app/dashboard/page.tsx`**
- Requires session + `kyc_status = approved` (redirect to `/onboarding/pending` otherwise)
- Stub: "You're verified. Remittance coming soon."

---

### Step 8 — `GET /v1/users/me` (lightweight, needed by kyc/return)

Add to `apps/api/src/routes/v1/users.ts`:
- Auth required
- Returns `{ id, firstName, lastName, email, kycStatus, bridgeCustomerId }`
- No PII in logs

---

## 7. New files

```
supabase/migrations/20260707000000_add_bridge_kyc_fields.sql
packages/shared/src/types/kyc.ts
apps/api/src/plugins/auth.ts
apps/api/src/services/bridge.ts
apps/api/src/routes/v1/auth.ts
apps/api/src/routes/v1/users.ts
apps/api/src/routes/v1/webhooks.ts
apps/web/app/api/auth/callback/route.ts
apps/web/app/api/auth/signout/route.ts
apps/web/lib/session.ts
apps/web/app/signup/page.tsx
apps/web/app/signup/verify/page.tsx
apps/web/app/onboarding/profile/page.tsx
apps/web/app/onboarding/kyc/page.tsx
apps/web/app/onboarding/kyc/tos-return/page.tsx
apps/web/app/onboarding/kyc/return/page.tsx
apps/web/app/onboarding/pending/page.tsx
apps/web/app/dashboard/page.tsx
```

## Modified files

```
packages/shared/src/types/index.ts          (export KycStatus, KycLinkResponse)
apps/api/package.json                       (add jose)
apps/api/src/config/env.ts                  (add BRIDGE_API_KEY, BRIDGE_API_BASE, BRIDGE_WEBHOOK_SECRET)
apps/api/src/types/fastify.d.ts             (add user?: { id: string } to FastifyRequest)
apps/api/src/server.ts                      (register authPlugin, authRoute, usersRoute, webhooksRoute)
apps/api/.env.example                       (add BRIDGE_* vars)
apps/web/lib/translations.ts                (add onboarding strings in en + es)
```

---

## 8. Compliance + security guardrails

- PII (name, phone, email) never logged — log `userId` or `bridge_customer_id` only
- Bridge API key server-side only — never in env vars prefixed `NEXT_PUBLIC_`
- Webhook HMAC validation is mandatory before any DB write
- Auth middleware must run before all non-public routes
- Audit log entry on: PATCH /v1/users/me, POST /v1/users/me/kyc-link, every bridge webhook received
- Run **security-reviewer subagent** before opening PR (new auth routes + webhook handler)
- Run **compliance-reviewer subagent** before merge (consent/KYC flow)

---

## 9. Acceptance criteria

- [ ] `pnpm run typecheck` passes across all workspaces
- [ ] `curl -X POST https://localhost:3001/v1/auth/otp/send -d '{"phone":"15555555555"}'` → `{ message: 'OTP sent' }`
- [ ] `curl -X POST .../v1/auth/otp/verify -d '{"phone":"15555555555","token":"123456"}'` → returns tokens
- [ ] `curl -X PATCH .../v1/users/me` with Bearer token + name/email → 200, Bridge sandbox customer created
- [ ] `curl -X POST .../v1/users/me/kyc-link` → returns a Bridge sandbox KYC URL
- [ ] Simulated Bridge webhook with correct HMAC → `kyc_status` updates in DB; invalid HMAC → 400
- [ ] Web: navigate to `/signup`, complete full flow through to `/onboarding/pending`
- [ ] No JWT, Bridge key, or PII appears in any server log
- [ ] Security-reviewer and compliance-reviewer subagents pass before PR

> **Post-deploy one-time step (Joshua):** Register webhook with Bridge:
> ```bash
> curl -X POST https://api.bridge.xyz/v0/webhooks \
>   -H "Api-Key: $BRIDGE_API_KEY" \
>   -H "Content-Type: application/json" \
>   -d '{"url":"https://puenteapi-production.up.railway.app/v1/webhooks/bridge","event_categories":["customer"]}'
> ```
> Copy the returned signing secret → add to Doppler `puente-api` as `BRIDGE_WEBHOOK_SECRET` → Railway redeploys.

---

## 10. Reference

- Bridge Customers API: https://apidocs.bridge.xyz/platform/customers/overview
- Bridge KYC hosted links: https://apidocs.bridge.xyz/platform/customers/customers/kyclinks
- Bridge Endorsements: https://apidocs.bridge.xyz/platform/customers/customers/endorsements
- Bridge Webhooks: https://apidocs.bridge.xyz/platform/webhooks
- Supabase phone auth: https://supabase.com/docs/guides/auth/phone-login
