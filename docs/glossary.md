# Glossary

**Date:** 2026-07-13 · One sentence per term, linking to the doc that owns it. Read once early;
refer back as needed.

## Regulation & compliance

- **Reg E** — the federal Electronic Fund Transfer regulation; its Remittance Transfer Rule
  (subpart B) governs our disclosures, cancellation, and error resolution. Owner:
  [transfer-state-machine.md](transfer-state-machine.md) + proposals.
- **§1005.33 (error resolution)** — the sender's right to dispute a remittance error up to 180 days
  after the disclosed delivery date; we investigate within 90 days. See
  [runbooks/proposals/error-resolution.md](runbooks/proposals/error-resolution.md) (unadopted draft).
- **§1005.34 (cancellation)** — the mandatory 30-minute cancellation right after payment, which
  survives until funds are *picked up or deposited* (there is no "already submitted to partner"
  exception); our enforcement is the `FUNDED`-state cancel action plus the state-keyed refund rule
  (post-submission timely cancel → full refund within 3 business days). See the state machine doc.
- **Prepayment disclosure / receipt** — the two Reg E documents we must show (rate, fees, MXN
  amount, rights); stored immutably in the `disclosures` table. See [erd.md](erd.md).
- **FCRA** — Fair Credit Reporting Act; why the credit-score endpoint requires `fcraConsentAt`
  before any CRS call. See CLAUDE.md security rules.
- **TCPA** — telephone/SMS consent law; why SMS OTP requires a prior consent record.
- **E-SIGN** — consent to receive documents electronically; its own timestamped consent row.
- **OFAC** — sanctions screening; division of responsibility with Bridge is an open item in
  [pre-implementation-todo.md](pre-implementation-todo.md).
- **BSA / SAR** — Bank Secrecy Act and Suspicious Activity Reports; Bridge holds the licenses, but
  SAR-filing ownership must be papered (open item).
- **CTR** — Currency Transaction Report, the $10k reporting threshold that applies underneath us
  regardless of our own limits.
- **MTL** — Money Transmitter License; Bridge holds them, which is the entire reason Puente can
  operate without being a licensed transmitter itself.
- **Metro 2** — the credit-bureau reporting format (future lending/furnisher stack, not remittance).
- **NACHA / ACH return codes** — the ACH network's rulebook; return codes tell you why a debit
  bounced: R01/R09 = insufficient funds (usually innocent), R05/R07/R10/R11 = unauthorized/revoked
  (treat as fraud), R02/R03/R04 = account closed/invalid. See
  [runbooks/proposals/funding-reversal.md](runbooks/proposals/funding-reversal.md).

## Mexico rails

- **SPEI** — Mexico's real-time interbank payment system (24/7, settles in seconds); Bridge's
  payout rail for MXN.
- **CLABE** — the 18-digit standardized Mexican bank account number a recipient's payout goes to.
- **Endorsement** — Bridge's per-customer capability grant (e.g. `spei`) required before that
  customer can use a given rail; we request it at KYC-link creation.

## Money & ledger

- **Minor units** — all money is integer cents (`amountMinor` + `currency`), never floats; the
  `Money` type in `packages/shared` enforces this.
- **Double-entry** — every financial event posts balanced debits and credits that net to zero;
  balances are derived by summing entries, never stored. Owner: [ledger-rules.md](ledger-rules.md).
- **Normal balance** — which direction (debit/credit) increases an account; assets/expenses are
  debit-normal, liabilities/revenue credit-normal.
- **`funding_receivable`** — asset account tracking ACH money initiated but not yet cleared: what
  the sender's bank still owes us.
- **`due_from_bridge`** — asset account tracking funds handed to Bridge whose delivery isn't
  confirmed yet.
- **Float / float ceiling** — the cash we front before ACH clears under instant payout; the crude
  aggregate version is live in slice 5 (submit job checks `funding_receivable` vs
  `FLOAT_CEILING_MINOR`; a trip leaves the transfer `FUNDED` with no hold and the sweep retries as
  the balance drains), while the authoritative float controls are slice 8.
- **`fx_slippage`** — expense account absorbing the difference between the rate we quoted the
  customer and Bridge's actual rate at execution (Bridge offers no rate lock).
- **Idempotency key** — a unique token making a retried money operation apply exactly once; used on
  client POSTs, Bridge submissions, and ledger postings (`(transfer_id, transition)`).
- **Transactional outbox** — pattern where the state change and its follow-up job commit in the
  same DB transaction, so neither can happen without the other; we deliberately chose
  enqueue-after-commit + sweep healing instead (PostgREST RPC and pg-boss can't share a
  transaction, and idempotent jobs make a lost enqueue cost only sweep latency). See
  [decisions.md](decisions.md), 2026-07-20.

## Puente & Bridge mechanics

- **Stablecoin sandwich** — Bridge has no direct fiat→fiat route; every transfer runs
  fiat → USDC → fiat internally (USD→MXN, and even USD→USD as our PoC proved).
- **`funding_cleared` gate** — the per-transfer flag + policy controlling whether we wait for ACH
  settlement before paying out; MVP policy is "don't wait" for ~5 trusted users, and the flag exists
  so flipping it later requires no rework. See the state machine doc.
- **Submit claim** — the guarded UPDATE (`state = 'FUNDED' AND payout_hold_reason IS NULL AND
  submit_attempted_at IS NULL`) the payout job wins before calling Bridge; it serializes submission
  against the slice-6 cancel so both can never happen. See the state machine doc.
- **Void** — the undo of an *uncleared* funding collection: a `FUNDED`-pre-claim transfer the sender
  cancels within the Reg E window; the inbound ACH is canceled before it settles, so no money moved
  and the ledger is a **clean reversal** of the `FUNDED` batch (no `refunds_payable`, no float).
  Serialized against the **Submit claim** by the `cancel_transfer` guard. Contrast **Refund**. See
  [transfer-state-machine.md](transfer-state-machine.md).
- **Refund** — the return of funds that *did* move, paid back to the sender from float
  (`refunds_payable` → `cash_clearing`): the `PAYOUT_FAILED → REFUNDED` path after Bridge returns the
  principal, and later real-Stripe refunds. Distinct from a **Void** (nothing moved). See
  [ledger-rules.md](ledger-rules.md).
- **`REFUNDED`** — the terminal "sender made whole" state, reached from `CANCELED` (via a void) or
  `PAYOUT_FAILED` (via a refund); the ledger shows which. See
  [transfer-state-machine.md](transfer-state-machine.md).
- **Payout hold** — a `FUNDED` transfer with `payout_hold_reason` set (`fx_drift`, `payability`,
  or `submit_error`); the sweep skips it until ops releases it via
  [runbooks/payout-holds.md](runbooks/payout-holds.md).
- **Payment event** — a row in `payment_events` recording a raw Bridge transfer event (webhook or
  poll-synthesized), deduped on `(source, external_event_id)` and processed by one job; payloads
  are service-role only and never logged.
- **FX submission backstop** — the pre-submission guard that holds a payout (`fx_drift`) when the
  live Bridge buy rate drifts more than `FX_MAX_DRIFT_BPS` from the quote's `source_rate` or the
  quote is older than `FX_MAX_QUOTE_AGE_MINUTES`; never submit on unknown or dislocated rates.
- **Quote as our commitment** — Bridge's rate is indicative only, but Reg E requires firm numbers,
  so a Puente quote is *our* time-boxed offer (source rate minus a buffer) and we absorb the
  variance. See [erd.md](erd.md) quotes + ledger `fx_slippage`.
- **Risk tier** — per-user classification (`trusted`/`standard`/`elevated`) that will drive the
  funding gate and limits once the risk engine exists; MVP users are all `trusted`.
- **Truthful pending copy** — the product rule that status screens never promise what the system
  doesn't do (e.g. no "we'll email you" until email exists); established in lifecycle slice 5 (#48).
