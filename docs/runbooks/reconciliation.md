# Runbook — Reconciliation (daily cron)

**Date:** 2026-07-10 · adopted 2026-07-31 (slice-8 O2) — graduated from `proposals/`.
**Mechanism:** the `ledger.reconcile` worker cron (pg-boss, **daily 6am UTC**) runs the checks
registry in `apps/api/src/services/reconciliation.ts`, persists one row per run to
**`reconciliation_runs`** (append-only; per-check summaries + a balances snapshot), and pages
Sentry per finding.
**Principle (ledger-rules.md):** the ledger is Puente's book. Stripe, Bridge, and the bank are
reconciled **against** it. A discrepancy is investigated, never auto-adjusted — the job reports,
a human resolves. The one sanctioned auto-action is replaying a missed webhook through the
idempotent worker path.

## The checks (registry order)

| Check | What it compares | Severity on findings |
|---|---|---|
| `ledger_net_zero` | every transaction's entries net to zero per currency | **fatal** |
| `ledger_min_entries` | every transaction has ≥ 2 entries | **fatal** |
| `state_postings` | transfer state ⟺ the postings the state machine requires/forbids | **fatal** |
| `account_balances` | full chart snapshot; negative balance on an open-item account | **fatal** |
| `transfer_aging` | non-terminal transfers vs the known timing windows below | warning |
| `bridge_state_sweep` | re-runs `payout.poll` (the replay path); any synthesis = poller gap | warning |
| `bridge_orphans` | Bridge transfers (7-day window) with no `transfers` row by `provider_transfer_ref` **or** `client_reference_id` | error — incident |
| `bridge_wallet_float` | treasury wallet USDC+USDB at par vs `bridge_wallet_float` balance | warning |
| `provider_fee_accrual` | accrued Bridge fees for a service period vs the recorded Bridge invoice, + accrual days no invoice covers | warning |
| `stripe_receivables` | live PI status vs our state + `funding_cleared` (detection only) | error |
| `stripe_orphans` | PIs (7-day window) with no/unknown `metadata.transfer_id`, excluding payments stamped with another `book_ref` | error — incident |

Stripe checks report `skipped` unless `FUNDING_PROCESSOR=stripe` with full keys; the float check
skips without `BRIDGE_TREASURY_WALLET_ID`; `provider_fee_accrual` skips when both
`BRIDGE_SPEI_FEE_MINOR` and `BRIDGE_ORCHESTRATION_BPS` are 0 (accrual deliberately off, so every
invoice would read as 100% variance). Skipped ≠ pass — the run row says which.

Sentry fingerprints are `(check, finding-key)` — one issue per episode; the daily re-fire while
unresolved collapses into it, and resolving while the discrepancy persists reopens next run
(correction-watch model). A check that cannot complete pages `reconcile-check-error` and marks
the run `error` (its findings are unknown, not zero).

## Known timing windows (expected, not discrepancies)

- ACH settlement: `funding_cleared` legitimately false 1–5 business days → flagged only past
  **8 calendar days** (`funding-uncleared-overdue`; business-day-blind by design).
- Held FUNDED rows (first-transfer hold) legitimately dwell until clearing → same 8-day bound.
- Unheld FUNDED: sweep enqueues every minute → flagged past **2h**.
- SUBMITTED / IN_FLIGHT: SPEI settles in seconds → flagged past **24h** from funding.
- PENDING_PAYMENT: the 30-min auto-fail should have fired → flagged past **40min**
  (means `transfer.reconcile-pending` itself is broken).
- PAYOUT_FAILED with no `refund_payment_ref`, and UNDER_REVIEW: flagged past **24h**.
- Stripe payout schedule (Stripe balance → bank lag) — not yet checked; see gaps below.

Thresholds are constants in `services/reconciliation.ts` — they encode process reality, not
tunable policy.

## When something doesn't match

1. **Ledger self-check fails (fatal page) → stop.** A non-balancing book or a state/postings
   split means a code bug — find the posting path that produced it. Corrections are new
   transactions; never edit rows (the DB forbids it anyway).
2. **Missed webhook** (most common non-bug): Bridge side self-heals via the sweep check
   (recordEvent dedupes; the processor job is idempotent). Stripe side is detection-only —
   resend the event from the Stripe dashboard (Developers → Events → Resend); the webhook
   route dedupes on event id. `stripe-missed-cleared` matters: O3's uncleared cap keeps
   blocking the sender until `funding_cleared` flips.
3. **Amount mismatch / float drift** (`bridge_wallet_float`): check for an unposted
   replenishment or an in-flight payout that crossed the run; then book the correcting
   transaction with a note (fx_slippage vs provider_fees per ledger-rules).
4. **Orphan external object → incident.** Something moved money outside the state machine.
   Figure out what created it before touching anything; if real money moved, that's a sev-1
   design breach. On `stripe_orphans`, read the `book_ref` in the finding first: it is the
   fingerprint of the database the payment was created for (see below). Manual-rail onramps are NOT orphans since funding-ops slice 3: auto-created
   onramps always carry `client_reference_id` = the transfer id, so `bridge_orphans` resolves
   them to their row (hand-created ones via the runbook curl do too). A persistent orphan is
   once again a true anomaly — the only expected exceptions are direct treasury prefunds made
   in the Bridge dashboard, which age out of the 7-day window.
5. Every finding gets: a written note (what, cause, fix), the correcting ledger transaction if
   money is involved (new transaction, never an edit), and the Sentry issue resolved only when
   the underlying condition is actually gone.

## `book_ref` — whose money is this, on a shared Stripe account

One Stripe **test** account is shared by staging and by any local stack pointed at it, so a
payment that is nobody's problem looks exactly like the worst thing this check can find. On
2026-09-15 (NODE-26) a Checkout Session was created against a local database, paid with a test
card, and the database was then torn down: a succeeded PaymentIntent remained whose
`transfer_id` matched no row anywhere. Read as staging's, that is money collected with no
transfer to show for it.

So every PaymentIntent we create carries `metadata.book_ref`, an 8-hex fingerprint of the
`SUPABASE_URL` **hostname** of the deployment that created it (`apps/api/src/config/book.ts`).
`stripe_orphans` then reads three cases:

| `book_ref` on the payment | What it means | What the check does |
|---|---|---|
| ours | our book, and no transfer matches | **finding** — the incident above |
| another book's | created by an API serving a different database | counted as `foreignBook` in the run summary, not paged |
| absent | created before 2026-09-15, or not by us at all | **finding** — absence is not an answer |

The run summary carries `book` (ours) beside `foreignBook`, which is how you turn a fingerprint
seen in the Stripe dashboard back into a name.

The stamp also un-silences the webhook. A `funding_succeeded` for a transfer we do not have used
to be one log line and a 200 — nothing paged, and nothing was stored (`payment_events.transfer_id`
is a FK, so no row can name a transfer that does not exist), which left `stripe_orphans` as the
only watcher, up to six hours behind. The route now pages **`funding event for unknown transfer`**
(fingerprint `funding-unknown-transfer:<transferId>`, tagged with the `bookRef`) unless the payment
carries another book's stamp. Same class as the dispute path's long-standing
"dispute unmatched to any transfer".

**The one way this can hide a real orphan:** if a deployment's database HOST changes, payments
stamped by the old host read as another book. Nothing else does this — the stamp ignores scheme,
port, path and case — so treat `foreignBook` going non-zero in **production** (where no other
environment shares the live account) as a finding in its own right and read the payments by hand.

## Bridge's monthly invoice

Bridge's per-transaction fees are **not** on its per-transfer receipts (those report every fee as
`0.0`). They arrive as a monthly PDF. Until 2026-09-11 nothing in this system had ever seen one:
`provider_fees` held zero entries in production while invoice INV19341 ($10.30, three completed
transfers) sat in an inbox, and per-transfer P&L understated cost by ~$2 a send.

The payout path now **accrues** the predictable per-send part at `SUBMITTED`
(`DR provider_fees / CR bridge_fees_payable`, rates in `BRIDGE_SPEI_FEE_MINOR` +
`BRIDGE_ORCHESTRATION_BPS`). Recording the real invoice closes the loop.

**When an invoice arrives:**

1. Transcribe it to JSON — every line as printed, plus the stated total. The schema and a worked
   example are in the header of `apps/api/scripts/record-provider-invoice.ts`.
2. Dry run (the default — nothing posts):
   ```
   doppler run -- pnpm exec tsx scripts/record-provider-invoice.ts --file inv.json
   ```
   It prints each line's classification and the true-up it would post.
3. Record + book: add `--confirm`. Add `--pay` once the payment has actually settled (the ledger
   records what is true; a payment booked against money still in flight overstates cash).

**An unrecognized line stops the script.** That is the point — it means Bridge is billing for
something new, which is exactly the change that would otherwise erode margin invisibly. Decide what
the line is, state its `category` on it (`accruable` | `onboarding` | `other`), and add the label to
`LINE_PATTERNS` in `services/provider-fees.ts` so the next invoice classifies itself.

**A booked invoice is immutable** (DB trigger): its numbers are ledger history and the ledger cannot
be edited. A provider correction is a new record, never an edit.

### When `provider_fee_accrual` finds something

- **`provider-fee-variance:<provider>:<invoice>`** — the invoice disagrees with what we accrued by
  more than the tolerance. Check the finding's `varianceMinor` sign first: **positive** means Bridge
  charged more than our model predicted (a price change, or the wrong accrual basis — the
  orchestration basis is the known-unverified one, see ledger-rules.md); **negative** means we
  over-accrued, most often payouts that were accrued and then failed. Either way the ledger is
  already correct — the true-up posted the difference — so the action is to re-aim the contract
  rates in Doppler, not to touch the book.
- **`provider-invoice-unbooked:<provider>:<invoice>`** — recording and booking happen in one CLI
  run, so this means that run died between them. Re-run it with `--confirm`; both steps are
  idempotent.
- **`provider-fee-unbilled:<date>`** — accrual days older than `PROVIDER_INVOICE_GRACE_DAYS` that no
  recorded invoice covers. Either the invoice never arrived (ask Bridge) or it arrived and nobody
  recorded it (record it). A book nobody reconciles looks exactly like a book that reconciles
  perfectly, which is why this half of the check exists.

## Reading a run

```sql
select created_at, status, findings_count, checks, balances
from reconciliation_runs order by created_at desc limit 7;
```

`checks` is the per-check array (status, findings_count, acknowledged_count, summary); `balances`
is the full chart snapshot — both render on the read-only ops page at `/dashboard/ops` (8.5-v1,
admin-allowlisted). Findings detail lives in Sentry, not the row — the row carries counts and refs
only, never PII.

`findings_count` is the **actionable** number: findings with an active acknowledgement are counted
under `acknowledged_count` instead, and the run's `status` is computed from the actionable one. A
`pass` with a non-zero `acknowledged_count` is a pass *because something is silenced* — always read
the two together.

## Acknowledging a finding

Every check is a stateless diff re-run on a tick, so a discrepancy that is real, understood, and
settled keeps paging until its own lookback window ages out — 60 days for `stripe_disputes`. An
acknowledgement records that a human answered for it, and stops the page until a stated date.

**Use it when** the finding names something with nothing left to do: the cause is history rather
than a defect, or the money question is already closed. The worked example is the three 2026-09-10
staging disputes, which went unrecorded because they *predate* the loss path that records them
(#310, #313) — not a defect, not fixable, and otherwise paging until 2026-11-09.

**Do not use it** when the finding names something still open — money in flight, a balance that
does not reconcile, a transfer nobody has decided about. The page is not the problem; it is the
only thing watching.

```bash
# what is already acknowledged
pnpm exec tsx scripts/acknowledge-finding.ts --list

# dry run (no --confirm), then the real thing
doppler run -- pnpm exec tsx scripts/acknowledge-finding.ts \
  --check stripe_disputes --key 'stripe-dispute-unrecorded:du_1ABC' \
  --operator <your-user-uuid> --note "investigated 9/15: predates #310, money settled" \
  --days 60 --confirm

# changed your mind — it pages again from the next run
doppler run -- pnpm exec tsx scripts/acknowledge-finding.ts \
  --revoke <ack-uuid> --operator <your-user-uuid> --note "reopened: dispute escalated" --confirm
```

The `--key` is the finding key verbatim — the part of the Sentry title after the em dash.

Four things the tool will not let you do, each deliberate:

| refusal | why |
|---|---|
| no `--days`, or more than 90 | There is no "forever". A permanent acknowledgement is a permanent blind spot, so the worst case of a wrong call is bounded and self-healing. The cap is a CHECK constraint, so a direct INSERT cannot buy more either. |
| a **fatal** check | `ledger_net_zero` and its siblings are the invariants the whole book rests on. If one fires the answer is a human, now — not a note and a date. Enforced again in the runner, on the severity of the check actually running. |
| a check name that is not in the registry | A typo would write a row that silences nothing and reads, forever after, as though someone had handled it. |
| a second acknowledgement on a live one | You should read the first operator's note before deciding this is handled. Revoke to replace. |

Suppression is on the finding **key**, not its detail: a dispute moving `needs_response` → `lost`
keeps the same key and stays quiet. That is the deliberate trade — keying on detail would re-page
on every incidental field change — and the expiry cap is what bounds it. If it ever bites, the
escape hatch is a `detail_fingerprint` column compared in the runner's filter: additive, no
backfill.

If the acknowledgements table cannot be read, the run **fails open**: every finding pages, and a
separate `acknowledgements unreadable` page fires so a silently-disabled suppression layer cannot
pass for a system with nothing acknowledged.

```sql
-- who silenced what, and when they let it ring again
select created_at, actor, action, note from ops_actions
where action in ('reconciliation_ack', 'reconciliation_ack_revoke')
order by created_at desc limit 20;
```

## Known gaps (phase 2)

- ~~**No cash legs yet**~~ **— CLOSED 2026-08-03.** `funding_cleared` now posts the ACH CLEARS
  batch (`DR cash_clearing / CR funding_receivable`, transition `funding_cleared`), so the
  receivable is relieved at settlement as ledger-rules.md always specified. This was not only an
  accounting gap: `funding_receivable` is what the float ceiling reads, so an unrelieved balance
  tracked lifetime volume and would have tripped the ceiling permanently once cumulative volume
  crossed it, halting every payout with no self-healing.
  **Still open:** `cash_clearing` ↔ Stripe balance + bank comparison. Stripe settles in BATCHES
  (one payout covers many charges, net of fees), so the per-transfer posting is exact in amount
  but approximate in timing; a meaningful comparison needs the balance-transaction ingest.
  `cash_clearing` can still sit legitimately negative meanwhile (fee refunds, and payouts fronted
  before their funding settles); the negative-balance guard deliberately excludes it.
- ~~**Fee-line reconciliation**~~ **— BRIDGE HALF CLOSED 2026-09-11** by `provider_fee_accrual`
  (see below). **Still open:** the Stripe half. Stripe nets its fees out of settlement rather than
  invoicing them, so catching them needs the same balance-transaction ingest the `cash_clearing`
  comparison does.
- Bridge/Stripe list reads are one bounded page (100); the run summary flags `truncated: true`
  when the window view is incomplete. Fine at pilot volume; paginate when it trips.
- Weekly `fx_slippage` trend review (prices the FX buffer) — manual, PostHog/SQL.
