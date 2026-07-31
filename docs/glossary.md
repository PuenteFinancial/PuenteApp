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

## Risk & limits

- **Committed send** — a transfer whose sender has accepted the terms (`disclosure_accepted_at` set)
  and which hasn't been unwound (not `CANCELED`/`REFUNDED`/`PAYMENT_FAILED`/`FUNDING_REVERSED`); the
  unit the per-user transaction limits count. See [decisions.md](decisions.md) (slice 7 PR5).
- **Funded send** — a transfer that reached `FUNDED` (`payment_at` set). Funded means the ACH debit
  was *submitted to the network and we fronted the payout* — NOT that money arrived: with Stripe,
  `FUNDED` fires on `payment_intent.processing`, and settlement (**cleared** — PI `succeeded`,
  `funding_cleared` flag) lands ~T+4 later. The gap is the ACH exposure window: a funded-not-cleared
  pull can still fail, be reversed — or be **voided** (canceled, sender never debited), which is how
  the PR-S2 refund tails usually make a sender whole. Distinct from a *committed* send: every funded
  send was committed, but a just-committed send may not fund for days.
  See [transfer-state-machine.md](transfer-state-machine.md).
- **Transaction limits (AML launch)** — the per-user caps on the send principal from the AML
  "Transaction Limits at Launch" policy: per transaction (`RISK_PER_TXN_MAX_MINOR`) and rolling
  day / month / 6-month totals (`RISK_DAILY_MAX_MINOR` / `RISK_MONTHLY_MAX_MINOR` /
  `RISK_SEMIANNUAL_MAX_MINOR`), plus a per-day send count (`RISK_VELOCITY_MAX_COUNT`). Enforced at
  confirm and backstopped at `FUNDED → SUBMITTED`. See [decisions.md](decisions.md).
- **Uncleared-exposure cap (slice-8 O3)** — the per-user *count* limit on funded-not-cleared
  exposure: at most `RISK_UNCLEARED_MAX_COUNT` (default 1) committed sends whose ACH pull hasn't
  settled, slot held from disclosure acceptance until `funding_cleared` (or unwind), no time
  window. `403 transfer_in_progress` at quote/create/confirm; self-healing older-wins wait at
  `FUNDED → SUBMITTED`. See [decisions.md](decisions.md).
- **First-transfer hold (`FIRST_TRANSFER_HOLD`, ships OFF)** — flag-gated slice-8 O3 policy: a
  sender with no cleanly cleared send yet (none with `funding_cleared` outside `FUNDING_REVERSED`)
  waits for their **own** settlement before the MXN payout submits. Silent skip, no hold reason;
  the sweep resumes it on clearing.
- **Per-user outstanding-uncleared cap** *(deferred)* — the future per-user **dollar** limit on
  un-settled ACH exposure (ERD `user_limits.daily_max_minor` et al.); still deferred, since
  `funding_receivable` doesn't drain today — the O3 *count* cap above is the pilot control.
  See [erd.md](erd.md).

## Puente & Bridge mechanics

- **Stablecoin sandwich** — Bridge has no direct fiat→fiat route; every transfer runs
  fiat → USDC → fiat internally (USD→MXN, and even USD→USD as our PoC proved).
- **`funding_cleared` gate** — the per-transfer flag + policy controlling whether we wait for ACH
  settlement before paying out; MVP policy is "don't wait" for ~5 trusted users, and the flag exists
  so flipping it later requires no rework. The flag is a webhook MIRROR of settlement, not the
  authority: the Stripe adapter's settlement-aware undo (PR-S2) reads the live PaymentIntent
  instead. See the state machine doc.
- **Instant verification** — Financial Connections instant bank verification, the ONLY verification
  method at pilot (`verification_method: 'instant'` on the PaymentIntent). Microdeposits are
  deferred: their multi-day dwell collides with the 30-min `PENDING_PAYMENT` auto-fail and the
  15-min FX lock. An unsupported bank gets a clean error, not a fallback.
  See [decisions.md](decisions.md) (PR-S1).
- **Submit claim** — the guarded UPDATE (`state = 'FUNDED' AND payout_hold_reason IS NULL AND
  submit_attempted_at IS NULL`) the payout job wins before calling Bridge; it serializes submission
  against the slice-6 cancel so both can never happen. A *stale* submit claim (>10 min, no
  `provider_transfer_ref`) is re-enqueued and recovered by an idempotent Bridge re-POST — safe because
  Bridge dedupes on the key. Contrast the **Refund claim**, which resolves the same situation the
  opposite way and for a specific reason ([decisions.md](decisions.md) 2026-07-28). See the state
  machine doc.
- **Refund claim** — the guarded UPDATE (`refund_payment_ref IS NULL AND refund_claimed_at IS NULL`)
  one run wins before calling the funding processor's refund, recording `refund_claimed_at` and
  `refund_claimed_by`. It is what makes the `PAYOUT_FAILED → REFUNDED` disbursement exactly-once: the
  `refund_payment_ref` null-check alone is a read separated from its write, and the mock processor
  ignores the idempotency key. Kept after success (it records when the money left); cleared in exactly
  one place, `releaseStaleRefundClaim`. See [ledger-rules.md](ledger-rules.md) and the state machine doc.
- **Abandoned refund claim** — a **Refund claim** over 10 minutes old with no `refund_payment_ref`: the
  run that took it died between claiming and recording the disbursement, so the sender **may or may not
  have been paid**. Never retaken automatically — ops confirms in the processor, then re-runs
  `trigger-refund.ts --reclaim` ([runbooks/manual-refund.md](runbooks/manual-refund.md)). Distinct from
  a **Payout hold** (a `FUNDED` transfer ops releases) and from *stuck at Bridge* (the principal never
  came back — escalate, never refund). A claim under 10 minutes is simply *taken*: a healthy in-flight
  refund, nothing to do.
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
- **Pending cancellation request** — a row in `cancellation_requests` recording that the sender asked
  to cancel a transfer already on its way to payout (the `SUBMITTED`/`IN_FLIGHT`/`FUNDED`-post-claim
  202). It is EVIDENCE, not a movement: nothing posts to the ledger while one is open. At most one is
  open per transfer (a partial unique index), so a second tap resolves to the first — the statutory
  clock starts when they FIRST asked and must never restart. Explicitly **not** a dispute; see
  [decisions.md](decisions.md) 2026-07-28.
- **Timely cancellation request** (`within_window`) — a request made before the transfer's
  `cancelable_until`: §1005.34's **first** condition (the 30-minute clock), computed once inside the
  recording RPC and then frozen. The statute's **second** condition — the request preceded the
  deposit — is evaluated at resolution against deposit evidence, because only Bridge knows the
  deposit time. Both must hold for an automatic obligation; a request failing either is still
  recorded and still resolved by a human on the record. Timeliness is **recorded, not enforced at
  the door** — the 202 fires on state alone.
- **Correction payment** — the post-delivery refund owed on a cancellation that was in-window AND
  **beat the deposit**, whose payout COMPLETED anyway: the recipient keeps the money and the sender is made whole regardless, the
  accepted bounded double-pay. Booked `DR loss_cancellation_correction / CR cash_clearing` — a NEW
  expense against Puente, not a reversal, because the `COMPLETED` batch already discharged
  `transfer_payable` and delivered history is never rewritten. Contrast **Refund** (the payout
  failed, so an obligation was still open to reverse). Executed by a human via
  [runbooks/pending-cancellation.md](runbooks/pending-cancellation.md), never automatically.
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
  Applied again in slice-7 PR6b: the shipped `underReview` body said *"we'll contact you as soon as
  the review is done"* with no outbound notification mechanism in the codebase, and now promises only
  what the polling tracker actually does — update in place.
- **Transaction history** — the sender-facing list of their *money-moved* transfers (`FUNDED` and
  beyond), served by `GET /v1/transfers?scope=history`; never-funded attempts
  (`PENDING_PAYMENT`/`PAYMENT_FAILED`) are filtered out. A product VIEW, not the `transfers` table —
  abandoned rows are retained for audit/ledger but not shown. See [decisions.md](decisions.md) 2026-07-24.
- **Abandoned send** — a transfer created at the "Continue" step (`POST /transfers` →
  `PENDING_PAYMENT`) that the sender never funds; the `transfer.reconcile-pending` cron flips it to
  `PAYMENT_FAILED` after 30 min (a zero-ledger dead row). Excluded from **Transaction history**. See
  [transfer-state-machine.md](transfer-state-machine.md).
