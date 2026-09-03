# Runbook — Payout Holds

Held rows are listed with their reasons on the read-only ops page at `/dashboard/ops` (8.5-v1).

**Date:** 2026-07-20 · **Status:** live process (slice 5)

A payout hold is a `FUNDED` transfer with `payout_hold_reason` set (`fx_drift`, `payability`,
`submit_error`, `velocity_review`, or — since K6 — the auto-released `sender_kyc_pending`) and
`payout_held_at`. The submit job sets the hold and stops; the 1-min
`payout.sweep` cron skips held rows. Releasing a hold means clearing the column — the sweep
resubmits automatically within a minute. There is no admin endpoint at MVP; release is SQL via
the Supabase SQL editor (a sanctioned ops **data** fix — schema changes still go through
migrations only). Background: [transfer-state-machine.md](../transfer-state-machine.md),
[decisions.md](../decisions.md) 2026-07-20.

## Release procedure (all hold reasons)

1. Investigate per the reason-specific steps below. Do not release until the underlying cause is
   understood — release means "submit this payout to Bridge within a minute."
2. Run the release SQL in the **Supabase SQL editor** (staging or prod project as appropriate):

   ```sql
   update public.transfers
   set payout_hold_reason = null, payout_held_at = null
   where id = '<transfer-id>' and payout_hold_reason = '<reason>';
   ```

   The `payout_hold_reason = '<reason>'` guard makes the release a no-op if the hold has already
   changed or been cleared — expect exactly 1 row updated.
3. Verify: within ~1 minute the sweep enqueues the submit job; the transfer should move to
   `SUBMITTED` (check `transfer_transitions` for the `worker:payout` actor).
4. Provenance: no extra logging step needed — the Supabase query history records who ran the
   release, and the submit job's transition metadata records the resulting submission.

## `sender_kyc_pending` — sender's Bridge KYC not approved at payout time (AUTO-RELEASED, K6)

**Look at the customer in Bridge, not the transfer.** Under KYC-at-first-send the Bridge customer
is created by the relay (`POST /v1/users/me/bridge-customer`) and Bridge runs its own database
checks; the pay step waits for approval before collecting payment, so this hold is a backstop for
the gaps — an approval that regressed to review after the sender paid, a webhook that never
landed, or a sandbox customer left in `incomplete`. It is the only hold **the system releases on
its own**: the Bridge `customer.*` webhook with an `approved` / `active` status clears every
`sender_kyc_pending` hold for that sender and re-enqueues the submit (`services/payout-holds.ts`).

1. Find the sender: `select id, kyc_status, bridge_customer_id from users where id = (select user_id from transfers where id = '<transfer-id>')`.
2. Open that customer in the Bridge dashboard and read its status and the `spei` endorsement.
   - **Approved at Bridge but `users.kyc_status` is not `approved`** → the webhook was missed.
     Check `GET /v0/webhooks/{id}/logs` for the delivery; a redelivery (or any later
     `customer.updated`) releases the hold automatically. If none is coming, set
     `users.kyc_status = 'approved'` and run the standard release SQL — do not release without
     fixing the status, or `payout-submit` re-holds on its next pass.
   - **Under review / incomplete at Bridge** → nothing to do; wait. The reconciliation aging
     bound for this reason is the 8-day clearing window (deliberately NOT the 24h human-actioned
     bound — nobody owes an action while Bridge reviews); `funded-held-overdue` re-raises it.
   - **Rejected at Bridge** → the payout can never go out. Cancel/refund path
     (`manual-refund.md`); the sender's Persona fallback is offered by the pay step, not here.
3. **Never release while the customer is unverified.** Bridge 4xxs the payout and the row re-holds
   as `submit_error` — a worse place to be.

## `fx_drift` — FX submission backstop tripped

The live Bridge buy rate drifted more than `FX_MAX_DRIFT_BPS` (default 200) from the quote's
`source_rate`, or the quote is older than `FX_MAX_QUOTE_AGE_MINUTES` (default 240). This fires
only on genuine dislocation or a transfer stuck for hours.

1. Read the Sentry alert: it carries the drift value (bps) and transfer id (no PII).
2. Compare the quote's `source_rate` and `created_at` against the current Bridge buy rate.
   Remember the quote is our firm Reg E commitment — the customer amount cannot change.
3. Decide:
   - **Drift is tolerable** (we absorb it as `fx_slippage`, the normal mechanism) → release.
   - **Genuine market dislocation** → escalate to Joshua before releasing; the loss lands on us.
   - **Quote merely stale** (transfer stuck for hours, rate fine) → find out *why* it was stuck
     first, then release.

## `payability` — destination or recipient not payable

The pre-submission joined check failed: `payout_destinations.status != 'active'`, or
`recipients.status != 'active'`, or `provider_account_ref IS NULL`.

1. Inspect the transfer's destination and recipient rows (status columns,
   `provider_account_ref`).
2. Fix the underlying record — e.g. the recipient/destination needs to be re-activated, or the
   Bridge external account was never created (check `services/bridge.ts` `createExternalAccount`
   path and the Bridge dashboard).
3. Only release once the joined condition would pass; otherwise the submit job will re-hold
   immediately.

## `submit_error` — payout submission held for engineering

Three distinct failures set `submit_error`. The Sentry `payout_hold` context tells them apart —
`statusCode` for (a), a `cause` string for (b) and (c). None is a routine ops release; understand
(and usually fix) the underlying cause before clearing the hold.

### (a) Bridge rejected the payout — non-400 4xx (`statusCode`)

A 422 (idempotency mismatch: same `Idempotency-Key`, different body) or other non-400 4xx. 400s
(drained wallet, concurrent serialization) retry automatically and never set this hold.

1. Read the Sentry event and the Bridge dashboard for the attempted payout.
2. A **422 idempotency mismatch is an engineering incident**, not an ops release: it means the
   request body drifted between attempts (it is built only from immutable terms, so this should
   be impossible). Escalate; do not release until the cause is fixed — releasing will just
   re-send the same mismatched request.
3. Other 4xx: diagnose against Bridge API docs/support (e.g. below the $2.00 USD MXN destination
   minimum, endorsement missing). Fix the cause, then release.

### (b) Recovery re-POST found no destination ref (`cause: recovery_missing_account_ref`)

A crash-recovery run (the transfer was already claimed — `submit_attempted_at` set — then the
worker died before the SUBMITTED transition) re-read the destination to rebuild the byte-identical
Bridge body, and `payout_destinations.provider_account_ref` was gone. Payability was checked
pre-claim, so the ref disappeared *after* the first attempt.

1. Inspect the destination row: why is `provider_account_ref` NULL now when it was set at claim?
   (destination archived/re-created, Bridge external account deleted, a data fix gone wrong).
2. Restore the correct `provider_account_ref` — re-create the Bridge external account if needed
   (`services/bridge.ts` `createExternalAccount`).
3. Release only once the ref is present; the recovery re-POST reuses the original
   `Idempotency-Key`, so Bridge returns the existing transfer if one was already created.

### (c) Bridge `source.amount` failed strict 2-dp parse (`cause: source_amount_parse`)

**Engineering incident, not an ops release — money moved with no matching ledger posting.** The
Bridge payout **was created** (a `bridgeTransferId` exists), but its `source.amount` did not parse
as an exact 2-dp decimal, so the job refused to guess a ledger amount and held instead of
transitioning to `SUBMITTED`. A second, `error`-level Sentry event (fingerprint
`bridge-source-amount-precision`, `bridge_amount` context with `bridgeTransferId` + the raw
`sourceAmount`) accompanies the hold. This means our model of Bridge is wrong.

1. Do **not** just release — the re-POST returns the same Bridge transfer and re-hits the same
   parse failure.
2. Escalate to engineering with the `bridge_amount` context. Reconcile the actual USDC draw against
   the SUBMITTED ledger expectation, fix `parseDecimalToMinor` / the Bridge model
   (`services/payouts.ts`), and complete the transition deliberately.

## `velocity_review` — per-user velocity backstop tripped

The `FUNDED → SUBMITTED` backstop found the sender over one of their per-user transaction limits (the
AML launch limits: per-transaction, or a rolling day / month / 6-month send total, or the per-day
count) — a rare same-instant commit race that slipped the confirm-time gate. The Sentry `payout_hold`
context carries `velocityReason` (`per_transaction` / `daily` / `monthly` / `semiannual` /
`velocity_count`) and the transfer id (no PII). This is **not** self-healing: a per-user tally doesn't
drain on its own (a completed send keeps counting for its window), so the transfer would strand until
the window rolls — hence the hold.

1. Look at the sender's other in-window committed sends (`transfers` where `user_id = …`,
   `disclosure_accepted_at` within the window, state not in the unwound set). Confirm whether the
   burst is legitimate (the sender really meant to send this much) or looks like an error or abuse.
2. Decide:
   - **Legitimate** (trusted sender, honest burst) → release; the payout submits within a minute. If
     they will routinely exceed the pilot caps, raise the `RISK_*` env values **with Joshua's
     sign-off** rather than releasing repeatedly.
   - **Error or suspicious** → do not release; cancel the transfer and refund the sender (the Reg E
     cancel/refund path), then follow up.
3. Release SQL is the standard procedure above with `payout_hold_reason = 'velocity_review'`.

## Cancel request during Bridge `in_review`

Not a hold, but it lands here (decision 2026-07-20): Bridge compliance review can leave funds
**undeposited for over an hour**, and under §1005.34 a timely cancel while funds are undeposited
**legally requires a full refund** — the right survives until pickup/deposit.

1. The poller alerts if a transfer sits in `in_review` >1h; a cancel request during that window
   is this case.
2. **Contact Bridge BEFORE refunding**: confirm the payout's actual state and whether Bridge will
   cancel/return the funds. Do not double-move money on an assumption.
3. If Bridge confirms the funds were not (and will not be) deposited → issue the full refund
   within the 3-business-day window.
4. If Bridge completes the payout during review → **the refund is still owed.** Corrected
   2026-07-28 (slice 7 PR6b); this step previously read "the right has extinguished at deposit …
   lawful denial applies," which is wrong for this case. The right extinguishes at deposit for a
   request made AFTER deposit — but a request recorded here was necessarily made while the transfer
   was pre-`COMPLETED`, i.e. while the funds were undeposited, so both §1005.34 conditions were met
   at the moment the sender asked and the obligation attached then. Bridge completing the payout
   afterwards is us failing to stop it, not the right expiring. The system now enforces this: the
   transfer routes `COMPLETED → UNDER_REVIEW` and ops pays a correction payment. Lawful denial
   applies only when `within_window = false`. See
   [pending-cancellation.md](pending-cancellation.md) and
   [transfer-state-machine.md](../transfer-state-machine.md).
5. Record the outcome in the transfer's transition metadata / audit trail.

## Float-ceiling Sentry alert

Not a hold — there is nothing to release. A trip means the submit job found the aggregate
`funding_receivable` balance at or above `FLOAT_CEILING_MINOR`; the transfer stays `FUNDED` with
no hold and the sweep retries every minute as the balance drains (self-healing backpressure). The
alert is fingerprinted, so it fires once per episode, not per retry.

1. Verify the `funding_receivable` balance is actually draining (ACH clearing normally) — if it
   is, do nothing; the queue clears itself.
2. If the balance is flat or growing: check treasury wallet replenishment and whether funding
   webhooks/clearing are stalled.
3. Raise `FLOAT_CEILING_MINOR` **only with Joshua's sign-off** — it is the aggregate fronting
   exposure cap, not a tuning knob. (Per-user velocity landed in slice 7 PR5 — see `velocity_review`
   above; the per-user dollar-outstanding cap and the broader risk engine remain slice 8.)

## FUNDED with no hold reason — the three deliberate self-heal waits

A `FUNDED` row that isn't advancing and has `payout_hold_reason IS NULL` is (float ceiling aside)
in one of three **intentional** waits, all resumed automatically by the 1-minute sweep — release
nothing:

| Wait | How to recognize it | Frees when |
|---|---|---|
| `WAIT_FOR_CLEARING=true` | Flag on; row has `funding_cleared=false` | Its own `funding_cleared` lands |
| `FIRST_TRANSFER_HOLD=true` | Flag on; row uncleared **and** the user has no send with `funding_cleared=true` outside `FUNDING_REVERSED` | Its own `funding_cleared` lands |
| Uncleared cap (slice-8 O3) | Sentry `uncleared cap reached` with fingerprint `['uncleared-cap-wait', <transferId>]` (one issue **per waiting transfer**, context names the `blockerTransferId`); the user has an older committed-uncleared send | The **blocker** clears or unwinds |

The cap wait normally resolves within the ACH window (~T+4). If it persists past that, the blocker
itself is stuck — a bounced pull (post-FUNDED `funding_failed` is stale-logged; `funding_reversed`
is recorded-and-deferred) leaves the sender capped **until ops resolves the blocker row**; that is
intended (their exposure is genuinely live), so investigate the blocker, not the waiter.

Dev/staging: clearing is script-only — free a slot with
`pnpm tsx scripts/fire-funding-webhook.ts <blockerTransferId> cleared`.
