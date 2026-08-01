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
| `stripe_receivables` | live PI status vs our state + `funding_cleared` (detection only) | error |
| `stripe_orphans` | PIs (7-day window) with no/unknown `metadata.transfer_id` | error — incident |

Stripe checks report `skipped` unless `FUNDING_PROCESSOR=stripe` with full keys; the float check
skips without `BRIDGE_TREASURY_WALLET_ID`. Skipped ≠ pass — the run row says which.

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
   design breach.
5. Every finding gets: a written note (what, cause, fix), the correcting ledger transaction if
   money is involved (new transaction, never an edit), and the Sentry issue resolved only when
   the underlying condition is actually gone.

## Reading a run

```sql
select created_at, status, findings_count, checks, balances
from reconciliation_runs order by created_at desc limit 7;
```

`checks` is the per-check array (status, findings_count, summary); `balances` is the full
chart snapshot — both render on the read-only ops page at `/dashboard/ops` (8.5-v1, admin-allowlisted). Findings detail lives in Sentry, not the row —
the row carries counts and refs only, never PII.

## Known gaps (phase 2)

- **No cash legs yet:** `funding_receivable` is never relieved into `cash_clearing` at
  settlement (no posting on `funding_cleared`), so `cash_clearing` ↔ Stripe balance + bank
  comparison is not yet meaningful — needs the settlement/sweep posting design first.
  `cash_clearing` can sit legitimately negative meanwhile (fee refunds paid before cash legs
  exist); the negative-balance guard deliberately excludes it.
- Fee-line reconciliation (Stripe fees + Bridge invoice bps vs `provider_fees`) — with the
  cash legs.
- Bridge/Stripe list reads are one bounded page (100); the run summary flags `truncated: true`
  when the window view is incomplete. Fine at pilot volume; paginate when it trips.
- Weekly `fx_slippage` trend review (prices the FX buffer) — manual, PostHog/SQL.
