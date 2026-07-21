# Runbook — Payout Holds

**Date:** 2026-07-20 · **Status:** live process (slice 5)

A payout hold is a `FUNDED` transfer with `payout_hold_reason` set (`fx_drift`, `payability`, or
`submit_error`) and `payout_held_at`. The submit job sets the hold and stops; the 1-min
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

## `submit_error` — Bridge rejected the payout (non-retryable 4xx)

A 422 (idempotency mismatch: same `Idempotency-Key`, different body) or other non-400 4xx. 400s
(drained wallet, concurrent serialization) retry automatically and never set this hold.

1. Read the Sentry event and the Bridge dashboard for the attempted payout.
2. A **422 idempotency mismatch is an engineering incident**, not an ops release: it means the
   request body drifted between attempts (it is built only from immutable terms, so this should
   be impossible). Escalate; do not release until the cause is fixed — releasing will just
   re-send the same mismatched request.
3. Other 4xx: diagnose against Bridge API docs/support (e.g. below the $2.00 USD MXN destination
   minimum, endorsement missing). Fix the cause, then release.

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
4. If Bridge completes the payout during review → the right has extinguished at deposit; the
   state-keyed refund rule's `COMPLETED` branch (lawful denial) applies.
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
   exposure cap, not a tuning knob. The authoritative float controls (per-user limits, velocity,
   risk engine) are slice 8.
