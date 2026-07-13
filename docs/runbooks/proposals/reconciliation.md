# Runbook — Reconciliation (daily)

**Date:** 2026-07-10 · **Status:** ⚠️ **PROPOSAL — not adopted.** The reconciliation process is undecided; kept as design input for the future cron job.
**Principle (ledger-rules.md):** the ledger is Puente's book. Stripe, Bridge, and the bank are
reconciled **against** it. A discrepancy is investigated, never auto-adjusted — the job reports,
a human resolves.

## What gets compared

| Our ledger says | External truth | Check |
|---|---|---|
| `cash_clearing` balance | Stripe balance + business bank balance | Cash on hand matches, minus known timing windows |
| `funding_receivable` open items | Stripe: payments initiated but not settled | Every open receivable maps to a live Stripe ACH; none aged past ~5 business days |
| `due_from_bridge` open items | Bridge: transfers not yet `payment_processed` | Every open item maps to a live Bridge transfer; none stuck (→ stuck-transfer runbook) |
| `transfer_payable` open items | Transfers in `FUNDED`–`IN_FLIGHT` | Liability exists ⟺ an undelivered transfer exists |
| Per-transfer terms | Bridge `receipt` (actual USD cost) vs quoted | Variance booked to `fx_slippage`; watch drift (buffer sizing) |
| `fee_revenue` / `provider_fees` | Stripe fees + Bridge receipts | Unit economics stay truthful |

Plus two state sweeps (not balance checks):

- **Non-terminal transfers vs providers:** for every transfer in `SUBMITTED`/`IN_FLIGHT`, poll
  `GET /v0/transfers/{ref}`; for every `PENDING_PAYMENT`/`FUNDED`, poll Stripe. Provider terminal but
  we're not → **missed webhook**: replay through the normal worker path (idempotent by design).
- **Orphans:** Stripe payments or Bridge transfers with no matching `transfers` row — should be
  impossible; each one is an incident.

## Ledger self-checks (run first — they validate the book itself)

```sql
-- every transaction nets to zero (should return no rows)
SELECT lt.id FROM ledger_transactions lt
JOIN ledger_entries le ON le.ledger_transaction_id = lt.id
GROUP BY lt.id
HAVING SUM(CASE WHEN le.direction = 'debit' THEN le.amount_minor ELSE -le.amount_minor END) <> 0;

-- one posting per (transfer, transition) — UNIQUE constraint makes this belt-and-braces
-- float exposure vs ceiling
SELECT SUM(CASE WHEN le.direction = 'debit' THEN le.amount_minor ELSE -le.amount_minor END) AS funding_receivable_minor
FROM ledger_entries le JOIN ledger_accounts la ON la.id = le.account_id
WHERE la.code = 'funding_receivable';
```

## Known timing windows (expected, not discrepancies)

- ACH settlement: `funding_receivable` legitimately open 1–5 business days.
- Stripe payout schedule: Stripe balance → bank lags by the payout schedule; the sum matches, the
  split moves.
- Same-day Bridge in-flight: `due_from_bridge` items minutes old.

The job should net these out before flagging; everything else is a finding.

## When something doesn't match

1. Ledger self-checks fail → **stop; highest severity.** A non-balancing book means a code bug —
   find the posting path that produced it (corrections are new transactions).
2. Missed webhook (most common) → replay via worker path; confirm state + ledger advance together.
3. Amount mismatch on a transfer (Bridge receipt ≠ our posting) → book the difference to
   `fx_slippage` (expected) or `provider_fees` (fee change — renegotiate the assumption in
   ledger-rules), with a note on the ledger transaction.
4. Cash mismatch after timing windows → check for returns/chargebacks not yet processed
   (→ funding-reversal runbook), then bank fees or Stripe adjustments.
5. Orphan external object → incident: figure out what created it; if it moved real money outside the
   state machine, that's a sev-1 design breach.

Every finding gets: a written note (what, cause, fix), the correcting ledger transaction if money is
involved, and an audit log entry. Findings trend in a simple log — recurring classes of mismatch are
design feedback, not ops noise.

## Cadence & build shape

- **Cron (Railway, daily, off-peak):** self-checks + state sweeps + balance comparisons → Sentry
  alert with a findings summary (no PII).
- **Manual (until built / spot-check):** run the SQL above in Supabase Studio; eyeball Stripe +
  Bridge dashboards against open ledger items. At five users this is minutes.
- Weekly: review `fx_slippage` trend — it prices the FX buffer in quotes.
