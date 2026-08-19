# Manual funding — the complete operator run

Every command for one real transfer under `FUNDING_PROCESSOR=manual`, in order.
Written 2026-08-18 after the staging dry run (transfer `56750902`, onramp `f75481cb`)
proved each step. Companion prose: `driving-the-product.md` §8.

All commands run from `apps/api` on an up-to-date `main`, wrapped in Doppler:

```bash
cd apps/api && git pull
# staging:  doppler run -p puente-api -c stg_main -- …
# prod:     doppler run -p puente-api -c prd_main -- …
```

Every write script is **dry-run by default** — it prints what it would do and exits.
Add `--confirm` only after the dry run looks right. `<operator>` is YOUR user uuid
(the one in `OPS_ADMIN_USER_IDS`); it is the durable record of who acted.

---

## 0. Pre-flight (once per environment)

The §8 go-live checklist in `driving-the-product.md`: worker beating, Bridge
`transfer` webhook subscribed with the current public key, ops allowlist +
`OPS_WRITE_ENABLED`, PostHog `web-send-money` on, float topped up and recorded,
and — last — `FUNDING_PROCESSOR=manual`.

Relevant knobs: `MANUAL_PENDING_MAX_AGE_DAYS` (default 7) is how long a confirmed
transfer may wait for its deposit before the sweep declares it abandoned.

**Size the send under the float.** `--kind funded` releases a payout that draws
≈ the transfer total from the treasury wallet immediately — the sender's deposit
reimburses it later. If the total exceeds the current wallet balance, the submit
loops on drained-wallet 400s until money arrives. Check the balance first
(Bridge dashboard, or the ops board's ledger balances) and keep the send
comfortably under it, or top up first.

---

## 1. Sender confirms (their side)

Web flow: recipient → quote → review → confirm. The transfer sits `PENDING_PAYMENT`.

**Get the transfer id** from the ops board (`/dashboard/ops`, Open transfers), or
from the sender's tracker URL (`/dashboard/send/<transferId>`).

---

## 2. Create the Bridge onramp

The deposit target. Amount must equal the transfer's total **to the cent** — the
attach step refuses a mismatch rather than point the sender's money at a deposit
Bridge can't match.

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
    \"amount\": \"<total, e.g. 57.0>\",
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
- Paste the curl as ONE line if editing by hand: a blank line after a `\`
  continuation ends the command and the next `-H` executes as a command.
- Note the returned onramp `id` — and it is NOT `provider_transfer_ref` (that
  is the separate Bridge payout id the worker creates later).

---

## 3. Attach the deposit instructions

Pulls the coordinates from the onramp and stores them on the transfer; the sender's
pay step renders them (bank, routing, account, amount, **reference code**).

```bash
doppler run -p puente-api -c stg_main -- node_modules/.bin/tsx scripts/attach-deposit-instructions.ts \
  <transferId> --bridge-transfer <onrampId> --operator <operator>
```

Dry run prints the coordinates (account masked). Re-run with `--confirm` to attach.
Re-attaching overwrites — do that if you had to recreate the onramp.

Refusals mean what they say: `amount_mismatch` = wrong onramp id;
`instructions_unavailable` = that id is a payout or has no coordinates yet;
`not_pending_payment` = the transfer already moved (or was swept — check its age
against `MANUAL_PENDING_MAX_AGE_DAYS`).

---

## 4. Sender pays

At their bank, with the reference code. **Release policy (Joshua, 2026-08-18):**
the payout may be released once you have satisfactory evidence the sender's ACH was
**initiated** — you do not have to wait for arrival. The pre-funded-float model
carries the settlement risk (payout draws YOUR float; the deposit reimburses it),
bounded by the uncleared-exposure cap. An initiated ACH can still fail — that tail
is `FUNDING_REVERSED` territory and it lands on Puente.

---

## 5. Release the payout

```bash
doppler run -p puente-api -c stg_main -- node_modules/.bin/tsx scripts/record-manual-funding.ts \
  <transferId> --kind funded --ref <onrampId> --amount <total, e.g. 57.00> --operator <operator>
```

Dry run, then `--confirm`. On success it prints the outcome and **exits in seconds**
(#196). `PENDING_PAYMENT → FUNDED`, the FUNDED ledger batch posts (receivable /
payable / `fee_revenue` from margin), and the worker submits the Bridge payout
within ~60s. From here everything is automatic: SPEI delivery, webhooks,
`COMPLETED`, receipt.

Watch it: the sender's tracker, or the ops board. Expect `SUBMITTED` in ~1 minute.

---

## 6. When the deposit actually lands

Two commands, same ref, run when the onramp shows funds arrived / the wallet
balance rises — the books record **arrival**, not intent:

```bash
doppler run -p puente-api -c stg_main -- node_modules/.bin/tsx scripts/record-manual-funding.ts \
  <transferId> --kind cleared --ref <onrampId> --amount <total> --operator <operator> --confirm
```

```bash
doppler run -p puente-api -c stg_main -- node_modules/.bin/tsx scripts/record-float-topup.ts \
  --amount <total> --ref <onrampId> --confirm
```

`cleared` settles the funding receivable to cash; the top-up books the cash into
`bridge_wallet_float`, because the deposit physically landed in the wallet. The pair
nets `cash_clearing` to zero and keeps the daily wallet-float reconciliation clean.
Both are idempotent on the ref — re-running is a no-op, never a double-count.

---

## 7. Aftermath

- Daily reconciliation should be clean, except the onramp appears as a
  `bridge_orphans` finding (known gap: the check doesn't yet excuse recorded
  deposits/top-ups).
- Never fix anything here with bare SQL — every state change goes through the
  scripts above or the ops routes, which post the ledger batches atomically.
- Stuck or failed anywhere: `stuck-transfer.md`, `payout-holds.md`,
  `manual-refund.md`.
