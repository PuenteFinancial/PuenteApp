# Double-Entry Ledger Rules — USD → MXN Remittance

**Date:** 2026-06-26 · **Updated:** 2026-09-11 (Bridge's explicit per-send fees are real and
invoiced monthly — accrual at SUBMITTED, monthly true-up, and the acquisition-cost split)
**Status:** Documents shipped, test-pinned behavior through funding-ops slices 1–4 + the onramp
rail's settlement legs
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
| `provider_fees` | expense | debit | Per-transaction cost of moving the money: Bridge's explicit per-send fees (accrued at `SUBMITTED`, trued up monthly) plus Stripe's funding fees. |
| `provider_onboarding_fees` | expense | debit | ONE-TIME per-customer provider cost (Bridge's $2.00 Individual Compliance fee, $0.25 wallet fee). Acquisition cost, not transfer cost — deliberately outside `provider_fees` so a customer's onboarding bill never lands in one transfer's margin. |
| `bridge_fees_payable` | liability | credit | Bridge fees accrued but not yet invoiced, plus invoiced but not yet paid. Bridge-specific on purpose: the monthly true-up compares ONE provider's accrual stream against ONE provider's invoice. |
| `fx_slippage` | expense | debit | Variance between the quoted USD send and Bridge's actual USD cost at execution (Bridge doesn't lock). Can be a credit when favorable. |
| `loss_funding_reversed` | expense | debit | Write-offs from post-delivery ACH returns / chargebacks. |

Convention: **assets & expenses increase on debit; liabilities & revenue increase on credit.**

## Posting rules per transition

Worked example: sender pays **$100** ($98 to send + **$2** Puente fee); at payout Bridge draws a
*variable* USDC amount — here **$98.08** against a quoted **$98.00** send, so **$0.08** books to
`fx_slippage`, and Bridge's explicit per-send fee (**$1.25** = $1.00 flat SPEI + 25bps of the
principal) accrues to `provider_fees` against `bridge_fees_payable` — see FX & provider economics;
MVP instant-ACH policy (we front from `cash_clearing` before the ACH clears).

> **Merged-rate rows (#193, 2026-08-17).** Since the fee merged into the displayed FX rate,
> new quotes/transfers carry `send_amount_minor` = the FULL charge, `fee_amount_minor` = 0, and
> the take in `margin_minor` (`QUOTE_MARGIN_BPS`, kept separate from `QUOTE_FX_BUFFER_BPS` —
> revenue vs. drift cover; blending them would make `fx_slippage` unreadable). Every batch below
> is written against three identities that hold for BOTH generations of rows:
> `total = send + fee`, `revenue = fee + margin` (→ `fee_revenue`), `principal = send − margin`
> (→ `transfer_payable` / `due_from_bridge`, the S in the SUBMITTED batch). At equal bps the
> batches are byte-identical across generations, so this worked example stays valid — read its
> "$98 send / $2 fee" as principal/revenue. Enforced by the generation-equivalence suite in
> `apps/api/src/services/transfers.test.ts`.

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
  DR provider_fees            1.25  ← F, Bridge's explicit per-send fee, ACCRUED (no cash moves)
  CR bridge_fees_payable      1.25  ← owed to Bridge until its monthly invoice is paid

WALLET REPLENISHMENT / FLOAT TOP-UP  (independent event, not a state transition — top up the
  treasury wallet)
  DR bridge_wallet_float    500
  CR cash_clearing          500
  (Since funding-ops slices 1–2 + the onramp rail, this posting has four writers, all through
   recordFloatTopUp and all idempotent on the GLOBAL ledger key `float_topup:<ref>`:
   the ops deposit-landed action (runs after the cleared leg, and on cleared_skipped too),
   the ad-hoc ops top-up card (no ref → derived key `adhoc:<Idempotency-Key>`),
   the record-float-topup.ts CLI, and — automatically — the onramp rail's settlement webhook
   (ref = the onramp session id). The key being global is why the ops action guards the ref
   against the transfer's attached bridge_transfer_ref: a cross-transfer typo would silently
   consume another transfer's top-up.)

COMPLETED  (Bridge confirms delivery)
  DR transfer_payable        98     ← obligation discharged
  CR due_from_bridge         98     ← in-transit claim settled

ACH CLEARS  (independent later event — funding actually lands)
  DR cash_clearing          100
  CR funding_receivable     100
  (Posted by the funding_cleared webhook under its own `funding_cleared` transition — NOT a state
   change, so it is keyed independently and a redelivery is a no-op. Implemented 2026-08-03;
   until then it was specified here but never posted, which left funding_receivable tracking
   LIFETIME VOLUME. Because isFloatCeilingTripped reads that balance, the ceiling was a one-way
   ratchet that would have halted all payouts permanently. Skipped when the receivable is already
   closed — PENDING_PAYMENT/PAYMENT_FAILED never opened it, CANCELED and voided-mode refunds
   already credited it back; those all describe a pull that never truly settles.)
```

The `SUBMITTED` slippage line flips with the sign of `D = A − S`: a **debit** when unfavorable
(A > S, shown above), a **credit** of |D| when favorable (A < S), and omitted entirely when A = S
(the ledger rejects zero-amount entries). The `provider_fees` / `bridge_fees_payable` pair is
likewise omitted when F = 0 (both contract-rate knobs off).

> **The accrual joined this batch on 2026-09-11** (see FX & provider economics). Until then this
> document asserted that Bridge charged no explicit per-transfer fee, on the strength of receipts
> that report `developer_fee`, `exchange_fee` and `gas_fee` all `0.0`. Bridge charges plenty — it
> bills **monthly, out of band**. The claim was wrong in the most expensive direction: per-transfer
> P&L understated cost by roughly **$2 a send**, which at pilot size is larger than the margin.
>
> F is an **estimate** from the contract rates, and is never revised per transfer — not even when
> the payout later fails and no SPEI ever executes. The monthly true-up is the correction
> mechanism, and it absorbs over-accrual from a failed payout by exactly the arithmetic that
> catches a Bridge price change. Reversing per transfer would add a posting key to every refund
> path for an error the true-up already handles.

End state for this transfer: `funding_receivable` 0, `transfer_payable` 0, `due_from_bridge` 0,
`fee_revenue` +2, `fx_slippage` +0.08, `provider_fees` +1.25, `bridge_fees_payable` +1.25, and
**cash across its two locations net +1.92** (with the $500 replenishment batch included:
`cash_clearing` −400, `bridge_wallet_float` +401.92 — cash is split across locations since the
wallet adoption; their sum is the cash position).

Two different true statements, and the gap between them is the whole point of the accrual:

- **Cash**, today: `+1.92 = fee_revenue 2 − fx_slippage 0.08`. ✓ The accrual moves no cash, so
  this identity is unchanged. (Pinned by the production-path test in
  `apps/api/src/services/payout-ledger.db.test.ts`.)
- **P&L**, this transfer: `+0.67 = fee_revenue 2 − fx_slippage 0.08 − provider_fees 1.25`. The
  $1.25 leaves as cash when Bridge's invoice is paid, discharging `bridge_fees_payable`.

Before 2026-09-11 only the first line existed, and it was read as margin.

Note the exposure the design surfaces: between `SUBMITTED` and `ACH CLEARS`, you're **−$98.08 of float
against an open `funding_receivable`** — that gap is your ACH exposure, sitting on the balance sheet.

### Exceptions

```
CANCELED  (the SENDER's cancel, inside the Reg E window — reverse the FUNDED batch cleanly)
  DR transfer_payable        98
  DR fee_revenue              2    ← reverses the FUNDED credit; fee not earned on a cancel
  CR funding_receivable     100
  (PR-S2 note: the cancel route posts THIS batch in both undo modes. When the void fell back
   to a real refund — the PI settled first, a sandbox norm and a live race — the settlement
   inflow and the refund outflow both go unbooked: they offset exactly, end-state books stay
   correct, and the transient Stripe-balance mismatch is a KNOWN recon timing window (logged
   `cancel void fell back to a refund`). If the fallback refund then BOUNCES, refund.failed
   pages and the runbook re-disbursement carries its own posting.
   WHY THE SHORTCUT IS SAFE HERE and nowhere else: the window is 30 minutes and ACH settles
   in days, so `funding_cleared` provably has NOT posted on this row. See the ops cancel
   below, where that is false.)

CANCELED → REFUNDED  (the OPERATOR's cancel of an undeliverable payout — IMPLEMENTED 2026-09-14,
  services/ops-cancel.ts. Specified here from the beginning as "ACH already in flight"; nothing
  reached the case until a `payability` hold whose cause could never resolve left two staging
  transfers funded and unpayable.)

  Recognize the debt, at CANCELED — mode-free, so it can be posted BEFORE the processor is
  called. That order is the safety property: once the state leaves FUNDED no payout can be
  created by any path, and the batch that PAYS the sender cannot be chosen until the processor
  says how it made them whole.
  DR transfer_payable        98
  DR fee_revenue              2
  CR refunds_payable        100

  Pay it, at REFUNDED — the credited ASSET is the undo mode, same distinction as every other
  refund pair in this file:
  ── undo mode REFUNDED (the pull had settled; a real credit goes back):
  DR refunds_payable        100
  CR cash_clearing          100
  ── undo mode VOIDED (the pull was canceled; the sender is never debited):
  DR refunds_payable        100
  CR funding_receivable     100

  DO NOT post the sender-cancel reversal above on one of these. It credits `funding_receivable`,
  which the `funding_cleared` leg has usually already settled on a row this old — driving the
  receivable NEGATIVE (an arithmetic impossibility the open-item guard flags) and leaving the
  cash we still hold unaccounted for. Asserted as a counterfactual in
  `services/ops-cancel.db.test.ts`.

  A transfer whose undo needs a HUMAN (manual / onramp rails) rests at CANCELED with
  `refunds_payable` open — the honest statement that the sender has not been paid.

PAYOUT_FAILED → REFUNDED  (after SUBMITTED; Bridge returns principal; undo mode REFUNDED —
  the funding had settled, so a real Stripe Refund pays the sender back)
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
  (Bridge's per-send fee is typically non-refundable → the accrual stays as provider_fees
   expense, our cost. If Bridge does not in fact bill for a payout that failed, the
   over-accrual comes back as a CREDIT in the month's invoice true-up, not as a reversal here.
   The funding_receivable / ACH-clearing leg settles independently per the happy-path entries.
   The Stripe refund is ASYNC — issued now, settles in ~5–10 business days; REFUNDED means
   issued. A later refund.failed webhook pages ops (sender still owed) and never auto-adjusts.)

PAYOUT_FAILED → REFUNDED  (undo mode VOIDED — PR-S2. Under real ACH timing this is the MAIN
  Stripe path: settlement is ~T+4 and payouts fail in minutes, so the PI is still `processing`
  and the adapter CANCELS the pull — the sender is made whole by never being debited)
  1) Bridge returns the $98 (unchanged — the payout principal really did come back):
     DR cash_clearing        98
     CR due_from_bridge      98
  2) Settle REFUNDED by reversing the FUNDED batch — no cash moves, and the canceled pull's
     receivable closes instead of waiting for an ACH that will never clear:
     DR transfer_payable     98
     DR fee_revenue           2     ← fee not earned; the sender never paid
     CR funding_receivable  100
  (End state: cash holds exactly the returned principal (+98 against the −98.08 float draw →
   net −slippage), every position closed. Posting the refunded-mode batch here instead would
   credit cash_clearing $100 that never left and strand funding_receivable open forever —
   the mode branch in services/refunds.ts exists for exactly this.)

PAYOUT_FAILED → REFUNDED  (BEFORE SUBMITTED — #254. The submit never reached Bridge, or the
  funded sender was rejected by Bridge (K6). No principal ever left, so there is NO bridge_return
  batch: posting one would credit due_from_bridge for a return that never happened — that
  account is only opened by the SUBMITTED batch — and claim cash we do not hold.
  services/refunds.ts skips it whenever provider_transfer_ref is null; the operator CLI's
  interlock passes on `not_submitted` and verifies the REFUNDED batch alone.)
  1) — nothing to book: nothing left —
  2) Settle REFUNDED exactly as above, by undo mode: REFUNDED-mode books the cash refund
     (DR transfer_payable 98 / DR fee_revenue 2 / CR cash_clearing 100); VOIDED-mode reverses
     the FUNDED batch (DR transfer_payable 98 / DR fee_revenue 2 / CR funding_receivable 100).
  (End state: the submitted case minus the bridge_return pair — due_from_bridge was never
   opened, so it never needs closing. The sender is made whole identically.)

FUNDING_REVERSED  (ACH return / chargeback after COMPLETED — money delivered, irreversible)
  DR loss_funding_reversed  100
  CR cash_clearing          100     ← when the funding had CLEARED
  CR funding_receivable     100     ← when it had NOT (the pull will never settle)

  (POLICY, decided 2026-09-10: book the STRAIGHT LOSS at dispute creation rather than opening a
   user receivable and writing it off later. The ledger is append-only, so a dispute we later WIN
   or recover is a correcting CREDIT on its own transition — never a rewrite of this batch. The
   receivable alternative is honest too, but it means carrying per-sender collection bookkeeping
   for an event that at this scale is rare and usually unrecoverable.

   The CREDITED ASSET is state-dependent for the same reason as the refund pair above: crediting
   cash_clearing for funding that never cleared claims a withdrawal from money we never held and
   strands funding_receivable open forever. applyFundingReversed picks by transfers.funding_cleared.

   Amount is send + fee, the whole sum collected. A PARTIAL dispute would over-book; at this
   volume that pages for a human rather than silently prorating.

   PRE-DELIVERY disputes post NOTHING. A dispute on a FUNDED transfer whose payout has not left
   places a `funding_disputed` hold instead: nothing is lost while the pesos are still ours, and
   booking a loss there would invent one. This is the loss the risk engine exists to prevent.)

UNDER_REVIEW → REFUNDED  (entry from COMPLETED — post-delivery Reg E correction, NOT a reversal;
  undo mode REFUNDED — the funding had settled)
  DR loss_cancellation_correction  S+F
  CR cash_clearing                 S+F
  (A correction payment is a NEW debit against Puente. The original COMPLETED entries remain
   intact — we never rewrite delivered history. Structurally unlike the PAYOUT_FAILED refund
   below it: that one DEBITS transfer_payable because the obligation was still open, whereas
   here the COMPLETED batch already discharged it and there is nothing left to reverse.
   Fee rides with it — the sender is made whole.)

UNDER_REVIEW → REFUNDED  (undo mode VOIDED — PR-S2. The LIKELY correction case: delivery
  precedes ACH settlement by days, so the adapter cancels the still-processing pull and the
  sender is made whole by never being charged)
  DR loss_cancellation_correction  S+F
  CR funding_receivable            S+F
  (Same P&L as the refunded arm — loss S+F, fee stays earned as booked — but the credited
   ASSET differs: no cash leaves, and the receivable is written off directly because the
   canceled pull will never clear. The compliance loss is real either way: we delivered pesos
   and collected nothing.)

  Its OWN account, not loss_funding_reversed (slice-7 PR6b). Both are post-delivery losses,
  but an ACH return is a credit/fraud loss while this is a COMPLIANCE cost — we chose to
  honour a timely cancellation on a transfer that had already been delivered. Sharing one
  bucket means the ledger cannot answer "what did Reg E cost us" without a per-transfer join,
  and the two get harder to separate the longer they are mixed.

  Pre-delivery exits (entry from FUNDED, SUBMITTED, or IN_FLIGHT) never reach UNDER_REVIEW at
  all — that is the point of the state-keyed rule. A cancel at FUNDED pre-claim is a CANCELED
  void; a cancel at SUBMITTED/IN_FLIGHT is RECORDED as a pending cancellation_request and
  waits for the payout to resolve, then takes the PAYOUT_FAILED refund posting (payout failed)
  or the correction posting above (payout delivered). Nothing about a cancellation posts to
  the ledger before the payout resolves — an open request is evidence, not a movement.
```

### Rail note — manual and onramp funding post the SAME batches (2026-08-26)

The manual rail's operator-asserted `FUNDED` and the onramp rail's guard-verified `FUNDED` post
the standard FUNDED batch above; their cleared assertions post the standard ACH CLEARS leg. What
differs per rail is the **trigger and its verification** (operator to-the-cent check vs the
delivered-amount guard), never the accounting. The onramp settlement webhook additionally chains
the automatic float top-up (previous section) after its cash leg — three legs, each idempotent on
its own key, so out-of-order and redelivered webhooks replay clean.

## Invariants (must always hold)

- Every `ledger_transaction` nets to zero in USD.
- `account balance = SUM(its entries)`; recomputed, never stored.
- No entry is ever updated or deleted; corrections are new transactions.
- Each money-moving transition produces exactly one `ledger_transaction`, idempotent on
  `(transfer_id, transition)`. Enforced by a `UNIQUE(transfer_id, transition)` constraint on
  `ledger_transactions`; a conflicting insert is a no-op (`ON CONFLICT DO NOTHING`), so retried
  workers are safe.
- **Conservation:** across a completed transfer, P&L = `fee_revenue − provider_fees − fx_slippage`
  (a favorable slippage credit adds to it). **CASH** gained is `fee_revenue − fx_slippage` until
  Bridge's invoice is paid, because `provider_fees` accrues against `bridge_fees_payable` rather
  than moving money; paying the invoice closes the gap. The two identities differed by roughly the
  whole margin at pilot size, which is why the accrual exists.
- `provider_onboarding_fees` is deliberately **outside** both identities: it is a one-time cost of
  acquiring a customer, not a cost of any one transfer, and averaging it into per-transfer margin
  would make unit economics unreadable (on the first invoice it was 63% of the bill).

## Float exposure & the ceiling

Outstanding fronted float = `SUM(funding_receivable)` not yet cleared. The **float ceiling** guardrail
(see state machine) caps this aggregate: block `FUNDED → SUBMITTED` when fronting a transfer would
push the total past the configured ceiling. The number comes straight from this account — no extra
bookkeeping.

## FX & provider economics

**⚠️ Bridge's take is the FX spread PLUS explicit per-transaction fees, billed monthly (first real
invoice INV19341, 2026-09-11, $10.30).** This paragraph used to say the opposite, on the strength
of PoC receipts (ACH→USDC onramp `9f1acb84…`, USDC→ACH payout `b3746f1a…`) that returned
`developer_fee`, `exchange_fee` and `gas_fee` all **0.0** with `final_amount = initial_amount`. The
receipts are accurate and the inference from them was wrong: **Bridge's per-transfer receipts are
not where its per-transfer fees appear.** They appear on a monthly invoice, and the read-it-off-the-
receipt expectation encoded here is why `provider_fees` sat at **zero entries in production** while
a real bill existed.

The FX spread half is still true — Bridge's cross-currency margin is baked into `buy_rate` vs
`midmarket_rate` — it is simply not the whole cost. What the first invoice actually charged:

| Line | Qty | Rate | Amount | Books to |
|---|---|---|---|---|
| SPEI Fee | 2 | $1.00 | $2.00 | `provider_fees` (accrued per payout) |
| Orchestration Volume Fee | $118.05 | 0.25% | $0.30 | `provider_fees` (accrued per payout) |
| Next Day ACH Fee | 3 | $0.50 | $1.50 | `provider_fees` (at invoice — attaches to treasury top-ups, not sends) |
| Gas | 0.006472 | $1.00 | $0.01 | `provider_fees` (at invoice — unpredictable) |
| Individual Compliance Fee (created accounts) | 3 | $2.00 | $6.00 | `provider_onboarding_fees` |
| Wallet Fee (active/created) | 2 | $0.25 | $0.50 | `provider_onboarding_fees` |

**`SPEI $1.00 per payout` is the load-bearing number for pricing.** It is flat and never amortizes
— 100bps at $100, 25bps at $400, 10bps at $1,000 — which is why every competitor charges a flat fee
and why a pure-bps price cannot work.

Note the printed lines sum to **$10.31** while the invoice bills **$10.30**: Bridge rounds the
TOTAL, not each line (orchestration is $0.295125, gas $0.006472). The invoice total is what we pay
and is therefore authoritative; the recorder absorbs the difference into the unaccrued bucket rather
than rejecting its own bill (`INVOICE_ROUNDING_TOLERANCE_MINOR`).

**Quote basis.** Quotes are built from Bridge's **`buy_rate`** (the executable side), not
`midmarket_rate`; the ERD's `source_rate` = buy_rate at quote time, and customer rate = buy_rate − our
buffer. We do **not** use `developer_fee` to collect Puente's fee inside the transfer — Stripe collects
`total_amount` including our fee, so `developer_fee` is `"0"` and `fee_revenue` books at `FUNDED`.

**`provider_fees` is ACCRUED per transfer and trued up monthly.** Booking Bridge's cost only when
the invoice lands would leave per-transfer margin unknowable until the following month, and the flat
SPEI fee is the single biggest input to whether a send is profitable at all. So the cost the
transfer itself predicts is recognized at `SUBMITTED`, and the invoice corrects the estimate:

```
SUBMITTED     DR provider_fees        F          ← F = BRIDGE_SPEI_FEE_MINOR
              CR bridge_fees_payable  F               + BRIDGE_ORCHESTRATION_BPS × principal

INVOICE BOOKED  (scripts/record-provider-invoice.ts, key provider_invoice:<id>:booked)
              DR provider_onboarding_fees  O     ← one-time per-customer lines
              DR provider_fees             X + V ← unaccrued lines + variance; a CREDIT when we
              CR bridge_fees_payable       O+X+V   over-accrued (e.g. a payout that never ran)
              (V = invoiced accruable − accrued in the service period. Nothing posts at all when
               O, X and V are all zero — the accrual already carried the whole invoice.)

INVOICE PAID  (--pay, key provider_invoice:<id>:paid)
              DR bridge_fees_payable  T          ← T = the invoice total
              CR cash_clearing        T
```

Unit economics per transfer:
`fee_revenue − (Bridge FX spread inside buy_rate + accrued provider_fees + Stripe funding fee)`,
with `provider_onboarding_fees` carried separately as acquisition cost.

⚠️ **The orchestration BASIS is unverified.** The first invoice charged 0.25% of **$118.05**, which
does not reconstruct from the three transfer principals alone — treasury top-ups appear to count
too. We accrue on the transfer principal as the best available estimate; the monthly variance in
the `provider_fee_accrual` reconciliation check is the instrument that settles it. Re-aim the basis
when the variance says so, not before.

**The invoice is recorded by a human, and nothing reconciles what nobody records.** Bridge sends a
PDF; an operator transcribes it and runs `apps/api/scripts/record-provider-invoice.ts` (dry run by
default). The daily reconciliation flags both halves of the gap: an invoice that disagrees with the
accrual, and accrual days that no recorded invoice covers — see
[runbooks/reconciliation.md](runbooks/reconciliation.md).

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

Bridge's **monthly invoice** is one of those external truths, and since 2026-09-11 it has a table
(`provider_invoices`) and a check (`provider_fee_accrual`) rather than living only in an inbox. The
check compares booked accruals for a service period against the invoice's own accruable lines, so a
Bridge pricing change surfaces as a variance finding instead of silently eating margin — and flags
accrual days no recorded invoice covers, because a book that reconciles and a book nobody
reconciles look identical from the variance side alone.
