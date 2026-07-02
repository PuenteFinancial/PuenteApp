# PRD — Bridge PoC: Move USD from my personal bank to my business bank

**Owner:** Joshua
**Build target:** Claude Code (single-session build)
**Goal:** Prove out a Bridge integration that moves USD from my personal bank account to my business bank account via a single Bridge transfer. I initiate the inbound ACH myself from my bank app. Nothing fancy — one send, all USD.

---

## 1. What we're building

A small command-line script that talks to the Bridge API and does this:

1. Reuses my **existing** Bridge customer (I already have one; status `active` — see §3).
2. Registers my **business bank account** as a USD external account (the payout destination).
3. Creates a **Bridge wallet** (USDC, on Base) to sit in the middle.
4. **Onramp:** creates a transfer, personal USD (ACH push) → USDC in the wallet. Prints deposit instructions (account #, routing #, `deposit_message`) so I can push the ACH from my bank app.
5. **Payout:** once the USDC lands, creates a second transfer, USDC in the wallet → business USD via ACH.
6. Polls each transfer's state.

> **This is a production build.** Live API key, active customer — straight to real money. No sandbox, no customer creation, no simulated KYC.

> **Why the wallet?** Bridge has **no same-currency USD→USD route** — every transfer must have a stablecoin leg. `USD@ACH` only routes to crypto; `USDC@Bridge Wallet` routes back out to `USD@ACH`. So moving USD→USD requires two legs through a wallet. (Verified against Bridge's route table; a direct USD-ACH→USD-ACH transfer returns `400 route not supported`.)

### Money flow
```
My personal bank --(I push ACH)--> Bridge onramp acct --> USDC in Bridge wallet --(payout, ACH)--> My business bank
                      leg 1: onramp                              leg 2: payout (after leg 1 settles)
```

---

## 2. Non-goals (keep it simple)

- No web UI in Part 1 (that's Part 2). CLI script only.
- One shared **treasury wallet** only (required for the USD→USD stablecoin leg) — no per-customer wallets, no virtual accounts, no liquidation addresses, no cards.
- No webhook server — we poll for status instead.
- No multi-user, no persistence beyond writing IDs to a local `.json` file.
- No recipient other than my own business account.

---

## 3. Hard prerequisites (already satisfied — just gather them)

1. ✅ **Live (production) API key** — I have it. Base URL: `https://api.bridge.xyz`.
2. ✅ **Customer with approved KYC** — that's me; the customer already exists. I just need my `customer_id` (from the dashboard, or `GET /v0/customers`).
3. **Business bank account details** to gather: routing number, account number, account type (checking/savings), legal owner name, and the bank's mailing address.

> ⚠️ **Reality check:** This moves **real money**. Standard ACH settles in **1–3 business days** (same-day ACH if pushed before the cutoff), so I initiate tonight and it lands in a few days. Keep the first send tiny ($1–$5).

---

## 4. Tech + config

- **Runtime:** Node.js 18+ (uses built-in `fetch` and `crypto.randomUUID()`; no dependencies).
- **Single file:** `bridge-poc.js` with subcommands, plus a `.env` for secrets and a generated `state.json` for IDs.
- **Env vars (`.env`):**
  ```
  BRIDGE_API_KEY=<live key>
  BRIDGE_API_BASE=https://api.bridge.xyz
  BRIDGE_CUSTOMER_ID=<my existing customer_id>
  BRIDGE_EXTERNAL_ACCOUNT_ID=<my business external account id>
  ```
- **Every write request needs headers:** `Api-Key`, `Content-Type: application/json`, and a unique `Idempotency-Key` (use `crypto.randomUUID()`). Reuse the same idempotency key on retries of the same logical action.

---

## 5. Build steps / API sequence

All paths are relative to `BRIDGE_API_BASE` + `/v0`.

### Step 1 — Use my existing customer
No customer creation. Read `BRIDGE_CUSTOMER_ID` from `.env`.
> If I don't have the ID handy: `GET /v0/customers` and find mine.

### Step 2 — Verify KYC is approved (sanity check)
`GET /v0/customers/{customer_id}` and confirm `kyc_status: "approved"` before moving money. Fail with a clear message if not.

### Step 3 — Business bank account (payout destination)
**Already created on the dashboard.** Just fetch its ID: `GET /v0/customers/{customer_id}/external_accounts` and grab the `id` of the business account. Put it in `.env` as `BRIDGE_EXTERNAL_ACCOUNT_ID`. Only create one via API if it's missing:

`POST /v0/customers/{customer_id}/external_accounts`
```json
{
  "currency": "usd",
  "account_type": "us",
  "bank_name": "My Business Bank",
  "account_name": "Business Checking",
  "account_owner_type": "individual",
  "account_owner_name": "Joshua Phelps",
  "first_name": "Joshua",
  "last_name": "Phelps",
  "account": {
    "routing_number": "XXXXXXXXX",
    "account_number": "XXXXXXXXXXXX",
    "checking_or_savings": "checking"
  },
  "address": {
    "street_line_1": "...", "city": "...", "state": "XX",
    "postal_code": "...", "country": "USA"
  }
}
```
> If the business account is held under a business entity rather than you personally, set `"account_owner_type": "business"` and include `"business_name"` instead of first/last name.

### Step 4 — Create the treasury wallet (once)
`POST /v0/customers/{customer_id}/wallets`
```json
{ "chain": "base" }
```
Save the returned wallet `id`. This holds USDC between the two legs.

### Step 5 — Leg 1: Onramp (personal USD → USDC in wallet)
`POST /v0/transfers`
```json
{
  "on_behalf_of": "{customer_id}",
  "amount": "5.00",
  "developer_fee": "0",
  "source": { "payment_rail": "ach_push", "currency": "usd" },
  "destination": { "payment_rail": "base", "currency": "usdc", "bridge_wallet_id": "{wallet_id}" }
}
```
From the response, read and **print** `source_deposit_instructions`:
- `bank_account_number` / `bank_routing_number` — where I send the ACH
- `amount` and `currency`
- `deposit_message` — **must** be in the ACH memo or the deposit won't reconcile

Then I push the ACH from my personal bank app to those details. USDC lands in the wallet after the ACH settles (1–3 business days).

### Step 6 — Leg 2: Payout (USDC in wallet → business USD)
Only after leg 1's USDC has landed. `POST /v0/transfers`
```json
{
  "on_behalf_of": "{customer_id}",
  "developer_fee": "0",
  "source": { "currency": "usdc", "payment_rail": "bridge_wallet", "bridge_wallet_id": "{wallet_id}" },
  "destination": {
    "amount": "5.00",
    "currency": "usd",
    "payment_rail": "ach",
    "external_account_id": "{external_account_id}",
    "ach_reference": "POC TEST"
  }
}
```
> If this 400s with insufficient funds, the onramp USDC hasn't landed yet — wait for leg 1.
> **SCA caveat:** if the wallet's create response had `initiation_required: true`, this payout transfer must also include an `initiation` object (channel + subchannel + SCA attestations). Check the wallet create response; add the object only if required.

### Step 7 — Poll status
`GET /v0/transfers/{transfer_id}` for either leg. States:
`awaiting_funds → funds_received → payment_submitted → payment_processed` (terminal = success).
> Re-run over the next few days rather than polling in a tight loop.

---

## 6. CLI shape (suggested)

```
node bridge-poc.js ids             # verify status + list external accounts
node bridge-poc.js wallet          # create the USDC treasury wallet (once)
node bridge-poc.js onramp 5.00     # leg 1: personal USD (ACH) -> USDC in wallet; prints deposit instructions
node bridge-poc.js payout 5.00     # leg 2: USDC in wallet -> business USD (ACH); after leg 1 settles
node bridge-poc.js status          # fetch last transfer state
```

`state.json` stores `wallet_id` and the transfer ids (customer_id + external_account_id come from `.env`).

---

## 7. Acceptance criteria

**Tonight (production):**
- [ ] `ids` confirms my customer's `kyc_status: approved` and lists the business external account.
- [ ] `send 5.00` creates a transfer and prints deposit instructions including account #, routing #, and a `deposit_message`.
- [ ] I push the ACH from my personal bank app with that memo.
- [ ] `status` shows `awaiting_funds` immediately after.
- [ ] No secrets are hard-coded; everything reads from `.env`.

**Over the next few days:**
- [ ] `status` progresses to `payment_processed` and the money lands in my business account.

---

## 8. Guardrails / notes for the implementer

- Fail loudly on non-2xx responses: print status code + response body.
- Generate a fresh `Idempotency-Key` per new action; persist it so retries reuse it.
- Never log the API key.
- Amounts are strings, not numbers (e.g. `"5.00"`).
- `payment_rail` on the source is intent only — Bridge records the actual received rail; fine for a PoC.
- Keep the first real-money test tiny ($1–$5).

---

## 9. Reference

- Sandbox setup: https://apidocs.bridge.xyz/get-started/introduction/quick-start/setting-up-sandbox
- USD integration (ACH in/out schemas): https://apidocs.bridge.xyz/get-started/guides/move-money/usd-integration-guide
- Create a transfer: https://apidocs.bridge.xyz/api-reference/transfers/create-a-transfer
- Create an external account: https://apidocs.bridge.xyz/api-reference/external-accounts/create-a-new-external-account
- Create a customer: https://apidocs.bridge.xyz/api-reference/customers/create-a-customer

---
---

# Part 2 — Web demo (Next.js App Router, `apps/web`)

Build the demo **directly into `apps/web`** — the existing Next.js 15 App Router site that's already deployed on Vercel. It already makes server-side external calls from route handlers (see `apps/web/app/api/fx-rate/route.ts`), so Bridge fits the same pattern. No Fastify, no new deployment.

**`bridge-poc.js` (Part 1) is just the reference spike** — the same Bridge calls move into the route handlers below.

## 2.0 Demo home vs production home — READ THIS

Per repo `CLAUDE.md`, real money-movement belongs in `apps/api` (Fastify) with audit logging, idempotency keys, the double-entry ledger, transaction state machine, and a `security-reviewer` pass. **This Part 2 is a throwaway demo, not that.** It intentionally cuts those corners to get a clickable page today. Do **not** promote this route to the real product — when remittance goes real, it's rebuilt in `apps/api` under those conventions. Keep the demo behind a non-production path and consider a PostHog flag so it can't be stumbled into.

## 2.1 Goal

A single page (e.g. `/remittance-demo`) where I can:
1. Click **Start transfer** (with an amount).
2. See the **deposit instructions** Bridge returns (account #, routing #, memo/`deposit_message`), copyable.
3. Push the ACH from my bank app manually.
4. Click **Refresh status** to see the transfer state.

## 2.2 The one hard rule

The Bridge **live key is server-side only** — it lives in the route handler (Node runtime), never in a client component and never a `NEXT_PUBLIC_` var. Flow: **browser → Next.js route handler (holds key) → Bridge**.

## 2.3 Files to add (match existing conventions)

```
apps/web/lib/bridge.ts                        # helper: env + fetch wrapper (mirrors lib/fx.ts style)
apps/web/app/api/remittance/route.ts          # POST -> create transfer
apps/web/app/api/remittance/status/route.ts   # GET  -> transfer status (?id=...)
apps/web/app/remittance-demo/page.tsx         # the demo page (client component)
```

- Route handlers follow the `fx-rate/route.ts` shape: `import { NextRequest, NextResponse } from 'next/server'`, `export async function POST/GET`, return `NextResponse.json(...)`.
- Put the Bridge fetch + env reads in `lib/bridge.ts`, imported via `@/lib/bridge`.
- Add `export const runtime = 'nodejs'` to the route handlers (uses `crypto.randomUUID()` and a secret; keep off the Edge runtime).

## 2.4 Route handlers

**`POST /api/remittance` — create the onramp transfer (leg 1)**
- Body: `{ "amount": "5.00" }`. Validate server-side: positive, 2 decimals, cap (≤ $20 for the demo).
- Calls Bridge `POST /v0/transfers` with the **onramp** payload (Part 1 §5 Step 5): source `ach_push`/usd, destination `base`/usdc/`bridge_wallet_id`, `on_behalf_of` from env. Fresh `Idempotency-Key` per call.
- Requires a treasury wallet id in env (`BRIDGE_WALLET_ID`) — created once via the CLI `wallet` command or the dashboard.
- The live demo shows leg 1 only (USD → USDC + deposit instructions + status). The payout leg (USDC → business bank) happens later once funds settle and is out of scope for the clickable demo.
- Returns only what the page needs:
  ```json
  {
    "transfer_id": "...",
    "state": "awaiting_funds",
    "deposit_instructions": {
      "amount": "5.00",
      "bank_account_number": "...",
      "bank_routing_number": "...",
      "bank_name": "...",
      "deposit_message": "..."
    }
  }
  ```

**`GET /api/remittance/status?id=<transfer_id>` — check status**
- Calls Bridge `GET /v0/transfers/{id}`.
- Returns `{ "state": "...", "amount": "...", "currency": "usd", "receipt": {...} }`.

## 2.5 Page (`app/remittance-demo/page.tsx`, client component)

- Amount input + **Start transfer** → `POST /api/remittance`.
- On success, a **deposit card**: amount, account #, routing #, bank, and the memo — each copy-to-clipboard, memo visually prominent with a "must include this or it won't reconcile" note.
- A **status area** with the current `state` and a **Refresh** button → `GET /api/remittance/status?id=...`.
- Show the ladder for context: `awaiting_funds → funds_received → payment_submitted → payment_processed`, plus "Standard ACH settles in 1–3 business days."
- Style with Tailwind (already in the project). Keep it one screen.

## 2.6 Config (env vars — Doppler → Vercel)

Server-side only. The repo uses Doppler synced to Vercel; add these there (and to local Doppler / `.env.local` for dev):
```
BRIDGE_API_KEY
BRIDGE_API_BASE=https://api.bridge.xyz
BRIDGE_CUSTOMER_ID
BRIDGE_EXTERNAL_ACCOUNT_ID
BRIDGE_WALLET_ID           # treasury wallet for the USDC leg (create once)
```
None of these are `NEXT_PUBLIC_`. Read them only inside `lib/bridge.ts` / route handlers.

## 2.7 Guardrails

- Never return or log the API key; never send it to the client.
- Validate + cap `amount` server-side.
- Fresh `Idempotency-Key` per transfer POST.
- Fail loudly server-side (log Bridge status + error body); show the page a friendly message.
- Gate the page/route so it isn't reachable in normal prod nav (feature flag or obscure path) — it's a demo touching real money.

## 2.8 Acceptance criteria

- [ ] Visiting `/remittance-demo` and clicking **Start transfer** creates a real Bridge transfer and renders deposit instructions incl. `deposit_message`.
- [ ] The live key is server-side only — not in any network response, client bundle, or `NEXT_PUBLIC_` var.
- [ ] After I push the ACH, **Refresh status** reflects the transfer's `state`.
- [ ] Runs against `https://api.bridge.xyz` with the live key, both locally (`next dev`) and on Vercel.
- [ ] `pnpm --filter @puente/web typecheck` and `next build` pass.

## 2.9 Out of scope (for the demo)

- Auth / multi-user / choosing recipients (external account fixed via env).
- Webhooks (nothing settles in real time during a live demo; add in `apps/api` for the real product).
- Persistence, ledger, audit logging — all deferred to the real `apps/api` build.
