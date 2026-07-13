# Flow / Sequence Diagrams — USD → MXN Remittance

**Date:** 2026-07-10
**Status:** v1
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
    API->>DB: payment_events (dedupe) + enqueue job — 200 fast
    W->>DB: PENDING_PAYMENT → FUNDED (+ FUNDED ledger post, payment_at set)
    W->>DB: gate: funding_cleared policy + float ceiling + cancel window
    W->>BR: POST /v0/transfers (idempotency key = transfer)
    W->>DB: FUNDED → SUBMITTED (+ SUBMITTED ledger post)

    BR-->>API: webhook: state transitioned (see §2)
    Note over W,DB: … IN_FLIGHT → COMPLETED (+ COMPLETED ledger post)
    W-->>S: push notification + receipt available
    ST-->>API: webhook: ACH settled (days later)
    W->>DB: funding_cleared = true (+ ACH-clears ledger post)
```

Key properties: the state change and the "next step" job commit in one DB transaction (outbox);
every external money call carries an idempotency key; webhooks are the source of truth for
`FUNDED`, `IN_FLIGHT`, `COMPLETED`.

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
| `returned`, `refunded`, `refund_in_flight` | `PAYOUT_FAILED` path — Bridge returning principal (ledger: Bridge-returns post) |
| `refund_failed` | `PAYOUT_FAILED` + **ops alert** — principal stuck at Bridge (stuck-transfer runbook) |
| `in_review` | **no state change**; transfer stays `SUBMITTED`/`IN_FLIGHT`, ops alert if > 1h (Bridge-side AML hold — *open question: confirm semantics with Bridge*) |

Missed webhooks are backstopped by reconciliation (cron polls `GET /v0/transfers` for
non-terminal transfers — see reconciliation runbook).

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
checklist live in `runbooks/error-resolution.md`.

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
    alt state = FUNDED and now() < cancelable_until
        API->>DB: FUNDED → CANCELED (commits only if still FUNDED — TOCTOU guard)
        API-->>S: 200 canceled
        W->>DB: CANCELED ledger post (ACH in flight vs not — two variants)
        W->>ST: refund / release payment
        W->>DB: CANCELED → REFUNDED (+ refund paid post)
        W-->>S: push: refunded (full amount incl. fee, within 3 business days)
    else already SUBMITTED or window closed
        API-->>S: 409 transfer_not_cancelable → offer dispute path (§3)
    end
```

The same row lock protects the other side: the worker's `FUNDED → SUBMITTED` submission commits only
if the row is still `FUNDED` — cancel and payout can never both win.

`PAYOUT_FAILED → REFUNDED` (Bridge can't deliver) follows the same refund tail: Bridge returns
principal → recognize `refunds_payable` (full amount incl. fee) → pay refund → notify sender.
