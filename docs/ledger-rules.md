# Double-Entry Ledger Rules — USD → MXN Remittance

**Date:** 2026-06-26
**Status:** Documents shipped, test-pinned behavior through slice 5 (2026-07-21)
**Pairs with:** `transfer-state-machine.md` (every money-moving transition posts here)

## Principles

- **Double-entry.** Every financial event is recorded as balanced debits and credits that sum to
  zero. Money never increments a single number — it always moves *from* one account *to* another.
- **USD-only.** Puente never custodies MXN; Bridge does the FX and the SPEI payout. The MXN amount the
  recipient receives and the rate Bridge quoted are **metadata on the transfer/quote/disclosure** (for
  display + Reg E), never ledger positions. There is **no FX event in our ledger.**
- **Money = integer minor units + currency.** Stored as cents (bigint) + `USD`. Never floats. (Dollar
  figures in the examples below are illustrative; the store is integer cents.)
- **Balances are derived.** A balance is `SUM(entries)` over an account — recomputed, never stored
  mutable. It can therefore never silently drift from its history.
- **Append-only.** No entry is ever updated or deleted. Refunds, reversals, and corrections are
  **new** transactions with their own entries.
- **Every posting batch ties to** a `transfer` + the triggering state transition, and is idempotent on
  `(transfer_id, transition)` so a retried worker job posts exactly once.

## Tables (see ERD)

- `ledger_accounts` — the buckets (below).
- `ledger_transactions` — one financial event; its entries **must net to zero**. Ties to a transfer +
  transition.
- `ledger_entries` — the individual debit/credit lines (2+ per transaction).

## Chart of accounts (all USD)

All accounts are company-level (one row each). Per-transfer attribution is via `transfer_id` on
`ledger_entries`, not separate accounts per transfer.

| Account | Type | Normal balance | Meaning |
|---|---|---|---|
| `cash_clearing` | asset | debit | Float / cash on hand (our Stripe/bank balance). |
| `bridge_wallet_float` | asset | debit | USDC pre-funded in the Bridge treasury wallet — cash at a different location. Payouts draw from it; batch replenishments top it up. |
| `funding_receivable` | asset | debit | ACH initiated but not cleared — money owed to us by the sender's bank. |
| `due_from_bridge` | asset | debit | Funds sent to Bridge, delivery not yet confirmed (in-transit window). |
| `transfer_payable` | liability | credit | Our obligation to complete the transfer (owed until delivered). |
| `refunds_payable` | liability | credit | Owed back to a sender on cancel/failure. |
| `fee_revenue` | revenue | credit | Puente's fee (plus any FX spread, realized in USD). |
| `provider_fees` | expense | debit | What we pay Bridge + Stripe. |
| `fx_slippage` | expense | debit | Variance between the quoted USD send and Bridge's actual USD cost at execution (Bridge doesn't lock). Can be a credit when favorable. |
| `loss_funding_reversed` | expense | debit | Write-offs from post-delivery ACH returns / chargebacks. |

Convention: **assets & expenses increase on debit; liabilities & revenue increase on credit.**

## Posting rules per transition

Worked example: sender pays **$100** ($98 to send + **$2** Puente fee); at payout Bridge draws a
*variable* USDC amount — here **$98.08** against a quoted **$98.00** send, so **$0.08** books to
`fx_slippage` (Bridge charges no explicit per-transfer fee — see FX & provider economics); MVP
instant-ACH policy (we front from `cash_clearing` before the ACH clears).

### Happy path

```
FUNDED  (ACH initiated — recognize obligation + fee against a receivable)
  DR funding_receivable   100
  CR transfer_payable        98
  CR fee_revenue              2

SUBMITTED  (payout drawn from the pre-funded treasury wallet; obligation stays open)
  DR due_from_bridge         98.00  ← quoted send principal S (what Bridge now owes us)
  DR fx_slippage              0.08  ← D = A − S > 0 (unfavorable: actual draw exceeded the quote)
  CR bridge_wallet_float     98.08  ← actual USDC draw A Bridge reported at execution

WALLET REPLENISHMENT  (independent batch event, not per-transfer — top up the treasury wallet)
  DR bridge_wallet_float    500
  CR cash_clearing          500

COMPLETED  (Bridge confirms delivery)
  DR transfer_payable        98     ← obligation discharged
  CR due_from_bridge         98     ← in-transit claim settled

ACH CLEARS  (independent later event — funding actually lands)
  DR cash_clearing          100
  CR funding_receivable     100
```

The `SUBMITTED` slippage line flips with the sign of `D = A − S`: a **debit** when unfavorable
(A > S, shown above), a **credit** of |D| when favorable (A < S), and omitted entirely when A = S
(the ledger rejects zero-amount entries). There is **no `provider_fees` line** in the SUBMITTED
batch — Bridge charges no explicit per-transfer fee (see FX & provider economics).

End state for this transfer: `funding_receivable` 0, `transfer_payable` 0, `due_from_bridge` 0,
`fee_revenue` +2, `fx_slippage` +0.08, and **cash across its two locations net +1.92**
(with the $500 replenishment batch included: `cash_clearing` −400, `bridge_wallet_float` +401.92 —
cash is split across locations since the wallet adoption; their sum is the cash position).
Conservation check: `cash +1.92 = fee_revenue 2 − fx_slippage 0.08`. ✓ (Pinned by the
production-path test in `apps/api/src/services/payout-ledger.db.test.ts`.)

Note the exposure the design surfaces: between `SUBMITTED` and `ACH CLEARS`, you're **−$98.08 of float
against an open `funding_receivable`** — that gap is your ACH exposure, sitting on the balance sheet.

### Exceptions

```
CANCELED  (ACH not yet in flight — reverse the FUNDED batch cleanly)
  DR transfer_payable        98
  DR fee_revenue              2    ← reverses the FUNDED credit; fee not earned on a cancel
  CR funding_receivable     100

CANCELED  (ACH already in flight — keep funding_receivable open; owe refund from float)
  DR transfer_payable        98
  DR fee_revenue              2
  CR refunds_payable        100
  ── pay the refund immediately from float:
  DR refunds_payable        100
  CR cash_clearing          100
  ── ACH clears independently (may be days later):
  DR cash_clearing          100
  CR funding_receivable     100

PAYOUT_FAILED → REFUNDED  (after SUBMITTED; Bridge returns principal)
  1) Bridge returns the $98:
     DR cash_clearing        98
     CR due_from_bridge      98
  2) Recognize the refund owed (full amount incl. fee, per Reg E):
     DR transfer_payable     98
     DR fee_revenue           2
     CR refunds_payable     100
  3) Pay the refund:
     DR refunds_payable     100
     CR cash_clearing       100
  (Bridge's $0.50 is typically non-refundable → stays as provider_fees expense, our cost.
   The funding_receivable / ACH-clearing leg settles independently per the happy-path entries.)

FUNDING_REVERSED  (ACH return after COMPLETED — money already delivered, irreversible)
  DR loss_funding_reversed  100
  CR cash_clearing          100
  (Or DR a user receivable instead of straight loss, then write off to loss_funding_reversed if
   unrecoverable. This is the loss the risk engine exists to prevent.)

UNDER_REVIEW → REFUNDED  (entry from COMPLETED — post-delivery Reg E correction, NOT a reversal)
  DR loss_funding_reversed   X      ← or a dedicated correction-expense account
  CR cash_clearing           X
  (A correction payment is a NEW debit against Puente. The original COMPLETED entries remain
   intact — we never rewrite delivered history.)

  Pre-delivery exits (entry from FUNDED, SUBMITTED, or IN_FLIGHT) use the CANCELED or
  PAYOUT_FAILED posting for the corresponding stage — those paths are TBD pending
  full design of the ops console and pre-delivery dispute handling.
```

## Invariants (must always hold)

- Every `ledger_transaction` nets to zero in USD.
- `account balance = SUM(its entries)`; recomputed, never stored.
- No entry is ever updated or deleted; corrections are new transactions.
- Each money-moving transition produces exactly one `ledger_transaction`, idempotent on
  `(transfer_id, transition)`. Enforced by a `UNIQUE(transfer_id, transition)` constraint on
  `ledger_transactions`; a conflicting insert is a no-op (`ON CONFLICT DO NOTHING`), so retried
  workers are safe.
- **Conservation:** across a completed transfer, cash gained = `fee_revenue − provider_fees − fx_slippage`.
  Per transfer `provider_fees` is 0 (Bridge bills a periodic invoice, not per-transfer), so in practice
  cash = `fee_revenue − fx_slippage` (a favorable slippage credit adds to cash).

## Float exposure & the ceiling

Outstanding fronted float = `SUM(funding_receivable)` not yet cleared. The **float ceiling** guardrail
(see state machine) caps this aggregate: block `FUNDED → SUBMITTED` when fronting a transfer would
push the total past the configured ceiling. The number comes straight from this account — no extra
bookkeeping.

## FX & provider economics

**Bridge's take is the FX spread, not a per-transfer fee (production PoC receipts, 2026-07-13).** Both
PoC legs (ACH→USDC onramp `9f1acb84…`, USDC→ACH payout `b3746f1a…`) returned `developer_fee`,
`exchange_fee`, and `gas_fee` all **0.0** with `final_amount = initial_amount`. Bridge's margin on
cross-currency is the spread baked into its rate (`buy_rate` vs `midmarket_rate`; ~0.5% on the sandbox
USD→MXN rate). Receipt math is `final_amount = initial_amount − fees`, so any fees are **netted inside
the transfer**; if explicit Bridge line items ever appear (pricing change, `developer_fee`), they book
to `provider_fees` within the transfer's own posting, `final_amount` being what arrives.

**Quote basis.** Quotes are built from Bridge's **`buy_rate`** (the executable side), not
`midmarket_rate`; the ERD's `source_rate` = buy_rate at quote time, and customer rate = buy_rate − our
buffer. We do **not** use `developer_fee` to collect Puente's fee inside the transfer — Stripe collects
`total_amount` including our fee, so `developer_fee` is `"0"` and `fee_revenue` books at `FUNDED`.

**`provider_fees` is invoice-time, ~0 per transfer.** Bridge bills **bps on volume at the account
level** (rate per the Bridge agreement, confirmed 2026-07-13) — a periodic invoice-style expense, not
a per-transfer receipt line (receipts stay zero). Book it when invoiced; optionally accrue
per-transfer once volume matters. `provider_fees` therefore stays in the chart mainly for **Stripe's**
funding fees plus this Bridge invoice — the worked example's $0.50 Bridge fee is illustrative only.
Unit economics per transfer:
`fee_revenue − (Bridge FX spread inside buy_rate + bps accrual + Stripe funding fee)`.

**No rate lock — `fx_slippage` absorbs the execution variance.** Bridge gives only an indicative rate,
so the actual USD cost is known at execution (`SUBMITTED`), not at quote time. We quote a firm rate
(`source_rate` minus the buffer) and absorb the difference. Mechanically (sandbox spike 2026-07-13):
the payout fixes `destination.amount` in MXN — the recipient gets exactly the disclosed amount — and
Bridge draws a *variable* USDC amount from the treasury wallet, returned **synchronously** in the
transfer-create response (`source.amount`). So `D = A − S` (actual draw vs quoted send principal) is
known at submission and books inside the `SUBMITTED` batch itself — no later true-up entry. The buffer
funds it; a favorable move lands as a credit.

**Open question — does prod execute at `buy_rate`, or worse?** The framing above reads `fx_slippage` as
execution *drift* around the quoted `buy_rate`, with Bridge's spread already priced into that rate. The
slice-5 sandbox complicates it: execution sat a **constant ~2% below `buy_rate`** — a systematic gap,
not random drift — though the sandbox rate feed is frozen so the magnitude proves nothing. If prod
shows a real spread, that gap is a **provider cost that belongs in pricing** (`QUOTE_FX_BUFFER_BPS`),
not in `fx_slippage`. Resolve at the first pilot send: **observe the real USD→MXN spread** and any
MXN-leg fee lines, then fix the quote basis + account mapping. See [decisions.md](decisions.md)
2026-07-21.

## Pending posting rules (flagged in review 2026-07-10)

- **Card funding (rail #2).** The worked examples assume ACH. Card capture is instant — no
  `funding_receivable` window; funds land in Stripe balance at `FUNDED` (likely
  `DR cash_clearing / CR transfer_payable + fee_revenue` directly), and the reversal risk is a
  **chargeback**, not an ACH return (books to `loss_funding_reversed` the same way). Define fully
  before enabling card funding; ACH-only for MVP.
- ~~**Bridge treasury-wallet float.**~~ **ADOPTED 2026-07-13** — the sandbox spike confirmed the
  pre-funded-wallet topology (no one-transfer fiat→SPEI route exists). `bridge_wallet_float` is now
  in the chart of accounts and the SUBMITTED/replenishment postings above. USDC is treated as USD
  at par in the ledger (it's a cash location, not a currency position); any de-peg variance books
  to `fx_slippage`.

## Reconciliation

External sources of truth — Stripe balance, Bridge statements, bank — are **reconciled against** this
ledger via `payment_events` + external refs (`bridge_transfer_ref`, Stripe IDs), on a daily job. The
ledger is Puente's book; these systems are not part of it. Any discrepancy is investigated, never
auto-adjusted.
