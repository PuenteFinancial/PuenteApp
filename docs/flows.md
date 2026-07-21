# Flow / Sequence Diagrams — USD → MXN Remittance

**Date:** 2026-07-10 · **Updated:** 2026-07-21 (slice 5 — payout lifecycle)
**Status:** slice-5-current
**Pairs with:** `transfer-state-machine.md` (states), `ledger-rules.md` (postings),
`api-contract.md` (routes), `architecture.md` (components)

The four flows the pre-implementation checklist calls for: send-money happy path, payout webhook,
error resolution, cancel/refund. States in `CAPS` are transfer states; ledger postings are named,
not restated (ledger-rules.md is authoritative).

## 1. Send money — happy path

```mermaid
sequenceDiagram
    autonumber
    actor S as Sender (mobile)
    participant API as Fastify API
    participant DB as Postgres
    participant W as Worker
    participant ST as Stripe
    participant BR as Bridge

    S->>API: POST /v1/quotes {destination, total_amount}
    API->>BR: GET /v0/exchange_rates (indicative)
    API->>DB: insert quote (our firm rate = source − buffer, expires_at)
    API-->>S: quote {send/fee/receive amounts, fx_rate}

    S->>API: POST /v1/transfers {quote_id} (Idempotency-Key)
    API->>DB: insert transfer PENDING_PAYMENT + prepayment disclosure
    API-->>S: transfer + disclosure

    S->>API: POST /v1/transfers/:id/confirm {disclosure_id, accepted} (Idempotency-Key)
    API->>DB: set disclosure_accepted_at
    API->>ST: create payment (ACH debit)
    API-->>S: funding details (client completes via Stripe SDK)

    ST-->>API: webhook: payment initiated/captured
    API->>DB: PENDING_PAYMENT → FUNDED (+ FUNDED ledger post, payment_at/cancelable_until set)
    Note over API,DB: dedupe = transition guard + ledger (transfer_id, transition) uniqueness — funding path never touches payment_events
    API->>DB: enqueue payout.submit (after commit) — 200 fast
    W->>DB: gate: payability + float ceiling + FX backstop, then atomic claim
    W->>BR: POST /v0/transfers (idempotency key = transfer)
    W->>DB: FUNDED → SUBMITTED (+ SUBMITTED ledger post)

    BR-->>API: webhook: state transitioned (see §2)
    Note over W,DB: … IN_FLIGHT → COMPLETED (+ COMPLETED ledger post)
    W-->>S: push notification + receipt available
    ST-->>API: webhook: ACH settled (days later)
    API->>DB: funding_cleared = true (flag only — no ledger post)
```

Key properties: jobs are enqueued after the state change commits and are idempotent replays — a
lost enqueue is healed by the 1-min sweep, never a correctness problem (enqueue-after-commit, not a
transactional outbox; see decisions.md 2026-07-20); every external money call carries an
idempotency key; webhooks are the source of truth for `FUNDED`, `IN_FLIGHT`, `COMPLETED`.

## 2. Payout webhook (Bridge → us)

```mermaid
sequenceDiagram
    autonumber
    participant BR as Bridge
    participant API as API /v1/webhooks/bridge
    participant DB as Postgres
    participant W as Worker

    BR-->>API: transfer.updated.status_transitioned {event_id, state: [old, new]}
    API->>API: verify signature (Bridge public key)
    API->>DB: insert payment_events UNIQUE(source, external_event_id)
    alt duplicate event_id
        API-->>BR: 200 (already processed — no-op)
    else new event
        API-->>BR: 200 (ack fast, process async)
        W->>DB: map Bridge state → our transition (table below)
        W->>DB: write transfer_transition + ledger post + audit log
        W-->>W: push notification on terminal states
    end
```

### Bridge state → Puente transition map

Bridge states never move backwards: `awaiting_funds → funds_received → payment_submitted →
payment_processed`, with failure states off to the side.

| Bridge state | Puente transition |
|---|---|
| `awaiting_funds` / `funds_received` | (no-op — we're already `SUBMITTED`) |
| `payment_submitted` | `SUBMITTED → IN_FLIGHT` |
| `payment_processed` | `IN_FLIGHT → COMPLETED` |
| `undeliverable`, `error`, `canceled` | `SUBMITTED`/`IN_FLIGHT → PAYOUT_FAILED` → refund flow |
| `returned`, `refunded`, `refund_in_flight` | `PAYOUT_FAILED` path — Bridge returning principal (ledger deferred — slice 6) |
| `refund_failed` | `PAYOUT_FAILED` + **ops alert** — principal stuck at Bridge (stuck-transfer runbook) |
| `in_review` | **no state change**; transfer stays `SUBMITTED`/`IN_FLIGHT`. Observed in sandbox (2026-07-13) as a routine *transient initial state* on payout creation, resolving to `funds_received` in seconds — so alert only when it **persists** (> 1h), which indicates a real Bridge-side review/AML hold |
| *unmapped / unknown state* | **no-op** — the processor marks the event `ignored` and never crashes on a never-before-seen Bridge state |

Missed webhooks are backstopped by reconciliation (cron polls `GET /v0/transfers` for
non-terminal transfers — see reconciliation runbook).

**Payout topology (resolved 2026-07-13):** one Puente transfer = one Bridge payout leg from the
pre-funded treasury wallet — authoritative write-up in the **Bridge wallet id** note in
[`erd.md`](erd.md).

## 3. Error resolution (Reg E §1005.33) — dispute

```mermaid
sequenceDiagram
    autonumber
    actor S as Sender
    participant API as API
    participant DB as Postgres
    participant OPS as Ops (human)
    participant BR as Bridge

    S->>API: POST /v1/transfers/:id/disputes {type, description}
    API->>DB: insert dispute (open)
    alt transfer in FUNDED / SUBMITTED / IN_FLIGHT / COMPLETED
        API->>DB: → UNDER_REVIEW (transition logged)
    else terminal state
        API->>DB: dispute recorded, no state change
    end
    API-->>S: dispute id + required timelines (ack)

    OPS->>DB: investigate (transitions, ledger, payment_events)
    OPS->>BR: check payout facts (delivered? amount? CLABE?)
    alt error confirmed
        OPS->>DB: UNDER_REVIEW → REFUNDED (correction/refund ledger post per entry point)
        OPS-->>S: written explanation + refund/correction
    else no error
        OPS->>DB: UNDER_REVIEW → COMPLETED
        OPS-->>S: written explanation + documents on request
    end
```

Only two exits, ops-driven, never self-resolving. Deadlines, notice content, and the investigation
checklist live in `runbooks/proposals/error-resolution.md`.

## 4. Cancel / refund

```mermaid
sequenceDiagram
    autonumber
    actor S as Sender
    participant API as API
    participant DB as Postgres
    participant W as Worker
    participant ST as Stripe

    S->>API: POST /v1/transfers/:id/cancel (Idempotency-Key)
    API->>DB: SELECT ... FOR UPDATE (row lock on transfer)
    alt state = FUNDED and submit_attempted_at is null
        API->>DB: FUNDED → CANCELED (commits only if still FUNDED and unclaimed — TOCTOU guard)
        API-->>S: 200 canceled
        W->>DB: CANCELED ledger post (ACH in flight vs not — two variants)
        W->>ST: refund / release payment
        W->>DB: CANCELED → REFUNDED (+ refund paid post)
        W-->>S: push: refunded (full amount incl. fee, within 3 business days)
    else already claimed / SUBMITTED / IN_FLIGHT
        API-->>S: state-keyed refund path (timely Reg E cancel → full refund; see below)
    end
```

The same row lock protects the other side: the submit job's atomic claim (`submit_attempted_at`,
guarded on `state = 'FUNDED'`) and the cancel guard (`submit_attempted_at IS NULL`) serialize on the
row — cancel and payout can never both win. A timely §1005.34 cancel that arrives after the claim is
NOT a 409: the right survives until pickup/deposit, so it is honored as a full refund once the
payout resolves (state-keyed refund rule, slice 6 — see transfer-state-machine.md).

`PAYOUT_FAILED → REFUNDED` (Bridge can't deliver) follows the same refund tail: Bridge returns
principal → recognize `refunds_payable` (full amount incl. fee) → pay refund → notify sender.
