# Manual funding — the complete operator run

The operator run for one real transfer under `FUNDING_PROCESSOR=manual`, in order.
Since funding-ops slice 3 the run is **taps on `/dashboard/ops`** — onramp creation and
instruction attach happen automatically at confirm, and the two human actions (release,
deposit-landed) are buttons. Companion prose: `driving-the-product.md` §8.

First written 2026-08-18 after the staging dry run (transfer `56750902`, onramp `f75481cb`)
proved each step as a CLI run; the commands survive in the break-glass appendix — the recovery
path when the web is what's broken (decisions.md 2026-07-27).

---

## 0. Pre-flight (once per environment)

The §8 go-live checklist in `driving-the-product.md`: worker beating, Bridge
`transfer` webhook subscribed with the current public key, ops allowlist +
`OPS_WRITE_ENABLED`, PostHog `web-send-money` on, float topped up and recorded,
and — last — `FUNDING_PROCESSOR=manual`.

Relevant knobs: `MANUAL_PENDING_MAX_AGE_DAYS` (default 7) is how long a confirmed
transfer may wait for its deposit before the sweep declares it abandoned.
`BRIDGE_TREASURY_WALLET_ID` is required under `manual` (env refuses to boot without it —
the auto-created onramp deposits there).

**Size the send under the float.** Release draws ≈ the transfer total from the treasury
wallet immediately — the sender's deposit reimburses it later. If the total exceeds the
current wallet balance, the submit loops on drained-wallet 400s until money arrives. Check
the balance first (the ops board's ledger balances, or the Bridge dashboard) and keep the
send comfortably under it, or top up first (the ops board's top-up card).

---

## 1. Sender confirms (their side)

Web flow: recipient → quote → review → confirm. The transfer sits `PENDING_PAYMENT`.

---

## 2. Deposit coordinates — automatic at confirm

Confirm enqueues `funding.onramp_prepare`; the worker creates the Bridge onramp
(`Idempotency-Key: onramp-<transferId>`, `client_reference_id` = the transfer id, amount =
the total to the cent, destination = the treasury wallet) and attaches its coordinates with
system attribution (`attached_by` null). The sender's pay step renders them — bank, routing,
account, amount, **reference code** — typically seconds after confirm (the tracker polls
every 5 s).

**Verify on the ops board:** the open-transfer row shows an onramp ref once instructions are
attached. A row still without instructions a few minutes after confirm means the job is
retrying (Bridge down) or dead-ended (Sentry has an `onramp-prepare-*` page naming the
reason). Recovery is the row's **Attach instructions** button: create the onramp by hand
(appendix A.1) and paste its id — attach pulls the coordinates from Bridge, never hand-typed.

Refusals mean what they say: `amount_mismatch` = wrong onramp id;
`instructions_unavailable` = that id is a payout or has no coordinates yet;
`not_pending_payment` = the transfer already moved (or was swept — check its age
against `MANUAL_PENDING_MAX_AGE_DAYS`).

---

## 3. Sender pays

At their bank, with the reference code. **Release policy (Joshua, 2026-08-18):**
the payout may be released once you have satisfactory evidence the sender's ACH was
**initiated** — you do not have to wait for arrival. The pre-funded-float model
carries the settlement risk (payout draws YOUR float; the deposit reimburses it),
bounded by the uncleared-exposure cap. An initiated ACH can still fail — that tail
is `FUNDING_REVERSED` territory and it lands on Puente.

**The sender's claim (slice 4).** When the sender taps "I've sent the payment" on the
pay step, the board row grows a *"sender says payment sent — verify & release"*
annotation and one Sentry info event fires (fingerprint `payment-claim`,`<transfer id>`)
as the phone ping. The claim is a SIGNAL, never evidence: verify the deposit at Bridge
(onramp activity for the row's ref) before releasing. A claim with no matching Bridge
activity after a day is a conversation with the sender, not a release.

---

## 4. Release the payout

The row's **Release payout** button. The confirm step restates the total and the release
policy line; the action is `POST /v1/ops/transfers/funding` with `kind: funded`, idempotency-
keyed. `PENDING_PAYMENT → FUNDED`, the FUNDED ledger batch posts (receivable / payable /
`fee_revenue` from margin), and the worker submits the Bridge payout within ~60s. From there
everything is automatic: SPEI delivery, webhooks, `COMPLETED`, receipt.

Watch it: the sender's tracker, or the ops board. Expect `SUBMITTED` in ~1 minute.

---

## 5. When the deposit actually lands

The row's **Deposit landed** button, when the onramp shows funds arrived / the wallet
balance rises — the books record **arrival**, not intent. One tap does both books
(`POST /v1/ops/transfers/deposit-landed`): `cleared` settles the funding receivable to
cash, and the float top-up books the cash into `bridge_wallet_float`, because the deposit
physically landed in the wallet. The pair nets `cash_clearing` to zero and keeps the
wallet-float reconciliation clean. Both legs are idempotent on the onramp ref — a re-tap
after a partial failure heals rather than double-counts.

The ref prefills from the attached instructions and must match them (a cross-transfer ref
typo would consume another transfer's top-up — the endpoint 409s instead).

Out-of-band wallet deposits that belong to no transfer (e.g. a float prefund) are the
ops board's **top-up card** instead (`POST /v1/ops/treasury/float-topup`).

---

## 6. Aftermath

- Reconciliation stays clean: auto-created onramps carry `client_reference_id`, so the
  `bridge_orphans` check resolves them to their transfer. A persistent orphan is once
  again a true anomaly (`reconciliation.md`).
- The onramp's own webhook events (`payment_processed` when the deposit lands, `returned`
  on an ACH return) are recorded and **ignored** by the payout pipeline — the slice-3
  guard (`payment-event-process.ts`) keeps them out of the payout state machine. Acting
  on them (auto-clear) is deferred slice 5; today the Deposit-landed tap stays the record
  of arrival.
- Never fix anything here with bare SQL — every state change goes through the ops routes
  or the appendix scripts, which post the ledger batches atomically.
- Stuck or failed anywhere: `stuck-transfer.md`, `payout-holds.md`, `manual-refund.md`.

---

## Appendix — break-glass CLI

The pre-slice-3 run, kept as the recovery path when the dashboard or the auto-onramp is
what's broken. All commands run from `apps/api` on an up-to-date `main`, wrapped in Doppler:

```bash
cd apps/api && git pull
# staging:  doppler run -p puente-api -c stg_main -- …
# prod:     doppler run -p puente-api -c prd_main -- …
```

Every write script is **dry-run by default** — it prints what it would do and exits.
Add `--confirm` only after the dry run looks right. `<operator>` is YOUR user uuid
(the one in `OPS_ADMIN_USER_IDS`); it is the durable record of who acted.

### A.1 Create the Bridge onramp by hand

Amount must equal the transfer's total **to the cent** — the attach step refuses a mismatch
rather than point the sender's money at a deposit Bridge can't match.

**Primary: Bridge dashboard** — create a transfer with source `wire`/`ach` USD,
destination = the treasury wallet, `on_behalf_of` = the sender's Bridge customer.

**Alternative: API.** First look up the sender's `bridge_customer_id` and the exact
total off the transfer:

```bash
doppler run -p puente-api -c stg_main -- node_modules/.bin/tsx -e "
import { Client } from 'pg'
const c = new Client({ connectionString: process.env.DATABASE_URL })
await c.connect()
const r = await c.query(\`select u.bridge_customer_id, t.send_amount_minor + t.fee_amount_minor as total_minor
  from public.transfers t join public.users u on u.id = t.user_id where t.id = '<transferId>'\`)
await c.end()
console.log(r.rows[0])
"
```

Then create the onramp (`amount` = `total_minor / 100`, to the cent):

```bash
doppler run -p puente-api -c stg_main -- sh -c 'curl -s -X POST "$BRIDGE_API_BASE/v0/transfers" \
  -H "Api-Key: $BRIDGE_API_KEY" \
  -H "Idempotency-Key: onramp-<transferId>" \
  -H "Content-Type: application/json" \
  -d "{
    \"amount\": \"<total, e.g. 57.00>\",
    \"on_behalf_of\": \"<bridge_customer_id>\",
    \"developer_fee\": \"0\",
    \"source\": { \"payment_rail\": \"ach_push\", \"currency\": \"usd\" },
    \"destination\": { \"payment_rail\": \"base\", \"currency\": \"usdc\", \"bridge_wallet_id\": \"$BRIDGE_TREASURY_WALLET_ID\" },
    \"client_reference_id\": \"<transferId>\"
  }"'
```

Gotchas learned live (staging dry run + first prod run, 2026-08-18):

- The destination `payment_rail` is the **chain name** (`base`), not `bridge_wallet`.
- **`BRIDGE_API_BASE` is UNSET in prd Doppler** — the app defaults it in
  `config/env.ts`, but your shell doesn't. For prod curls use the literal
  `https://api.bridge.xyz` (or `${BRIDGE_API_BASE:-https://api.bridge.xyz}`).
  A "wrong environment" credentials error means base/key mismatch.
- Bridge documents `developer_fee` as required — send `"0"`.
- `amount` is a plain decimal string (`"5.00"`), never `$`-prefixed or empty.
  Match the app's 2dp formatting exactly if the auto-job may also run — same
  `Idempotency-Key` + different body is a Bridge 422 (the job pages
  `onramp-prepare-conflict` and stands down when it hits one you created first).
- Paste the curl as ONE line if editing by hand: a blank line after a `\`
  continuation ends the command and the next `-H` executes as a command.
- Note the returned onramp `id` — and it is NOT `provider_transfer_ref` (that
  is the separate Bridge payout id the worker creates later).

### A.2 Attach the deposit instructions

```bash
doppler run -p puente-api -c stg_main -- node_modules/.bin/tsx scripts/attach-deposit-instructions.ts \
  <transferId> --bridge-transfer <onrampId> --operator <operator>
```

Dry run prints the coordinates (account masked). Re-run with `--confirm` to attach.
Re-attaching overwrites — do that if you had to recreate the onramp.

### A.3 Release the payout

```bash
doppler run -p puente-api -c stg_main -- node_modules/.bin/tsx scripts/record-manual-funding.ts \
  <transferId> --kind funded --ref <onrampId> --amount <total, e.g. 57.00> --operator <operator>
```

Dry run, then `--confirm`. On success it prints the outcome and **exits in seconds** (#196).

### A.4 Record the landed deposit

Two commands, same ref:

```bash
doppler run -p puente-api -c stg_main -- node_modules/.bin/tsx scripts/record-manual-funding.ts \
  <transferId> --kind cleared --ref <onrampId> --amount <total> --operator <operator> --confirm
```

```bash
doppler run -p puente-api -c stg_main -- node_modules/.bin/tsx scripts/record-float-topup.ts \
  --amount <total> --ref <onrampId> --confirm
```

Both are idempotent on the ref — re-running is a no-op, never a double-count, and either
order against the deposit-landed button is safe (shared ref).
