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
- **§1005.34 (cancellation)** — the mandatory 30-minute cancellation window after payment; ours is
  enforced server-side in the `FUNDED` state only. See the state machine doc.
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
- **Float / float ceiling** — the cash we front before ACH clears under instant payout; the ceiling
  is the configured cap on aggregate `funding_receivable` and blocks new submissions when exceeded.
- **`fx_slippage`** — expense account absorbing the difference between the rate we quoted the
  customer and Bridge's actual rate at execution (Bridge offers no rate lock).
- **Idempotency key** — a unique token making a retried money operation apply exactly once; used on
  client POSTs, Bridge submissions, and ledger postings (`(transfer_id, transition)`).
- **Transactional outbox** — pattern where the state change and its follow-up job commit in the
  same DB transaction, so neither can happen without the other.

## Puente & Bridge mechanics

- **Stablecoin sandwich** — Bridge has no direct fiat→fiat route; every transfer runs
  fiat → USDC → fiat internally (USD→MXN, and even USD→USD as our PoC proved).
- **`funding_cleared` gate** — the per-transfer flag + policy controlling whether we wait for ACH
  settlement before paying out; MVP policy is "don't wait" for ~5 trusted users, and the flag exists
  so flipping it later requires no rework. See the state machine doc.
- **Quote as our commitment** — Bridge's rate is indicative only, but Reg E requires firm numbers,
  so a Puente quote is *our* time-boxed offer (source rate minus a buffer) and we absorb the
  variance. See [erd.md](erd.md) quotes + ledger `fx_slippage`.
- **Risk tier** — per-user classification (`trusted`/`standard`/`elevated`) that will drive the
  funding gate and limits once the risk engine exists; MVP users are all `trusted`.
- **Truthful pending copy** — the product rule that status screens never promise what the system
  doesn't do (e.g. no "we'll email you" until email exists); established in lifecycle slice 5 (#48).
