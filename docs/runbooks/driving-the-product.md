# Driving the product — operator's guide (local + production)

Written 2026-08-03. Everything in the LOCAL section was executed end-to-end on this date;
where something could **not** be verified it says so explicitly and names what is missing.

The one idea to hold onto: **nothing advances on its own.** The API only ever moves a transfer
to `FUNDED`. Every step after that is driven by a *different* process — the worker, a webhook,
or a human. Most confusion about "why is it stuck" is really "which lever did I not pull".

---

## 1. Who moves a transfer, at every step

| From → To | Who does it | How you trigger it |
|---|---|---|
| — → `PENDING_PAYMENT` | API (user clicks Continue) | The send form |
| `PENDING_PAYMENT` → `FUNDED` | Funding webhook | **Simulate payment** button (local/staging), or Stripe in the future |
| `FUNDED` → `SUBMITTED` | **Worker** (`payout.sweep` → `payout.submit`) | Run the worker. Calls Bridge for real. |
| `SUBMITTED` → `IN_FLIGHT` → `COMPLETED` | Bridge webhooks → **worker** processes them | `scripts/fire-bridge-webhook.ts` (§6) |
| `FUNDED` → `CANCELED` → `REFUNDED` | API, instantly | User taps Cancel *before* payout is claimed |
| any claimed state + cancel | API records a **request**, no state change | User taps Cancel *after* claim → HTTP 202 |
| `COMPLETED` → `UNDER_REVIEW` | Worker, on delivery of a contested transfer | Automatic when a pending request beat the deposit |
| `UNDER_REVIEW` → `REFUNDED` / `COMPLETED` | **A human** | Ops board buttons, or `scripts/resolve-cancellation.ts` |

`UNDER_REVIEW` never resolves itself. That is deliberate: it is the Reg E decision point.

---

## 2. Local: bring the stack up

Four processes. Ports matter — the API and worker both read `PORT`, so the worker needs its own.

```bash
# 1. Database (Docker must be running)
supabase start

# 2. Local grants — a Supabase CLI quirk; hosted projects don't need this
docker exec -i supabase_db_goyfagidfkjyhyepsaup psql -U postgres -d postgres \
  -c "grant select, insert, update, delete on all tables in schema public to service_role, authenticated, anon;"

# 3. API on :3001   4. Worker on :3002   5. Web on :3000
```

The API and worker need an env file pointing at **local** Supabase (not staging). The pieces
that matter:

```
SUPABASE_URL=http://127.0.0.1:54321
SUPABASE_SECRET_KEY=<SERVICE_ROLE_KEY from `supabase status`>   # the legacy JWT, not sb_secret_*
SUPABASE_JWKS_URL=http://127.0.0.1:54321/auth/v1/.well-known/jwks.json
HOST=::                        # IPv4-only bind breaks the web proxy
FUNDING_PROCESSOR=mock
ENABLE_DEV_ENDPOINTS=true      # both of these are required for the
MOCK_FUNDING_WEBHOOK_SECRET=…  # Simulate payment button to exist
OPS_ADMIN_USER_IDS=<your user uuid>
OPS_WRITE_ENABLED=true         # ops action buttons (PR #137)
```

Worker only, on top of that:

```
PORT=3002                      # or it dies with EADDRINUSE against the API
DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:54322/postgres
BRIDGE_TREASURY_WALLET_ID=<a funded Bridge sandbox wallet>
FLOAT_CEILING_MINOR=1000000    # worker refuses to pay out without a ceiling set
```

**Gotcha that will waste your afternoon:** if you start a background process with `… | tail`,
the pipe buffers and you see *nothing* until it exits. Log to a file instead. I lost the first
worker's Bridge error exactly this way.

---

## 3. Local: the demo account

The seed creates María González (KYC pre-approved), recipient Rosa Santos, and a BBVA payout
account. Sign in with the test number **500 555 0006 / code 123456** (configured in
`supabase/config.toml`; no Twilio involved locally).

Two things the seed must get right or the demo opens in the wrong place:

- **Email must be set.** `/continue` sends you to onboarding unless first name, last name, *and*
  email are all present. KYC-approved alone is not enough.
- **`bridge_customer_id` and `provider_account_ref` must be REAL Bridge sandbox ids** if you
  intend to run a payout. Fabricated ones fail with `on_behalf_of is missing` — see §6.

`demo-reset.sh` does the whole thing in ~36 s: database reset → grants → seed → rewrite the ops
allowlist → restart the API.

**Why a full database reset rather than deleting a few rows:** you cannot delete the interesting
data. Ledger entries, ledger transactions, transfer transitions, and disclosures are all
append-only, enforced by database triggers, and transfers are pinned by foreign keys from them.
Trying to clean up by hand gets you:

```
ERROR: ledger is append-only: DELETE on ledger_entries is not allowed;
       post a correcting transaction instead
```

That refusal is worth showing on camera. It is the strongest single statement about how the
money side is built.

---

## 4. Local: driving the consumer flow

1. **Sign in** → 500 555 0006 / 123456. Lands on the dashboard in Spanish (the default).
2. **Enviar dinero** → pick Rosa Santos, enter an amount, **Obtener cotización**. This calls
   Bridge sandbox for a live rate. A $200 quote returned 3,960.14 MXN at 19.9997, $1.99 fee,
   rate locked 15 minutes.
3. **Continuar** → the Reg E prepayment disclosure, rendered in full, in Spanish, with the exact
   rate. Tick the box → **Confirmar transferencia**.
4. **Tracker** appears with the 5-step timeline. State is `PENDING_PAYMENT`; **no ledger entries
   exist yet** — worth pointing out, because it means an abandoned send moves no money.
5. **Simular pago** → `FUNDED`, and the first ledger batch posts.
6. From here: either **cancel** (instant refund, §5) or **pay out** (§6).

### What to show in the database at step 5

```sql
select lt.transition, a.code, e.direction, e.amount_minor
  from public.ledger_entries e
  join public.ledger_transactions lt on lt.id = e.ledger_transaction_id
  join public.ledger_accounts a on a.id = e.account_id
 where lt.transfer_id = '<id>' order by lt.created_at;
```

Funding a $200 send posts, and it balances:

```
FUNDED | funding_receivable | debit  | 20000
FUNDED | transfer_payable   | credit | 19801
FUNDED | fee_revenue        | credit |   199
```

---

## 5. The cancel story (verified, needs no Bridge)

Tap **Cancelar transferencia** while the transfer is `FUNDED` and unclaimed → two-tap confirm →
`CANCELED` → `REFUNDED` immediately. The ledger posts a batch that is an exact mirror of the
funding batch, and the account balances return to zero. Nothing is deleted or rewritten.

```
CANCELED | transfer_payable   | debit  | 19801
CANCELED | fee_revenue        | debit  |   199
CANCELED | funding_receivable | credit | 20000
```

**If the payout was already claimed, cancel behaves completely differently**: the API returns
HTTP 202, the state does *not* change, and a row lands in `cancellation_requests`. That is the
Reg E path — the money may already be gone, so a human decides. This is what populates the ops
board's pending-cancellation queue.

---

## 6. Getting to delivered (partially verified)

**`FUNDED` → `SUBMITTED` works.** Run the worker; its 1-minute `payout.sweep` finds funded
transfers and `payout.submit` calls Bridge. Verified live: a $9.90 send produced Bridge transfer
`9df74b12…` and moved to `SUBMITTED`.

Three things will stop it, all of which I hit:

- **Fake Bridge ids.** Bridge rejects with `on_behalf_of is missing` (a fabricated customer) or
  a bad external account. You need a real sandbox customer *and* a real external account. Real
  ones already exist in your sandbox from earlier sessions — customer
  `e7b1454a-aed5-4265-a5d9-a8c71eb8074f` with MXN account `84d9cafc-6edd-4f16-8ff0-2e46640be141`.
- **Wallet balance.** `amount is higher than the balance of the wallet`. Your sandbox treasury
  holds roughly **$13 of test USDC**, so demo sends must be small (I used $10) — or top the
  wallet up.
- **The per-user cap.** A second send while the first is unsettled is refused with
  `transfer_in_progress` (403). This is the O3 risk control doing its job. Clear it by settling
  the first: `fire-funding-webhook.ts <id> cleared`.

A held transfer shows `payout_hold_reason = submit_error` and the sweep then **skips** it
forever — holds are deliberate dead ends for a human. Clear `payout_hold_reason` and
`submit_attempted_at` to retry.

**`SUBMITTED` → `COMPLETED` is NOT verified locally.** Bridge sandbox parks the payout at
`funds_received` and never delivers, so the last hop must be driven by a Bridge webhook — and
`fire-bridge-webhook.ts` signs with `BRIDGE_WEBHOOK_PRIVATE_KEY`, which the API verifies with
`BRIDGE_WEBHOOK_PUBLIC_KEY`. **Neither is in local env; both live in Doppler.** Add them and the
last hop (and therefore the receipt screen) should work; until then a local demo ends at
`SUBMITTED`.

---

## 7. The ops board

**Where:** `http://localhost:3000/dashboard/ops` — typed directly. There is deliberately no
navigation link anywhere, so an ordinary user never discovers it.

**Access is two environment variables, read once at API boot:**

- `OPS_ADMIN_USER_IDS` — comma-separated user UUIDs. Unset means the route is not registered at
  all and **everyone gets a 404**, including you. It is currently unset in every environment,
  which is why the board is invisible in staging today.
- `OPS_WRITE_ENABLED` — must be `true` for the Refund/Deny buttons to render. Read-only without
  it. (Ships in PR #137.)

Non-admins get a 404 that is byte-identical to a missing route — never a 403 — so the surface
never confirms it exists.

**To add yourself**, get your UUID (not your phone) and set the variable:

```sql
select id, first_name, last_name, phone from public.users where phone = '<your number>';
```

**What the panels mean:** open transfers with dwell against the pager's own thresholds; the float
ceiling (live); transfer counts by state; ledger balances as of the last reconciliation run (a
snapshot, hence the "as of"); the latest reconciliation findings; and the pending-cancellation
queue with Refund / Deny.

**Deny requires evidence**: Bridge's deposit timestamp, typed in, with an explicit timezone. The
form rejects a timezone-less value, because a bare local time would silently shift the evidence
by your UTC offset. An *earlier*-than-real timestamp makes a wrongful denial more likely — that
warning is on screen for a reason.

Trigger a reconciliation run by hand to populate the balances panel:

```bash
node --env-file=<env> --import tsx -e \
  "import {reconcileLedger} from './src/jobs/ledger-reconcile.ts'; console.log(await reconcileLedger())"
```

---

## 8. Production: what you can and cannot do

**Production is deliberately inert.** Do not plan a demo there.

- `MOCK_FUNDING_WEBHOOK_SECRET` is absent in prod **on purpose** — its absence makes the funding
  webhook and confirm return 503. That is the production lock against fake funding.
- There are no Stripe keys, and `FUNDING_PROCESSOR` defaults to `mock`.

Together: **no transfer can be funded in production today.** Read-only inspection is safe;
nothing else is possible.

**Safe in prod:** the ops board once you allowlist yourself (read-only until `OPS_WRITE_ENABLED`),
the reconciliation runbook queries, Sentry.

**To make prod capable of real money**, in order: Stripe keys in Doppler → flip
`FUNDING_PROCESSOR=stripe` → treasury wallet + `DATABASE_URL` + `FLOAT_CEILING_MINOR` for the
worker → Bridge webhook keys → merge and promote PR #137 if you want ops actions. Each is a
deliberate gate, not an oversight.

**Changing ops admins in staging/prod:** Doppler → project `puente-api` → config `stg_main` /
`prd_main` → set `OPS_ADMIN_USER_IDS` (and `OPS_WRITE_ENABLED`) → **restart the Railway service**.
The allowlist is read at boot, so a redeploy or restart is mandatory.

---

## 9. Honest status of the payment side

The Stripe adapter is written, merged, and unit-tested — and **has never made a single real API
call.** The 29 tests construct the SDK with a dummy key and never touch the network. Genuinely
verified: webhook signature checking (real HMAC), event→state mapping, void-vs-refund logic, and
the not-configured lock. Never executed: creating a PaymentIntent, cancelling one, issuing a
refund, and the Payment Element. That whole surface is unproven until sandbox keys exist.

Everything in this guide that says "verified" used the **mock** funding processor plus the real
Bridge sandbox.
