# Runbook — Manual Refund (`AUTO_REFUND` off)

**Date:** 2026-07-27 · **Updated:** 2026-07-28 (slice 7 PR6b-0 — the refund claim, `--reclaim`)
· **Status:** live process

`AUTO_REFUND` is **off in production** by design ([decisions.md](../decisions.md) 2026-07-21): a real
payout failure stops at `PAYOUT_FAILED` and a human decides. This runbook is how that human returns
the money. Background: [transfer-state-machine.md](../transfer-state-machine.md),
[ledger-rules.md](../ledger-rules.md) ("Bridge returns principal").

**Never do this with SQL.** A bare `UPDATE ... set state = 'REFUNDED'` marks the transfer refunded
without posting the two ledger batches and **without returning any money to the sender** — the books
would say we refunded them and their bank would disagree. `scripts/trigger-refund.ts` runs the same
`services/refunds.ts` code the automated path runs, through the ledger RPC.

## The alerts

Sentry, fingerprint `payout-refund-gated`, severity **warning**:

> payout failed, principal returned — AUTO_REFUND off, manual refund required

Context carries `transferId`, `bridgeState`, and a pointer back to this file. No PII.

There is a second, rarer one — fingerprint `payout-refund-claim-abandoned`, severity **error**:

> refund claim abandoned — a disbursement may have gone out; ops must confirm before reclaiming

It carries `transferId`, `claimedAt`, `claimedBy`. `error`, matching `payout-refund-refused` rather
than the routine `payout-refund-gated` warning, because both mean a sender may still be owed.

It fires only with `AUTO_REFUND` **on**; with the flag off the job never reaches the refund tail, so
`--list` is where abandoned claims show up. It **keeps firing** until the situation is resolved: a
claim refusal does not retire the payment event, so `payout.sweep` re-drives it every 5 minutes and
re-raises the alert (Sentry dedupes on the fingerprint). Once you `--reclaim` and the transfer settles,
the next re-drive resolves the event and the alert stops. See [Abandoned claims](#abandoned-claims).

Note the poller does **not** clear these: with `AUTO_REFUND` off it skips `PAYOUT_FAILED` rows
entirely. Turning the flag on later does *not* heal a row whose terminal `returned`/`refunded` event
was **already recorded** while the flag was off — `recordEvent` dedupes the re-synthesis
([payout-poll.ts](/apps/api/src/jobs/payout-poll.ts)). A row still awaiting its first terminal event
(the `no_return_event` refusal below) *would* be driven normally once the flag is on. So the rows this
runbook exists for — the ones the interlock actually clears — are human-owned.

## Running the script

It imports `src/services/*`, so `config/env.ts` validates the whole environment and exits if anything
is missing (`SUPABASE_*`, `BRIDGE_API_KEY`, …).

```bash
doppler run -- pnpm exec tsx scripts/trigger-refund.ts --list
```

Locally, the `dev:e2e` precedent works too:
`node --env-file=.env --import tsx scripts/trigger-refund.ts …`

### 1. Triage — what is parked?

```bash
doppler run -- pnpm exec tsx scripts/trigger-refund.ts --list
```

Read-only. Prints every transfer at `PAYOUT_FAILED` whose payout was submitted — ids, amounts and
timestamps only, never recipient details. This is the whole human backlog.

A row marked **`⚠ ALREADY DISBURSED — needs settling only`** is the crash case: a previous run paid
the sender but died before posting `{id}:REFUNDED`, so the money is gone while `transfer_payable`
stays open and **the ledger is currently wrong about that transfer**. Treat it as urgent. Re-running
the normal `--confirm` below finishes it and disburses nothing further (step 2 will say "the
disbursement had already gone out").

Rows also carry their **refund claim**, which is what stops two runs paying the sender twice:

| Marker | Meaning | What to do |
|---|---|---|
| *(none)* | unclaimed | proceed normally |
| **`⏳ claim in progress by … since …`** | a run is disbursing **right now** | **nothing.** Wait and re-run `--list`; it should settle on its own. This is healthy, not an incident. |
| **`⚠ CLAIM ABANDONED by … at …`** | a run took the claim over 30 minutes ago and never recorded a disbursement | see [Abandoned claims](#abandoned-claims) — **do not reclaim before reading it** |

### 2. Dry run — check the interlock

```bash
doppler run -- pnpm exec tsx scripts/trigger-refund.ts <transferId> --operator <your-id>
```

**Dry run is the default.** Without `--confirm` nothing is written. `--operator` is required and is
recorded as the actor `ops:<id>` on the transition — jobs and scripts write no audit-plugin rows, so
`transfer_transitions.actor` is the only durable record of who triggered a refund. Use your own
handle (`^[a-z0-9._-]{2,32}$`), never a shared one.

The script refuses unless **both** of these agree that Bridge returned the principal:

1. a terminal `returned` / `refunded` row in `payment_events` for the transfer, **and**
2. a live Bridge `GET` on the transfer reporting the same.

This matters because the `bridge_return` batch books `DR cash_clearing / CR due_from_bridge` — it
*asserts* Bridge sent our cash back. If that assertion is wrong the books claim cash we do not hold.
`undeliverable` / `error` / `canceled` do **not** mean the principal came back, and `refund_in_flight`
means it is still on its way — wait for the terminal event.

| Refusal | What it means | What to do |
|---|---|---|
| `no_return_event` | we never recorded a terminal return for this transfer | check the Bridge dashboard; if Bridge genuinely returned it, find out why our webhook/poller missed it before refunding |
| `bridge_disagrees` (`bridge=refund_failed`) | the principal is **stuck at Bridge** | **escalate — do not refund.** See below. |
| `bridge_disagrees` (other) | our event and Bridge's live state conflict | investigate; never override |
| `not_submitted` | never sent to Bridge — Bridge holds nothing of ours | wrong runbook; this is not a payout failure |
| `not_payout_failed` | the transfer is not parked at `PAYOUT_FAILED` | check the id. **A `COMPLETED` transfer must never be reversed here.** |
| `transfer_not_found` | no transfer with that id | check the id against `--list` |
| `claim_taken` | another run holds a live refund claim and is disbursing now | **wait.** Nothing was written. Re-check `--list`; do not reach for `--reclaim` — a healthy in-flight refund is not stuck |
| `claim_abandoned` | a claim over 30 minutes old that never recorded a disbursement | see [Abandoned claims](#abandoned-claims) below |

### 3. Execute

```bash
doppler run -- pnpm exec tsx scripts/trigger-refund.ts <transferId> --operator <your-id> --confirm
```

One transfer per run — there is deliberately no `--all`. The script posts `{id}:bridge_return`,
disburses send + fee back to the sender (the fee is refunded per Reg E on payout failure), settles
`PAYOUT_FAILED → REFUNDED` with the `{id}:REFUNDED` batch, and prints both keys.

Re-running is safe. The script tells you which of three things happened, and only the first claims
credit for you:

| Step 2 line | Meaning |
|---|---|
| `sender refunded (send + fee) and state settled` | this run moved the money |
| `the disbursement had already gone out — no second payment; state settled by this run` | a previous attempt paid the sender but crashed before settling; this run finished it |
| `ALREADY REFUNDED before this run — nothing was written` | it was already done; the actor in `transfer_transitions` is someone else's |

**Concurrent runs are safe.** Before calling the processor a run takes the **refund claim** — a guarded
UPDATE exactly one run can win — so two operators, or an operator racing the automated path, cannot
both pay the sender. The loser writes nothing and says so (`claim_taken`). The processor's idempotency
key (`{idempotency_key}:refund`) is the last line of defence behind the claim, not the only one, which
matters because the mock processor ignores it outright.

The claim is **kept** after a successful refund — it records when the money left — and is never cleared
automatically. There is deliberately no release when the processor errors: a timeout and a rejection
look identical from here, so a failed run leaves its claim standing rather than letting the next run
pay a second time. That is what produces an abandoned claim.

<a id="abandoned-claims"></a>
### Abandoned claims — read before using `--reclaim`

A claim over 30 minutes old with no `refund_payment_ref` means a run died between taking the claim and
recording the disbursement. **The sender may already have been paid.** Our own data cannot tell you:
the ref is the only thing we write after the processor call, and it is missing precisely because the
run did not get that far.

1. **Check the funding processor** for a refund against this transfer (`{idempotency_key}:refund`, or
   the transfer id in the processor dashboard). This step is not optional.
2. **A refund DID go out** → do **not** reclaim. A second one would pay twice. Escalate: the state
   needs settling without a new disbursement, which no CLI path does today (the ref was never recorded,
   so the `already_disbursed` path cannot see it).
3. **No refund went out** → clear the claim and refund in one command:

```bash
doppler run -- pnpm exec tsx scripts/trigger-refund.ts <transferId> --operator <your-id> --confirm --reclaim
```

`--reclaim` requires `--confirm` and clears **only** an abandoned claim on an undisbursed transfer — it
cannot take a live claim away from a run that is mid-flight, and it cannot touch a transfer whose
disbursement was recorded. If it clears nothing the run refuses again rather than reporting success.

With `AUTO_REFUND` on, an abandoned claim also pages ops as `payout-refund-claim-abandoned`
(fingerprinted per transfer). With the flag off — the current default — the job never reaches the
refund tail at all, so **`--list` is the only place an abandoned claim surfaces.**

### 4. Verify

```sql
select from_state, to_state, actor, created_at
  from public.transfer_transitions
 where transfer_id = '<transfer-id>' order by created_at;
```

Expect a final `PAYOUT_FAILED → REFUNDED` row with actor `ops:<your-id>`. Then confirm both batches
landed and balance:

```sql
select t.transition, t.idempotency_key,
       sum(case when e.direction = 'debit' then e.amount_minor else -e.amount_minor end) as net
  from public.ledger_entries e
  join public.ledger_transactions t on t.id = e.ledger_transaction_id
 where t.transfer_id = '<transfer-id>'
 group by t.id, t.transition, t.idempotency_key;
```

Every `net` must be `0`, and both `{id}:bridge_return` and `{id}:REFUNDED` must be present. The
script checks that both **keys** are present and exits non-zero if either is missing; it never reads
`ledger_entries`, so the net-zero check is this query's job.

## Escalation — `refund_failed` (principal stuck at Bridge)

`refund_failed` means Bridge tried to return the principal and could not. The money is at Bridge, not
with us. Refunding the sender here would front the money from float and book an unreconciled
`due_from_bridge` receivable **under a ledger rule that does not exist yet** — so the script refuses
by design, and the refusal is not something to work around.

1. This transfer also raises its own Sentry alert (`payout-refund-failed`, severity **error**).
2. Work it with Bridge support until the principal is actually returned; the terminal
   `returned`/`refunded` event will then satisfy the interlock and step 3 applies normally.
3. If the sender must be made whole before Bridge resolves, that is an **engineering + Joshua
   decision**, not an ops action: it needs a front-from-float ledger rule first.

## Related

- [payout-holds.md](payout-holds.md) — the other manual payout intervention (`payout_hold_reason`)
- [local-dev.md](local-dev.md) — running the script against a local stack
