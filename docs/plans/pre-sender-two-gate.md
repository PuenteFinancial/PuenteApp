# Before a second person sends money

**Status:** draft for review, 2026-09-15, verified against `origin/main` @ `ae08eff`.

`kyc-at-first-send.md` § "What K7b still owes" is the **human half** of this gate and says so
itself — *"Human-shaped, and none of it is code."* It was right, and it is still the harder half.
This is the other half: what the machine owes, plus the two consumer obligations that turned out to
be blockers rather than paperwork.

Ordered by what actually blocks sender #2. Nothing below is a feature.

---

## Tier 1 — Legally blocking

A second sender is *owed* these. None is code we have not written; each is a thing that does not
exist yet.

| # | What | Evidence |
|---|---|---|
| 1 | **Provision and monitor `support@puentefinancial.com`** | `packages/shared/src/support.ts:12-17` — a dated PRE-LAUNCH BLOCKER: *"an unrouted inbox means a sender following our instructions to exercise a statutory right reaches nobody. Fine for the mock-only pilot; not fine for real users."* It is the address printed on the Reg E disclosure and on the tracker's cancellation and error surfaces. |
| 2 | **Adopt an error-resolution process (§1005.33)** | `docs/runbooks/proposals/error-resolution.md:3` — *"⚠️ PROPOSAL — not adopted."* Issue #217. Our own disclosure promises senders 180 days to report an error. There is no intake, no investigation path, and no clock. |
| 3 | **Complete the receipt** | `apps/api/src/services/disclosures.ts:17-20` — provider telephone (§1005.31(b)(2)(v)) and the state-regulator/CFPB block ((b)(2)(vi)) are *"STILL MISSING, gated on counsel/provisioning inputs."* Every receipt we issue today is incomplete. |
| 4 | **Human review of the Spanish** | Three `NEEDS LEGAL REVIEW` markers in `disclosures.ts`; the counsel package records all current Spanish as machine-drafted. Our core demographic reads that copy, not the English. |

## Tier 2 — Operationally blocking

Not illegal. But if sender #2's money goes wrong, this is why you would not find out.

| # | What | Evidence |
|---|---|---|
| 5 | **Promote to production** | `production` is at `a07cb41` (2026-09-11), **24 commits behind main**. Every money-path fix from this week is merged and not live: #332, #333, #337, #339, #343. Promote is not broken — it ran clean 4× on 9/10–9/11 and has simply not been triggered since. |
| 6 | **Get the alert channel to zero, and give recon an acknowledgement path** | All 6 unresolved Sentry issues are false or stale. `stripe_disputes` is the structural one: its predicate is `funding_disputed_at != null` (`reconciliation.ts:990`), which only OUR webhook sets — resolving or refunding at Stripe never does, so a finding re-fires every 6h for the full 60-day `DISPUTE_WINDOW_MS`. An alarm that is 100% noise is not an alarm. |

## Tier 3 — Money-path holes an ordinary sender can hit

Both **strand** money rather than lose it. Both are reachable on a plain $50 send.

| # | What | Evidence |
|---|---|---|
| 7 | **`FUNDED` with no hold reason has no operator exit after 30 minutes** | Four arms of the submit job return without setting a hold — `WAIT_FOR_CLEARING` (`payout-submit.ts:138`), `FIRST_TRANSFER_HOLD` (`:146`), the float ceiling (`:248`), the uncleared cap (`:271`). Both operator tools require a hold (`payout-holds.ts:89`, `ops-cancel.ts:333` → `not_held`) and the sender's own cancel expires at 30 min. The float ceiling reads the **global** receivable, so today's stuck prod row plus one new send can trip it. |
| 8 | **`submit_error` rows are listed by the cancel tool but can never be acted on** | `submit_error` is in `CANCELABLE_HOLD_REASONS` (`ops-cancel.ts:90`), but every row carrying it has `submit_attempted_at` set — `claimForSubmission` stamps it before the Bridge POST and all four `placeHold('submit_error')` sites are downstream. Both guards refuse exactly that shape. A dead end whenever the cause is permanent. |

## Tier 4 — No recovery if the unusual thing happens

Each needs a chargeback, a payout failure, or a KYC regression. None is currently recoverable.

| # | What | Evidence |
|---|---|---|
| 9 | **A chargeback while the payout is in flight is never booked — and the backstop does not exist** | `applyFundingReversed` books the loss in the `COMPLETED` arm only (`funding-apply.ts:431-460`); `SUBMITTED`/`IN_FLIGHT` returns and posts nothing (`:468`). `payment-event-process.ts` never reads `funding_disputed_at`, so when delivery resolves the ordinary batch posts and no loss ever does. **`markFundingDisputed` runs at `:421`, before the branch**, so the row satisfies the recon check's predicate and `stripe_disputes` passes forever. It tests "did our webhook run", not "was the loss handled". The row is also invisible to the freeze CLI (`sender-freeze.ts:212`). |
| 10 | **A dispute on an already-`REFUNDED` transfer is a real double payment with zero recognition** | Falls to `no_exposure` (`funding-apply.ts:472`), whose comment asserts "already refunded" — wrong for a `refunded`-mode undo, where we paid real cash out and the network then claws the original charge back too. `REFUNDED` is excluded from `AGING_OR_FILTER`, so nothing ages it either. |
| 11 | **A partial dispute books a full loss** | No code reads a dispute amount anywhere; both loss builders book `send + fee`. A $1 partial dispute on a $500 transfer books $500. The page that is supposed to bring a human carries no amount and fires after the posting commits. |
| 12 | **`sender_kyc_pending` has no exit when Bridge rejects** | The hold is placed for any status other than `approved`, is in neither releasable nor cancelable sets, and `releaseSenderKycHolds` is only wired to the approval arm. |
| 13 | **`FUNDING_REVERSED` has no recovery when you WIN a dispute** | `ledger-rules.md` promises a correcting credit "on its own transition". No such code exists, and `funding_disputed_at` is set-once and never cleared, so the interlock refuses that transfer for life. |

## Explicitly NOT blocking

- `refunds_payable` has no aging clock — but only ops-cancel opens it, and a second sender on the
  Checkout rail essentially cannot.
- `due_from_bridge` is covered three ways (24h aging, 5-min stuck-watch, 1h `in_review`).
- Two refund paths racing: one DB claim, one short-circuit, one processor idempotency key.
- The #343 rail double-pay: real, fixed on main, and it needs an operator to roll
  `FUNDING_PROCESSOR` back to `manual` — not something a sender triggers.

## The shortest honest path

Tier 1 is four things and three of them are emails, not commits. Tier 2 is one button and one
afternoon. Do those five and a second sender is legal and observable. Tier 3 is the next code work.
Tier 4 can be accepted deliberately for a small trusted cohort, as long as it is accepted rather
than forgotten — which is what this table is for.
