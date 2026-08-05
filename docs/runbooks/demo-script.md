# Screen-record demo — shooting script

Every beat below was executed on 2026-08-03 against the real local stack, live Bridge sandbox,
real ledger. Total runtime ≈ 6 minutes at a comfortable pace.

## Pre-flight (do this BEFORE you hit record)

1. **Reset** — `bash demo-reset.sh` (~36 s). Clean database, seeded user, API restarted with you
   on the ops allowlist.
2. **Check the sandbox wallet.** Payouts draw real sandbox USDC. Top up if below ~$20:
   ```bash
   curl -X POST "https://api.sandbox.bridge.xyz/v0/customers/d4305c9a-8226-4972-a429-6710ad41f0c5/wallets/4a810de0-aa50-443b-9ce9-647f8844ed29/simulate_deposit" \
     -H "Api-Key: $BRIDGE_API_KEY" -H "Content-Type: application/json" \
     -H "Idempotency-Key: $(uuidgen)" -d '{"amount":"50.00","currency":"usdc"}'
   ```
3. **Four processes up**: Supabase, API (:3001), worker (:3002), web (:3000).
   The API env **must** include `DATABASE_URL` — without it, Bridge events take 5 minutes to
   process instead of 2 seconds, and your take will stall on camera.
4. **Windows**: browser at 1280×800, one terminal for SQL, one for the webhook commands. Keep the
   terminals off-camera until the ledger beat.

**Keep the send amount small — $5 to $10.** The payout is a real sandbox draw.

---

## Act 1 — the product (≈2 min)

| Beat | Do | Say |
|---|---|---|
| Sign in | 500 555 0006 → 123456 | "Phone-first, SMS OTP. Spanish is the default — our users are Spanish-speaking." |
| Dashboard | — | "This account is verified; KYC ran through Bridge." |
| Quote | Rosa Santos, **$5** → Obtener cotización | "That rate is live from Bridge, right now. The fee and the rate lock for 15 minutes." |
| Disclosure | Continuar | "This is the federally required pre-payment disclosure. Rendered in Spanish, with the exact rate — not a rounded one." |
| Confirm | tick box → Confirmar | "They have to actively accept it. That acceptance is recorded." |
| Tracker | — | "Five states. Right now we're waiting on payment — and nothing has moved in our books yet." |

**Optional strong beat:** show the ledger is empty for this transfer *before* payment:
```sql
select count(*) from public.ledger_entries e
  join public.ledger_transactions lt on lt.id = e.ledger_transaction_id
 where lt.transfer_id = '<id>';
```
→ `0`. "An abandoned checkout moves no money and leaves no accounting."

---

## Act 2 — money moves (≈2 min)

| Beat | Do | Say |
|---|---|---|
| Pay | **Simular pago** | "Standing in for the card/bank step — everything downstream is real." |
| Ledger posts | run the batch query | "First accounting entry. Debit what the customer owes us, credit what we owe the recipient, credit our fee. It balances." |
| Payout | (worker picks it up within ~60 s) | "Our worker just called Bridge and bought MXN. That's a real sandbox payout with a real transfer id." |
| Delivered | fire the webhook | "Bridge tells us it landed. Two seconds later the transfer is complete." |

```bash
# ledger for one transfer
docker exec -i supabase_db_goyfagidfkjyhyepsaup psql -U postgres -d postgres -c "
select lt.transition, a.code, e.direction, e.amount_minor
  from public.ledger_entries e
  join public.ledger_transactions lt on lt.id = e.ledger_transaction_id
  join public.ledger_accounts a on a.id = e.account_id
 where lt.transfer_id = '<id>' order by lt.created_at, e.direction desc;"

# delivery (BID = provider_transfer_ref from the transfers table)
export BRIDGE_WEBHOOK_PRIVATE_KEY="$(cat bridge_webhook_private.pem)"
node --import tsx scripts/fire-bridge-webhook.ts <id> <BID> payment_processed --url http://localhost:3001
```

Then show the **receipt** in the UI. That's the customer story closed.

---

## Act 3 — the part nobody demos (≈1.5 min)

This is the differentiator. Two commands.

**1. The books can't be rewritten.**
```bash
docker exec -i supabase_db_goyfagidfkjyhyepsaup psql -U postgres -d postgres -c "delete from public.ledger_entries;"
```
```
ERROR: ledger is append-only: DELETE on ledger_entries is not allowed;
       post a correcting transaction instead
```
> "There is no code path, and no human, that can delete a ledger entry. The database itself refuses."

**2. Every batch balances.**
```bash
docker exec -i supabase_db_goyfagidfkjyhyepsaup psql -U postgres -d postgres -c "
select lt.transition,
       sum(case when e.direction='debit' then e.amount_minor else -e.amount_minor end) as net
  from public.ledger_entries e
  join public.ledger_transactions lt on lt.id = e.ledger_transaction_id
 group by lt.id, lt.transition;"
```
Every row `0`. > "Funding, payout, delivery — every batch nets to zero. Balances are summed from
entries, never stored in a field someone can edit."

---

## Act 4 — ops (≈45 s)

Go to `/dashboard/ops` (type it — there's no link).

> "There's no navigation to this page and it 404s for everyone who isn't on an explicit allowlist —
> not a 403, a 404, so it doesn't even admit it exists. This is where I see what needs a human:
> transfers sitting too long, the float ceiling, and cancellation requests I have to decide."

If you want the cancellation beat: cancel a transfer *after* the payout is claimed → HTTP 202 →
the row appears in the pending queue with Refund / Deny.

---

## Between takes

- `bash demo-reset.sh` for a clean slate.
- The per-user cap blocks a second send while the first is unsettled — clear it with
  `fire-funding-webhook.ts <id> cleared`, or just reset.

## If something goes wrong on camera

| Symptom | Cause | Fix |
|---|---|---|
| Quote fails | Bridge sandbox hiccup or expired rate | Retry; rates refresh ~30 s |
| Stuck at FUNDED >90 s | worker not running, or a hold | check worker log; `payout_hold_reason` |
| `transfer_in_progress` | uncleared cap | fire `cleared` on the previous transfer |
| Payout 400 | wallet drained | top up (pre-flight step 2) |
| Stuck at SUBMITTED | API missing `DATABASE_URL` | add it and restart — otherwise 5-min wait |
| Ops page 404s | you're not on the allowlist | `OPS_ADMIN_USER_IDS` + restart API |
