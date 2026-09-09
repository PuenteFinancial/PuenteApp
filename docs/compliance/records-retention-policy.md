# Records retention — policy draft for counsel

**Date:** 2026-09-09 · **Status:** ⚠️ NEEDS LEGAL REVIEW — draft; nothing here is adopted until counsel
signs off · **Prepared for:** outside counsel (BSA/AML recordkeeping, EFTA/Reg E, state money
transmission) · **Trigger:** compliance review of PR #292 (`ops_actions`, 2026-09-08) asked for a
written retention period before the pilot widens beyond the founder.

Every legal statement below is a **proposal to confirm**, not advice. The system facts in §2 are
verified against the schema (`docs/erd.md`, `supabase/migrations/`).

---

## 1. What we are asking for

1. **Confirm the retention floor.** Proposed: **five years from record creation** for every
   transaction, ledger, state-change, consent, identity-verdict, and operator-intervention record
   (§2, classes A and B). Nothing shorter is proposed for any of them.
2. **Confirm the overlay from Bridge's licenses.** Bridge holds the money-transmitter licenses and
   executes payouts; Puente originates the order and keeps the customer relationship. Does any
   state statute impose a retention duty on Puente independently of Bridge's, and is any longer
   than five years?
3. **Confirm the prune windows** for the two rate-limit tables and the idempotency cache (§2,
   class C). They hold no transaction content; they exist to stop abuse and replays.
4. **Confirm the erasure posture** (§3.4): a customer deletion request must not delete financial
   records; identity fields are minimized or pseudonymized instead. Is a written procedure
   required before the first such request, or can it wait for the first request?

## 2. What the system does today (facts)

There is **no automated deletion** of any transaction or operator record, no retention job, and no
"delete transfer" path in any surface. The database refuses the deletions that would matter:

| Class | Tables | Mutability | Deletion today |
|---|---|---|---|
| **A · financial record** | `ledger_transactions`, `ledger_entries`, `transfer_transitions`, `disclosures`, `reconciliation_runs` | append-only (`forbid_mutation` / `ledger_forbid_mutation` triggers: UPDATE and DELETE raise) | impossible without a migration |
| **A · financial record (row mutable, never deleted)** | `transfers`, `quotes`, `payment_events`, `cancellation_requests`, `deposit_instructions` | lifecycle columns update in place; economic terms are frozen by trigger | `transfers` is referenced RESTRICT by the ledger, transitions, `ops_actions`, `kyc`-adjacent rows — a delete fails |
| **B · consent / identity / operator record** | `consents`, `kyc_verifications`, `ops_actions` | append-only (`forbid_mutation`) | impossible without a migration |
| **B · people** | `users`, `recipients`, `payout_destinations` | mutable | `users` is referenced RESTRICT by `transfers` ("a user with financial history is undeletable", migration 20260717164026); `recipients` cascade to `payout_destinations` only |
| **C · abuse controls** | `otp_send_attempts`, `otp_verify_attempts` | append-only rows | **pruned** by a scheduled job (~24 h); peppered phone hashes only, never a phone number |
| **C · replay cache** | `idempotency_keys` | write-once | **purged** after `expires_at` (~24 h); response snapshots only |
| **D · logs** | Railway request logs (audit plugin lines: route, actor id, request id — no PII), Sentry events | platform-managed | retention is the platform's default (Railway: days; Sentry: 90 days on the current plan) — **not** a record of anything that is not also in class A or B |

Two properties matter for retention that are easy to miss:

- **Retention does not mean PII exposure.** Class A and `ops_actions` carry ids, amounts,
  timestamps, states and opaque provider references. Names, phone, tax id, DOB and bank
  coordinates live only in class B "people" rows and in Bridge/Stripe. The operator's free-text
  `ops_actions.note` is bounded (10–500 chars) and the UI instructs "no names, no account numbers";
  that is guidance, not enforcement (compliance review 2026-09-08, accepted for an admin-only
  table).
- **Backups.** Supabase Pro daily backups; PITR is a separate toggle to enable before real volume
  (`docs/pre-implementation-todo.md`). A backup is not a retention mechanism — it is a recovery one.

## 3. Proposed policy (draft — for counsel to edit)

3.1 **Retention floor.** Class A and B records are kept for **no less than five (5) years from
creation**, and for the life of any open dispute, error-resolution, subpoena, or examination
beyond that. Class C records are kept for the prune window only. Class D is not a record of
reliance.

3.2 **No automated deletion.** No job deletes class A or B rows. Any future deletion is a database
migration, reviewed, with the commit tagged (`retention/<table>-<date>`), a written counsel sign-off
in `docs/compliance/`, and a note in `docs/decisions.md` — the same discipline as retiring code
(`docs/prds/checkout-sessions-rail.md` §4).

3.3 **Append-only stays append-only.** The `forbid_mutation` triggers are the control. A bare
`UPDATE` that bypasses a trigger is a known audit item (`transfers.state`, 2026-09-02 audit) and
stays deferred by decision; it does not affect deletion.

3.4 **Customer erasure requests.** A deletion request from a customer with financial history is
honored by **minimizing** the class B "people" row (name, phone, address, tax-id references) after
the retention floor, never by deleting class A rows. Before the floor, identity fields stay as
they are; the customer is told why in plain language (Reg E and BSA recordkeeping). Procedure to be
written on the first request unless counsel says it must exist first.

3.5 **Operator interventions.** Every ops action (`ops_actions`) is retained with the transfer it
touched; a transfer cannot be deleted while an action references it (RESTRICT). The CLI paths that
predate the table are recorded through `transfer_transitions.actor` (`ops:<id>`), retained the
same way.

3.6 **Review.** This policy is re-read at each rail change (a new funding processor, a new payout
partner) and at least annually.

## 4. Regulatory anchors (to confirm)

| Anchor | What it seems to require | Proposal's answer |
|---|---|---|
| BSA — 31 CFR 1010.410(e)/(f) (funds transfer recordkeeping, ≥ $3,000) | originator/beneficiary/amount/date records, **5 years** | 5-year floor (class A); we keep them regardless of amount |
| BSA — 31 CFR 1022.410 (MSB records) | **5 years** | applies to Bridge as licensee; we mirror it (question 2) |
| Reg E — 12 CFR 1005.13(b) | evidence of compliance, **2 years** | subsumed by the 5-year floor |
| Reg E subpart B — §1005.31–33 (remittance disclosures, error resolution) | disclosures as provided; error-resolution records | `disclosures` is append-only and versioned; `cancellation_requests` + `transfer_transitions` carry resolution |
| State money transmission (Bridge's licenses) | typically 3–5 years; varies | question 2 |
| E-SIGN / consent | consent records for the life of the relationship + | `consents` append-only, versioned (K1) |

## 5. Open questions for counsel

1. Is five years the right floor, and does any state overlay lengthen it for us specifically?
2. Does Puente carry an independent state-law recordkeeping duty given Bridge holds the licenses?
3. Are ~24-hour prune windows for OTP attempt tables and the idempotency cache acceptable?
4. Must the erasure procedure (§3.4) exist in writing before the first request?
5. Should the operator note be **enforced** PII-free (pattern rejection for phone/SSN/CLABE
   formats) rather than guided? Cost is small; the review left it advisory.

## 6. How to answer an examiner (queries)

One transfer's whole record, oldest first:

```sql
select 'transition' as kind, created_at, actor, from_state || ' → ' || to_state as what
  from public.transfer_transitions where transfer_id = '<id>'
union all
select 'ledger', posted_at, transition, idempotency_key
  from public.ledger_transactions where transfer_id = '<id>'
union all
select 'ops_action', created_at, actor, action || ' (' || coalesce(reason, '') || ')'
  from public.ops_actions where transfer_id = '<id>'
order by 2;
```

Every operator intervention in a period:

```sql
select created_at, actor, action, transfer_id, reason
  from public.ops_actions
 where created_at >= '<from>' and created_at < '<to>'
 order by created_at;
```

Related: [`reg-e-disclosure-counsel-package.md`](reg-e-disclosure-counsel-package.md) (the
Reg E copy review), [`../erd.md`](../erd.md) (schema and append-only inventory),
[`../runbooks/manual-refund.md`](../runbooks/manual-refund.md) (where `ops_actions` is read back).
