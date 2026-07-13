# Runbook — Error Resolution (Reg E §1005.33)

**Date:** 2026-07-10 · **Status:** ⚠️ **PROPOSAL — not adopted.** Drafted unprompted during design review; the ops process itself is undecided. Also needs counsel review.
**Trigger:** a sender reports a problem with a transfer (in-app dispute, SMS, email, or verbally).
**State:** `UNDER_REVIEW` (from `FUNDED`/`SUBMITTED`/`IN_FLIGHT`/`COMPLETED`); exits to `REFUNDED` or `COMPLETED` only.

At MVP scale ops = Joshua, the "console" is Supabase Studio + the Stripe and Bridge dashboards, and
every action below must still write `transfer_transitions` / `disputes` rows through the API or a
recorded SQL script — never silent table edits.

## What counts as an "error" (§1005.33(a))

1. Sender paid an incorrect amount (we charged wrong).
2. Computational/bookkeeping mistake by us (fee, FX math on the disclosure).
3. Funds not available to the recipient by the **disclosed date of availability**.
4. Recipient received the wrong amount (with statutory exceptions, e.g. recipient-bank fees we disclosed).
5. Sender requested documentation/receipt and we failed to provide it.

**Not errors:** sender gave a wrong CLABE (but see §1005.33(h) — wrong-account safe harbor requires
us to have used reasonable verification), FX movement between quote and delivery when we delivered
the disclosed MXN amount, sender's change of mind (that's cancellation, see state machine).

## Deadlines (hard, statutory)

| Clock | Limit |
|---|---|
| Sender may report an error | **180 days** after disclosed availability date |
| We investigate and determine | **90 days** from receiving the notice |
| We report findings to sender | **3 business days** after completing the investigation |
| We remedy a confirmed error | **1 business day** (or as soon as reasonably practicable) after the sender picks a remedy |
| Records retained | **2 years** |

## Intake (same day)

1. Record the dispute: `POST /v1/transfers/:id/disputes` on the user's behalf if it arrived out-of-band
   (type: `non_delivery` | `wrong_amount` | `unauthorized` | `other`). This moves the transfer to
   `UNDER_REVIEW` (non-terminal states) and stamps `opened_at` — the 90-day clock.
2. Acknowledge to the sender (EN/ES per `preferred_locale`): what was reported, that we're
   investigating, and the deadline we're working to.
3. Note the disclosed availability date from the transfer's `disclosures` row — it anchors both the
   180-day eligibility check and error type 3.

## Investigation checklist

Work from our records first (§1005.33 requires review of our own records at minimum):

- [ ] `transfers` row: snapshotted terms (amounts, fx_rate, fee) vs what the disclosure shows.
- [ ] `transfer_transitions`: full state history with timestamps and actors.
- [ ] `ledger_entries` for the transfer: do postings match the terms? Net to zero?
- [ ] `payment_events`: Stripe events (was the sender debited the disclosed total?) and Bridge
  events (what did Bridge report delivering?).
- [ ] Bridge dashboard / `GET /v0/transfers/{id}`: terminal state, `receipt` (actual payout amount,
  rail, timestamps), destination CLABE last-4 vs the saved `payout_destination`.
- [ ] Stripe dashboard: charge amount, currency, any disputes/returns already open there.
- [ ] If non-delivery claimed but Bridge says `payment_processed`: request SPEI trace/confirmation
  from Bridge support (recipient bank credit evidence).

## Determination

**Error confirmed** → sender chooses the remedy (offer both where applicable):
- **Refund** — `UNDER_REVIEW → REFUNDED`. Ledger: pre-delivery entry points use the CANCELED/
  PAYOUT_FAILED postings for that stage; post-delivery is a **correction payment**
  (`DR loss_funding_reversed / CR cash_clearing`) — original entries stay intact (ledger-rules.md).
- **Resend at no cost** — post-delivery shortfall: new correction transfer for the difference, fees
  on us. (Modeled as a new transfer referencing the dispute; do not mutate the original.)
- Send written explanation with the correction, within the 3-business-day reporting window.

**No error** → `UNDER_REVIEW → COMPLETED`. Written explanation of findings; sender may request the
documents we relied on — provide them.

Both paths: `resolved_at` + `resolution` on the dispute row, audit log entry, and the transition must
be one of the two legal exits (anything else is a state-machine violation).

## Escalations

- Investigation needs Bridge and they're slow → open a Bridge support ticket immediately; the 90-day
  clock does not pause.
- `unauthorized` type (someone else initiated it) → also treat as an account-security incident:
  freeze the profile (`status = suspended`), review `sign_in_events`, rotate sessions.
- Any pattern of repeat disputes from one user → flag before their next transfer (risk-engine input later).
