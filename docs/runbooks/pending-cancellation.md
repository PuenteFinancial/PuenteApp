# Runbook — Pending Cancellation Request

**Date:** 2026-07-28 · **Status:** live process (slice 7 PR6b)

A sender asked to cancel a transfer that was **already on its way to payout**. We could not stop it,
so we recorded the ask. This runbook is how that ask gets resolved.

Background: [transfer-state-machine.md](../transfer-state-machine.md) (post-submission cancellation),
[decisions.md](../decisions.md) 2026-07-28, [ledger-rules.md](../ledger-rules.md).

## The rule you are enforcing

**§1005.34 cancellation is not §1005.33 error resolution.** There is nothing to investigate — only
two facts to establish. The refund is owed only when **both** of §1005.34's conditions held at the moment the sender asked:

- **In window** (`within_window = true`) — asked within 30 minutes of paying, **and**
- **Before the deposit** — the funds had not yet reached the recipient when they asked.

If the payout **failed**, the refund tail already made them whole either way. If it **delivered**:
a request that met both conditions is owed the full refund even though the recipient keeps the
money — that double-pay is deliberate and accepted, the price of the statutory right, and on our
rail it is confined to the seconds between submission and SPEI deposit. A request failing either
condition is owed **nothing** — but **denial is never automatic**: a human denies it on the record,
with the evidence for whichever condition failed (our `cancelable_until` for the clock; **Bridge's
deposit timestamp** for the deposit).

**Never do this with SQL.** A bare `UPDATE ... set status = 'resolved_refunded'` closes the request
without paying anyone and without posting the correction batch — the books would say we refunded a
sender whose bank would disagree. `scripts/resolve-cancellation.ts` runs the same `services/` code
the rest of the system runs, through the ledger RPC.

## The alerts

All fingerprinted per transfer, so repeated re-drives collapse into one issue.

| Fingerprint | Severity | Means | Go to |
|---|---|---|---|
| `cancellation-correction-owed` | **error** | an in-window request that **beat the deposit** on a delivered transfer; it is now `UNDER_REVIEW` and a full refund is owed | [Refund](#refund) — **3 business days** |
| `cancellation-after-deposit` | warning | in-window by the clock, but our evidence says the **deposit came first** — nothing is owed | confirm the exact deposit time in the Bridge dashboard, then [Deny](#deny) with it |
| `cancellation-out-of-window` | warning | an out-of-window request on a delivered transfer; it stayed `COMPLETED` | [Deny](#deny) |
| `cancellation-record-failed` | **error** | the sender asked and we **failed to persist it**; they still got their 202 | [Record it by hand](#a-request-that-was-never-recorded) |
| `cancellation-resolve-failed` | **error** | a refund settled but its request did not close | usually self-heals on the next run through that transfer; check `--list` |
| `cancellation-route-failed` | **error** | we could not evaluate a delivered transfer's pending request at all | check `--list` for that transfer |

## 1. Triage — what is open?

```bash
doppler run -- pnpm exec tsx scripts/resolve-cancellation.ts --list
```

Read-only. Every open request, with the fact that decides the exit:

- **`⚠ IN-WINDOW — owed IF it beat the deposit`** — check which alert fired for the transfer:
  `cancellation-correction-owed` → [Refund](#refund); `cancellation-after-deposit` → confirm the
  deposit time in Bridge, then [Deny](#deny).
- **`out-of-window — deny with evidence (--deny)`** — go to [Deny](#deny).
- **`[disbursement already recorded]`** — a previous run paid the sender but did not settle the
  state. Re-running `--refund` finishes it and disburses nothing further.

Ids, amounts and timestamps only — never recipient names or destination details.

## 2. Dry run

```bash
doppler run -- pnpm exec tsx scripts/resolve-cancellation.ts <transferId> --operator <your-id> --refund
```

**Dry run is the default.** Without `--confirm` nothing is written. `--operator` is required and is
recorded as `ops:<id>` on the transition and as `resolved_by` on the request — jobs and scripts write
no audit-plugin rows, so this is the only durable record of who decided. Use your own handle
(`^[a-z0-9._-]{2,32}$`), never a shared one.

<a id="refund"></a>
## 3a. Refund — a request that beat the deposit

```bash
doppler run -- pnpm exec tsx scripts/resolve-cancellation.ts <transferId> --operator <your-id> --refund --confirm
```

This pays the sender **send + fee** as a **correction payment** and settles `UNDER_REVIEW → REFUNDED`.
The recipient is not contacted and does not give anything back.

The ledger books `DR loss_cancellation_correction / CR cash_clearing` — a **new expense against
Puente**, not a reversal. The original `COMPLETED` entries are untouched; we never rewrite delivered
history. That account exists specifically so this cost is separable from ACH-return losses.

**Deadline: 3 business days** from `requested_at` (not from when the alert fired).

| Refusal | What it means | What to do |
|---|---|---|
| `not_under_review` | the transfer is not parked for review | check the id. Paying a plain `COMPLETED` transfer would be an unreviewed double payment on a delivery nobody contested |
| `no_pending_request` | no open ask on this transfer | the request is the *authority* for the payment; without one, paying is a gift of company money with no record of why |
| `claim_taken` | another run is refunding this transfer right now | wait, re-check `--list` |
| `claim_abandoned` | a refund was claimed and never completed — **the sender may already have been paid** | stop. Follow [manual-refund.md](manual-refund.md) → *Abandoned claims* before doing anything else |

<a id="deny"></a>
## 3b. Deny — a request that failed either condition

Two lawful grounds, and the tool checks them:

- **Out of window** — provable from our own `cancelable_until` (`--list` shows it).
- **Deposit preceded the request** — the common case on an instant rail. Provable **only** from
  Bridge's deposit timestamp, so `--deposited-at` is **load-bearing**: the service compares it to
  `requested_at` and refuses the denial if the request came first. A wrong-but-earlier timestamp can
  only make the tool refuse more, never deny more.

You need Bridge's **deposit timestamp** first. It is not available from our API
(`getBridgeTransfer` returns only id/state/sourceAmount) — read it from the Bridge dashboard.

```bash
doppler run -- pnpm exec tsx scripts/resolve-cancellation.ts <transferId> --operator <your-id> \
  --deny --deposited-at 2026-07-28T10:00:00Z --confirm
```

The transfer returns to `COMPLETED` (or stays there, if it was never routed), no ledger is posted, and
the request closes `resolved_denied` with your evidence in both the resolution text and the transition
metadata.

**The tool will refuse to deny a request that was in-window AND beat the deposit** — both statutory
conditions held, so the refund is owed. That is not a bug to work around. If you believe such a
request must not be paid, escalate — do not reach for another tool.

## 4. Verify

```sql
select status, resolution, resolved_by, resolved_at
  from public.cancellation_requests where transfer_id = '<transfer-id>';

select from_state, to_state, actor, created_at
  from public.transfer_transitions where transfer_id = '<transfer-id>' order by created_at;
```

For a refund, also confirm the correction batch landed and nets to zero:

```sql
select t.transition, t.idempotency_key,
       sum(case when e.direction = 'debit' then e.amount_minor else -e.amount_minor end) as net
  from public.ledger_entries e
  join public.ledger_transactions t on t.id = e.ledger_transaction_id
 where t.transfer_id = '<transfer-id>'
 group by t.id, t.transition, t.idempotency_key;
```

## A request that was never recorded

`cancellation-record-failed` means the sender exercised a statutory right and our write failed. They
received their 202, so **they believe the request is in** — and they are entitled to that. Recreate it
promptly: the row is the evidence, and `requested_at` is the clock. Use the alert's timestamp as the
ask time, and note in `resolution` that it was reconstructed after a persistence failure.

## Cross-references

- An `in_review` **Bridge** state is a different thing entirely — Bridge's own AML hold on a payout,
  covered in [payout-holds.md](payout-holds.md). It has nothing to do with our `UNDER_REVIEW`.
- The `PAYOUT_FAILED → REFUNDED` tail, its claim, and abandoned claims: [manual-refund.md](manual-refund.md).
