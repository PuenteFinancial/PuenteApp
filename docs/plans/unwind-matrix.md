# The unwind matrix

**Status:** draft for review, 2026-09-14. Describes what is IN the code today
(verified against `apps/api/src/services/transfers.ts` at `231490c`) and what is
missing. **Proposes no refactor** — see "What to do with this".

## Why this exists

Fourteen ledger builders live in `transfers.ts`. Three move a transfer forward.
**Eleven exist to undo one.** They were each added when production produced a new
way for a transfer to end badly, so they read as eleven unrelated special cases.

They are not. They are one idea with two parameters, and writing the grid out
shows both the duplication and the cells nobody has hit yet.

## The one idea

Money leaves Puente in exactly one of three places, and an unwind is always
the same two decisions:

1. **What obligation are we discharging?** (the debit side)
2. **Which asset pays for it?** (the credit side)

That is the whole space. Every builder below is a coordinate in it.

### Where the money actually is

```mermaid
flowchart LR
    S["Sender bank (ACH)"] -->|ACH initiated| FR["funding_receivable"]
    FR -->|ACH settles| CC["cash_clearing"]
    CC -->|payout submitted| DFB["due_from_bridge"]
    DFB -->|delivered| R["Recipient"]
```

An unwind credits whichever of those three the money is sitting in **right now**.
Pick the wrong one and you invent money.

## The accounts, by role in an unwind

| Account | Type | Role |
|---|---|---|
| `funding_receivable` | asset | ACH initiated, not yet settled — the pull can still be cancelled |
| `cash_clearing` | asset | Settled. We are holding the sender's money |
| `due_from_bridge` | asset | Principal is at Bridge, in transit to the recipient |
| `transfer_payable` | liability | Our obligation to deliver |
| `refunds_payable` | liability | Recognized debt to the sender, not yet paid |
| `fee_revenue` | revenue | Our fee, debited back when a transfer is undone |
| `loss_cancellation_correction` | expense | Recipient got paid AND Reg E still owes the sender |
| `loss_funding_reversed` | expense | Chargeback or ACH return took the money back |

## The forward path, for contrast

| Transition | Debit | Credit |
|---|---|---|
| `FUNDED` | `funding_receivable` (total) | `transfer_payable` (principal) + `fee_revenue` (revenue) |
| `funding_cleared` | `cash_clearing` (total) | `funding_receivable` (total) |
| `COMPLETED` | `transfer_payable` (principal) | `due_from_bridge` (principal) |

Three postings. That is the entire happy path.

## The matrix

Rows are what is discharged. Columns are which asset pays.

| Discharged (row) / Paid from (column) | `funding_receivable`<br>(never collected) | `cash_clearing`<br>(we hold it) | `due_from_bridge`<br>(at Bridge) |
|---|---|---|---|
| **Transfer reversed**<br>`DR transfer_payable + fee_revenue` | `canceledLedgerEntries`<br>*(= `voidRefundLedgerEntries`, a literal alias)* | `refundedLedgerEntries` | — |
| **Debt paid**<br>`DR refunds_payable` | `refundOwedVoidedLedgerEntries` | `refundOwedPaidLedgerEntries` | — |
| **Loss — post-delivery correction**<br>`DR loss_cancellation_correction` | `correctionVoidLedgerEntries` | `correctionRefundLedgerEntries` | — |
| **Loss — funding reversed**<br>`DR loss_funding_reversed` | `fundingReversedVoidLedgerEntries` | `fundingReversedLedgerEntries` | **EMPTY — see gap 1** |

Two builders sit outside the grid, correctly:

- **`cancelRefundOwedLedgerEntries`** — `DR transfer_payable + fee_revenue / CR refunds_payable`.
  No asset leg at all. It *recognizes* the debt so the CANCELED state can commit
  before we know how the processor will pay. That mode-freedom is what makes the
  ordering safe, so it stays its own thing.
- **`bridgeReturnLedgerEntries`** — `DR cash_clearing / CR due_from_bridge`.
  Asset-to-asset. Not an unwind of an obligation — it is the principal coming
  home from Bridge, and it pairs with one of the rows above.

## What the matrix shows

Eleven builders = **4 discharge shapes × 2 settlement modes** (8), plus the
recognize step, plus the Bridge return, plus **one pure alias**. The pairing is
the duplication: every new trigger has cost two functions, one ending in `Void`,
because the same question — *has the sender's money settled yet?* — is re-answered
by a new pair of functions each time instead of by an argument.

That question is not ours. It is Stripe's API shape: `paymentIntents.cancel()`
before settlement, `refunds.create()` after.

## The collapse

One function replaces the eight paired builders:

```ts
type Discharge =
  | 'transfer_reversed'      // DR transfer_payable + fee_revenue
  | 'debt_recognized'        // CR refunds_payable (no asset leg)
  | 'debt_paid'              // DR refunds_payable
  | 'loss_correction'        // DR loss_cancellation_correction
  | 'loss_funding_reversed'  // DR loss_funding_reversed

type PaidFrom = 'funding_receivable' | 'cash_clearing' | 'due_from_bridge'

export function unwindEntries(
  transfer: TransferAmounts,
  discharge: Discharge,
  paidFrom: PaidFrom,
): LedgerEntryJson[]
```

Every existing builder becomes a call site. A new case becomes a **cell**, not a
function pair — and an unreachable combination becomes an explicit refusal rather
than a builder nobody wrote.

## Empty cells and boundaries

**Gap 1 — a disputed in-flight payout never books its loss.** `applyFundingReversed`
(`services/funding-apply.ts`) books the loss for `COMPLETED`, holds the payout for `FUNDED`, and for
`SUBMITTED` / `IN_FLIGHT` returns `in_flight` and posts nothing.

**Posting nothing there is correct.** The loss is not yet a known quantity: if the payout completes
the recipient keeps the pesos and we are out `send + fee`, but if it fails Bridge returns the
principal and we are out only the fee. Booking `send + fee` at in-flight would overstate the loss on
every payout that later fails.

The hole is one step later — **nothing books it when delivery resolves.** `payment-event-process.ts`
never reads `funding_disputed_at`, so a disputed transfer reaching `COMPLETED` or `PAYOUT_FAILED`
posts its ordinary batch and no loss at all. The only backstop is reconciliation's `stripe_disputes`
check paging a human.

Worse, the two coupled failure modes have no guard between them: `refunds.ts` never reads
`funding_disputed_at` either, so a disputed transfer whose payout then FAILS runs the ordinary refund
tail and **pays back a sender whose funding was already clawed back** — the money leaves twice. Today
`AUTO_REFUND` being off in prod means that parks at `PAYOUT_FAILED` for a human, so the guard is a
person, not the code.

The fix is therefore two things, and neither is "book it at in-flight": recognize the loss at the
transition that resolves delivery, when the amount is finally known, and refuse a refund on a
transfer whose funding was reversed.

**Boundary 1 — partial amounts.** Every builder posts `send + fee`. A partial
dispute or partial refund has no representation and deliberately pages instead
(documented in `fundingReversedLedgerEntries`). Fine at pilot volume. It stops
being fine the first time a card network splits a dispute.

**Boundary 2 — `refunds_payable` has a floor but no clock.** It is in
reconciliation's `OPEN_ITEM_ACCOUNTS`, so it cannot go negative. Nothing ages it:
a debt recognized and never paid is a legitimate resting state that no check will
ever complain about. `transfer_aging` watches transfer states, not this balance.

**Boundary 3 — `provider_fees` is never unwound.** Stripe keeps its processing fee
on a refund. When a transfer is undone, `fee_revenue` is debited back but
`provider_fees` stays. That is correct accounting, and it means **every unwind is a
real loss of the Stripe fee.** Worth knowing when pricing.

## What to do with this

**Not a refactor, not now.** The eleven builders are tested and correct. Churning
money code to make it elegant is how you introduce the bug the tests were
protecting you from.

Instead:

1. **Use it as the checklist.** When the next unwind case appears, find its cell
   first. If the cell is filled, call the existing builder. If empty, ask whether
   the whole row or column is missing.
2. **Close gap 1 deliberately**, since it is reachable today and a real dispute
   would hit it before the code was ready.
3. **Collapse when the fifth discharge shape arrives** — that is the point where
   adding builders nine and ten costs more than parameterizing.

The honest lesson: this matrix was derivable on day one from Stripe's API, Reg E
§1005.33/1005.34, and ordinary double-entry practice. The *cells* had to be
discovered from our specific Stripe + Bridge pairing. The *grid* did not.
