import type { FastifyPluginAsync } from 'fastify'
import { env } from '../../config/env.js'
import { buildOpsOverview } from '../../services/ops-overview.js'
import { refundCancellation, denyCancellation } from '../../services/cancellation-review.js'
import { recordManualFunding } from '../../services/funding-apply.js'
import { recordFloatTopUp, PayoutValidationError } from '../../services/payouts.js'
import { getAccountBalance } from '../../services/ledger.js'
import {
  attachDepositInstructions,
  getDepositInstructions,
} from '../../services/deposit-instructions.js'
import { errorResponseSchema, sendError } from '../../utils/errors.js'

// The money-ops surface (slices 8.5-v1 + v1.1, docs/api-contract.md).
//
// Read (GET /ops/overview): registered in server.ts ONLY when
// OPS_ADMIN_USER_IDS is non-empty, and the handler independently re-checks
// membership as its FIRST statement — the dev-route double-control posture.
// Non-members get a 404 whose body is byte-identical to the router's own
// not-found response ('Route not found'): this surface must not confirm it
// exists.
//
// Write (POST /ops/cancellations/resolve, slice 8.5-v1.1): the v1.1 admin-auth
// decision is a DOUBLE-CONTROL env gate — identity (OPS_ADMIN_USER_IDS) ×
// capability (OPS_WRITE_ENABLED), set independently in Doppler. The POST is
// registered only when opsWriteEnabled() (both controls positively set), the
// handler re-checks both plus membership first, and it wraps the SAME services
// the resolve-cancellation CLI calls (decisions.md 2026-07-27: the dashboard is
// additive; the CLI stays break-glass). Deliberately NOT built: SMS step-up,
// app_metadata role claims, RBAC — see the decisions.md 8.5-v1.1 entry.
//
// The response schemas are the OUTPUT ALLOWLIST: every field is enumerated and
// nothing sets additionalProperties true — a future reconciliation check (or a
// widened service read) cannot leak new fields onto this wire without a
// deliberate schema change here.

// Both controls positively set, or the write surface does not exist. Exported
// for tests and any future ops write route; mirrors devEndpointsEnabled().
export function opsWriteEnabled(): boolean {
  return env.OPS_WRITE_ENABLED && env.OPS_ADMIN_USER_IDS.size > 0
}

const moneyPanelSchema = {
  type: 'object',
  properties: {
    configured: { type: 'boolean' },
    tripped: { type: ['boolean', 'null'] },
    balanceMinor: { type: 'number' },
    ceilingMinor: { type: ['number', 'null'] },
  },
} as const

const overviewResponseSchema = {
  type: 'object',
  properties: {
    generatedAt: { type: 'string' },
    // v1.1: whether the write capability is live on THIS deployment — the web
    // renders action buttons only when true, so capability is declared on the
    // wire instead of discovered by probing the POST.
    actionsEnabled: { type: 'boolean' },
    pendingCancellations: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          transferId: { type: 'string' },
          state: { type: 'string' },
          sendAmountMinor: { type: 'number' },
          feeAmountMinor: { type: 'number' },
          requestedAt: { type: 'string' },
          withinWindow: { type: 'boolean' },
          refundPaymentRef: { type: ['string', 'null'] },
        },
      },
    },
    openTransfers: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          transferId: { type: 'string' },
          state: { type: 'string' },
          sendAmountMinor: { type: 'number' },
          feeAmountMinor: { type: 'number' },
          enteredStateAt: { type: 'string' },
          dwellMinutes: { type: 'number' },
          thresholdMinutes: { type: 'number' },
          overThreshold: { type: 'boolean' },
          holdReason: { type: ['string', 'null'] },
          fundingCleared: { type: 'boolean' },
          submitAttempted: { type: 'boolean' },
          cancellationRequested: { type: 'boolean' },
          fundingInitiated: { type: 'boolean' },
          fundingProcessor: { type: 'string' },
          onrampRef: { type: ['string', 'null'] },
          paymentClaimedAt: { type: ['string', 'null'] },
        },
      },
    },
    floatCeiling: moneyPanelSchema,
    transferCounts: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          state: { type: 'string' },
          count: { type: 'number' },
        },
      },
    },
    ledgerBalances: {
      type: ['object', 'null'],
      properties: {
        asOf: { type: 'string' },
        balances: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              code: { type: 'string' },
              amountMinor: { type: 'number' },
              currency: { type: 'string' },
            },
          },
        },
      },
    },
    reconciliationRuns: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          createdAt: { type: 'string' },
          status: { type: 'string' },
          findingsCount: { type: 'number' },
          checks: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                name: { type: 'string' },
                status: { type: 'string' },
                findingsCount: { type: 'number' },
                error: { type: 'string' },
              },
            },
          },
        },
      },
    },
    workerHeartbeats: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          worker: { type: 'string' },
          beatAt: { type: 'string' },
          ageSeconds: { type: 'number' },
          stale: { type: 'boolean' },
        },
      },
    },
  },
} as const

// transferId lives in the BODY, not the path: the idempotency plugin keys on
// the route pattern + a body hash, so a path-param id would hash identically
// across transfers (the known collision — see transfers.ts cancel). With the
// id and decision in the body, one reused key on a different transfer or a
// flipped decision is a loud 409 idempotency_conflict, never a silent replay.
// depositedAt's `format: 'date-time'` makes denyCancellation's
// throw-on-unparseable path unreachable from HTTP (garbage is a 400 here).
const resolveBodySchema = {
  type: 'object',
  required: ['transferId', 'decision'],
  additionalProperties: false,
  properties: {
    transferId: { type: 'string', format: 'uuid' },
    decision: { type: 'string', enum: ['refund', 'deny'] },
    depositedAt: { type: 'string', format: 'date-time' },
  },
} as const

const resolveResponseSchema = {
  type: 'object',
  properties: {
    transferId: { type: 'string' },
    outcome: {
      type: 'string',
      enum: ['refunded', 'denied', 'already_disbursed', 'already_refunded'],
    },
  },
} as const

// Same body-not-path reasoning as resolveBodySchema above. `amountMinor` is
// required and checked against the transfer to the cent: the operator is
// asserting a specific deposit, so making them state the amount turns a
// wrong-transfer slip into a 409 instead of a payout.
const manualFundingBodySchema = {
  type: 'object',
  required: ['transferId', 'kind', 'externalRef', 'amountMinor', 'currency'],
  additionalProperties: false,
  properties: {
    transferId: { type: 'string', format: 'uuid' },
    // 'funded' releases the payout against Puente's float; 'cleared' settles
    // the receivable when the sender's money actually lands, days later.
    kind: { type: 'string', enum: ['funded', 'cleared'] },
    // The provider-side id of the real deposit (e.g. the Bridge transfer id) —
    // the audit tie from this assertion back to money that moved.
    externalRef: { type: 'string', minLength: 1, maxLength: 200 },
    amountMinor: { type: 'integer', minimum: 1 },
    currency: { type: 'string', enum: ['USD'] },
  },
} as const

const manualFundingResponseSchema = {
  type: 'object',
  properties: {
    transferId: { type: 'string' },
    outcome: { type: 'string', enum: ['funded', 'cleared', 'cleared_skipped'] },
  },
} as const

// Same body-not-path reasoning as the schemas above, same to-the-cent amount
// assertion as manualFundingBodySchema — deposit-landed is the cleared
// assertion plus the float top-up in one action, so it takes the same inputs.
const depositLandedBodySchema = {
  type: 'object',
  required: ['transferId', 'externalRef', 'amountMinor', 'currency'],
  additionalProperties: false,
  properties: {
    transferId: { type: 'string', format: 'uuid' },
    externalRef: { type: 'string', minLength: 1, maxLength: 200 },
    amountMinor: { type: 'integer', minimum: 1 },
    currency: { type: 'string', enum: ['USD'] },
  },
} as const

const depositLandedResponseSchema = {
  type: 'object',
  properties: {
    transferId: { type: 'string' },
    // cleared_skipped still 200s — the receivable was already settled and the
    // top-up (idempotent on the ref) was still posted; a re-tap is a success.
    outcome: { type: 'string', enum: ['cleared', 'cleared_skipped'] },
  },
} as const

// Ad-hoc treasury top-up (funding-ops-automation slice 2). No transferId at
// all — this books out-of-band wallet funding (prefunds), not a transfer's
// deposit. externalRef optional: with one, the ledger dedupes globally on
// float_topup:<ref>; without one the handler derives adhoc:<Idempotency-Key>,
// so the HTTP layer and the ledger layer agree on what "the same booking" is.
const floatTopUpBodySchema = {
  type: 'object',
  required: ['amountMinor', 'currency'],
  additionalProperties: false,
  properties: {
    amountMinor: { type: 'integer', minimum: 1 },
    currency: { type: 'string', enum: ['USD'] },
    externalRef: { type: 'string', maxLength: 200 },
  },
} as const

const floatTopUpResponseSchema = {
  type: 'object',
  properties: {
    amountMinor: { type: 'number' },
    // Echoed so the operator's record shows the ref that actually keyed the
    // ledger post — including a derived adhoc:<key> one.
    externalRef: { type: 'string' },
    // The balance AFTER the post (an idempotency replay serves the balance as
    // of the original execution — informational, not a live read).
    floatBalanceMinor: { type: 'number' },
  },
} as const

export const opsRoute: FastifyPluginAsync = async (server) => {
  server.get(
    '/ops/overview',
    {
      schema: {
        response: {
          200: overviewResponseSchema,
          404: errorResponseSchema,
          500: errorResponseSchema,
        },
      },
    },
    async (request, reply) => {
      // Allowlist check FIRST — before any read. 404 with the router's own
      // not-found body, never 403: a non-admin must not learn this exists.
      if (!env.OPS_ADMIN_USER_IDS.has(request.user!.id)) {
        return sendError(reply, 404, 'not_found', 'Route not found')
      }

      try {
        return { ...(await buildOpsOverview()), actionsEnabled: opsWriteEnabled() }
      } catch (err) {
        // Fail closed and loud: a broken panel read must never render as an
        // empty queue. Message only (no error objects — provider bodies can
        // carry PII).
        request.log.error(
          { route: 'ops/overview' },
          `ops overview failed: ${err instanceof Error ? err.message : String(err)}`,
        )
        return sendError(reply, 500, 'internal_error', 'Something went wrong')
      }
    },
  )

  // The write surface does not exist unless both controls are set at boot.
  if (!opsWriteEnabled()) return

  server.post<{
    Body: { transferId: string; decision: 'refund' | 'deny'; depositedAt?: string }
  }>(
    '/ops/cancellations/resolve',
    {
      config: { idempotency: true },
      // Gate as a route-level onRequest hook — BEFORE schema validation and
      // the idempotency preHandler. Otherwise a non-admin probing without an
      // Idempotency-Key (or with a garbage body) would get their 400 and learn
      // the route exists; the 404 posture must win every race. Runs after the
      // global auth hook, so request.user is set. The handler re-checks too.
      onRequest: async (request, reply) => {
        if (!opsWriteEnabled() || !env.OPS_ADMIN_USER_IDS.has(request.user!.id)) {
          return sendError(reply, 404, 'not_found', 'Route not found')
        }
      },
      schema: {
        body: resolveBodySchema,
        response: {
          200: resolveResponseSchema,
          400: errorResponseSchema,
          404: errorResponseSchema,
          409: errorResponseSchema,
          500: errorResponseSchema,
        },
      },
    },
    async (request, reply) => {
      // Gate FIRST — both controls plus membership, before validation details
      // or any read. Same 404-never-403 body as the read route: env can drift
      // after registration, and the surface must not confirm it exists.
      if (!opsWriteEnabled() || !env.OPS_ADMIN_USER_IDS.has(request.user!.id)) {
        return sendError(reply, 404, 'not_found', 'Route not found')
      }

      const { transferId, decision, depositedAt } = request.body

      // Cross-field rule as explicit 400s (house style, transfers.ts): deny
      // REQUIRES the operator's deposit evidence; refund must never carry it —
      // evidence input is a decision input, never silently ignored.
      if (decision === 'deny' && depositedAt === undefined) {
        return sendError(reply, 400, 'validation_error', 'depositedAt is required to deny', [
          { path: 'depositedAt', issue: 'required when decision is deny' },
        ])
      }
      if (decision === 'refund' && depositedAt !== undefined) {
        return sendError(reply, 400, 'validation_error', 'depositedAt does not apply to a refund', [
          { path: 'depositedAt', issue: 'only allowed when decision is deny' },
        ])
      }

      try {
        // Actor attribution: the authenticated admin's user id — the services
        // record `ops:<id>` on the transition and the request resolution, which
        // is the durable decision record (the audit plugin only logs the hit).
        const outcome =
          decision === 'refund'
            ? await refundCancellation({ transferId, operator: request.user!.id })
            : await denyCancellation({ transferId, operator: request.user!.id, depositedAt: depositedAt! })

        if (outcome.done) {
          return { transferId, outcome: outcome.outcome }
        }

        // Refusals are NON-2xx by design: the idempotency plugin stores and
        // replays only 2xx — a 200-refusal would freeze a transient claim
        // state into every retry. Non-2xx releases the claim so a retry
        // re-executes against live state.
        switch (outcome.reason) {
          case 'transfer_not_found':
            return sendError(reply, 404, 'not_found', 'Transfer not found')
          case 'not_under_review':
            return sendError(
              reply,
              409,
              'conflict',
              `Transfer is not awaiting review (state ${outcome.state})`,
            )
          case 'no_pending_request':
            return sendError(reply, 409, 'conflict', 'No pending cancellation request for this transfer')
          case 'claim_taken':
            return sendError(
              reply,
              409,
              'conflict',
              'Another refund run holds the claim — refresh and retry shortly',
            )
          case 'claim_abandoned':
            // Its own code, never plain conflict: this is the danger state
            // (a prior run may have disbursed without recording) — the client
            // must render the manual-refund runbook path, not a retry.
            return sendError(
              reply,
              409,
              'claim_abandoned',
              'A prior refund run abandoned its claim — follow the manual-refund runbook',
            )
          case 'request_precedes_deposit':
            return sendError(
              reply,
              409,
              'refund_owed',
              'This request met both cancellation conditions — a refund is owed and it cannot be denied',
            )
          case 'deposit_evidence_conflict':
            return sendError(
              reply,
              409,
              'deposit_evidence_conflict',
              'The cited deposit time conflicts with recorded evidence',
              [
                {
                  path: 'depositedAt',
                  issue: `must lie between ${outcome.paymentAt ?? 'unknown'} and ${outcome.depositEvidenceAt ?? 'unknown'}`,
                },
              ],
            )
        }
      } catch (err) {
        // Same fail-closed-and-loud posture as the read route: message only,
        // no error objects (ledger/processor messages can carry provider data).
        request.log.error(
          { route: 'ops/cancellations/resolve' },
          `ops resolve failed: ${err instanceof Error ? err.message : String(err)}`,
        )
        return sendError(reply, 500, 'internal_error', 'Something went wrong')
      }
    },
  )

  // Operator-asserted out-of-band funding. With no payment gateway, this is the
  // ONLY path from PENDING_PAYMENT to FUNDED under FUNDING_PROCESSOR=manual —
  // the manual processor refuses every webhook signature, so there is no public
  // surface that can fund a transfer. Same double-control gate and 404 posture
  // as the resolve route above; the service refuses on any other processor.
  server.post<{
    Body: {
      transferId: string
      kind: 'funded' | 'cleared'
      externalRef: string
      amountMinor: number
      currency: 'USD'
    }
  }>(
    '/ops/transfers/funding',
    {
      config: { idempotency: true },
      onRequest: async (request, reply) => {
        if (!opsWriteEnabled() || !env.OPS_ADMIN_USER_IDS.has(request.user!.id)) {
          return sendError(reply, 404, 'not_found', 'Route not found')
        }
      },
      schema: {
        body: manualFundingBodySchema,
        response: {
          200: manualFundingResponseSchema,
          400: errorResponseSchema,
          404: errorResponseSchema,
          409: errorResponseSchema,
          500: errorResponseSchema,
        },
      },
    },
    async (request, reply) => {
      if (!opsWriteEnabled() || !env.OPS_ADMIN_USER_IDS.has(request.user!.id)) {
        return sendError(reply, 404, 'not_found', 'Route not found')
      }

      const { transferId, kind, externalRef, amountMinor } = request.body

      try {
        const result = await recordManualFunding({
          transferId,
          kind,
          externalRef,
          amountMinor,
          operator: request.user!.id,
        })

        if (result.done) {
          return { transferId, outcome: result.outcome }
        }

        // Refusals are NON-2xx by design, same as resolve: the idempotency
        // plugin stores and replays only 2xx, so a 200-refusal would freeze a
        // transient state into every retry.
        switch (result.reason) {
          case 'transfer_not_found':
            return sendError(reply, 404, 'not_found', 'Transfer not found')
          case 'processor_not_manual':
            // Not a 404: the operator is allowlisted and the route exists —
            // this deployment simply is not configured for out-of-band funding,
            // and silently 404ing would read as "wrong id" and invite retries.
            return sendError(
              reply,
              409,
              'conflict',
              `Out-of-band funding requires FUNDING_PROCESSOR=manual (currently ${result.provider})`,
            )
          case 'already_funded':
            return sendError(reply, 409, 'conflict', 'Transfer is already funded')
          case 'not_pending_payment':
            return sendError(
              reply,
              409,
              'conflict',
              `Transfer is not awaiting payment (state ${result.state})`,
            )
          case 'funding_not_initiated':
            return sendError(
              reply,
              409,
              'conflict',
              'Transfer has no funding reference — the sender has not confirmed it yet',
            )
          case 'amount_mismatch':
            return sendError(
              reply,
              409,
              'conflict',
              'Stated amount does not match this transfer',
              [{ path: 'amountMinor', issue: `expected ${result.expectedMinor}` }],
            )
          case 'stale':
            return sendError(
              reply,
              409,
              'conflict',
              'Transfer moved while being funded — refresh and retry',
            )
        }
      } catch (err) {
        request.log.error(
          { route: 'ops/transfers/funding' },
          `ops manual funding failed: ${err instanceof Error ? err.message : String(err)}`,
        )
        return sendError(reply, 500, 'internal_error', 'Something went wrong')
      }
    },
  )

  // POST /v1/ops/transfers/deposit-instructions (#199) — pull the deposit
  // coordinates from a hand-created Bridge onramp and attach them to the
  // transfer, so the pay step can render them instead of pointing at a text
  // message. Same double-control gate as the funding assertion; NOT idempotency
  // -keyed because the operation is naturally idempotent (upsert of a pure
  // read from Bridge — re-running refreshes, never duplicates).
  server.post<{ Body: { transferId: string; bridgeTransferId: string } }>(
    '/ops/transfers/deposit-instructions',
    {
      onRequest: async (request, reply) => {
        if (!opsWriteEnabled() || !env.OPS_ADMIN_USER_IDS.has(request.user!.id)) {
          return sendError(reply, 404, 'not_found', 'Route not found')
        }
      },
      schema: {
        body: {
          type: 'object',
          required: ['transferId', 'bridgeTransferId'],
          properties: {
            transferId: { type: 'string', format: 'uuid' },
            bridgeTransferId: { type: 'string', format: 'uuid' },
          },
          additionalProperties: false,
        },
        response: {
          200: {
            type: 'object',
            properties: {
              transferId: { type: 'string' },
              outcome: { type: 'string' },
              depositMessage: { type: 'string' },
            },
          },
          400: errorResponseSchema,
          404: errorResponseSchema,
          409: errorResponseSchema,
          500: errorResponseSchema,
        },
      },
    },
    async (request, reply) => {
      if (!opsWriteEnabled() || !env.OPS_ADMIN_USER_IDS.has(request.user!.id)) {
        return sendError(reply, 404, 'not_found', 'Route not found')
      }

      try {
        const result = await attachDepositInstructions({
          transferId: request.body.transferId,
          bridgeTransferId: request.body.bridgeTransferId,
          operator: request.user!.id,
        })
        switch (result.outcome) {
          case 'attached':
            return {
              transferId: request.body.transferId,
              outcome: 'attached',
              depositMessage: result.row.deposit_message,
            }
          case 'unknown_transfer':
            return sendError(reply, 404, 'not_found', 'Transfer not found')
          case 'not_pending_payment':
            return sendError(
              reply,
              409,
              'conflict',
              `Transfer is not awaiting payment (state ${result.state})`,
            )
          case 'amount_mismatch':
            return sendError(
              reply,
              409,
              'conflict',
              'Bridge onramp amount does not match this transfer',
              [{ path: 'bridgeTransferId', issue: `expected ${result.expectedMinor} minor units` }],
            )
          case 'instructions_unavailable':
            return sendError(
              reply,
              409,
              'conflict',
              'Bridge has no complete deposit instructions on that transfer',
            )
        }
      } catch (err) {
        request.log.error(
          { route: 'ops/transfers/deposit-instructions' },
          `ops attach instructions failed: ${err instanceof Error ? err.message : String(err)}`,
        )
        return sendError(reply, 500, 'internal_error', 'Something went wrong')
      }
    },
  )

  // POST /v1/ops/transfers/deposit-landed (funding-ops-automation slice 1) —
  // the "deposit landed" button: one action, both books. Runs the cleared
  // assertion (settles the funding receivable) and then the treasury float
  // top-up (the deposit physically landed in the wallet), the same pair the
  // runbook's §6 commands post.
  //
  // Deliberately NOT idempotency-keyed (deposit-instructions precedent): both
  // legs are naturally idempotent on the onramp ref — cleared replays as
  // cleared_skipped, and the top-up's ledger key is float_topup:<ref>. The
  // ordering invariant is cleared FIRST: a crash between the legs leaves a
  // state where a re-tap skips the receivable and still posts the top-up,
  // which is why the top-up must run on cleared_skipped too, never only on a
  // fresh cleared.
  server.post<{
    Body: { transferId: string; externalRef: string; amountMinor: number; currency: 'USD' }
  }>(
    '/ops/transfers/deposit-landed',
    {
      onRequest: async (request, reply) => {
        if (!opsWriteEnabled() || !env.OPS_ADMIN_USER_IDS.has(request.user!.id)) {
          return sendError(reply, 404, 'not_found', 'Route not found')
        }
      },
      schema: {
        body: depositLandedBodySchema,
        response: {
          200: depositLandedResponseSchema,
          400: errorResponseSchema,
          404: errorResponseSchema,
          409: errorResponseSchema,
          500: errorResponseSchema,
        },
      },
    },
    async (request, reply) => {
      if (!opsWriteEnabled() || !env.OPS_ADMIN_USER_IDS.has(request.user!.id)) {
        return sendError(reply, 404, 'not_found', 'Route not found')
      }

      const { transferId, amountMinor } = request.body
      // Trimmed once and used for BOTH legs, so the cleared assertion and the
      // ledger idempotency key can never disagree about the ref. An all-
      // whitespace ref would pass minLength yet blow up recordFloatTopUp AFTER
      // the receivable settled — refuse it before any money moves.
      const externalRef = request.body.externalRef.trim()
      if (externalRef.length === 0) {
        return sendError(reply, 400, 'validation_error', 'externalRef must not be blank', [
          { path: 'externalRef', issue: 'must contain a non-whitespace character' },
        ])
      }

      try {
        // Ref-typo guard (security review, slice 1): the float top-up's ledger
        // key is float_topup:<ref> GLOBALLY — another transfer's ref typed
        // here would settle THIS receivable while consuming THAT transfer's
        // top-up key, leaving the float ledger silently short until recon.
        // When instructions are attached the prefill is authoritative: the
        // stated ref must match. A transfer with nothing attached keeps the
        // CLI-parity behavior (operator-asserted ref, runbook §6).
        const instructions = await getDepositInstructions(transferId)
        if (instructions != null && instructions.bridge_transfer_ref !== externalRef) {
          return sendError(
            reply,
            409,
            'conflict',
            'Stated reference does not match the attached deposit instructions',
            [{ path: 'externalRef', issue: `expected ${instructions.bridge_transfer_ref}` }],
          )
        }

        const result = await recordManualFunding({
          transferId,
          kind: 'cleared',
          externalRef,
          amountMinor,
          operator: request.user!.id,
        })

        if (result.done) {
          // On cleared AND cleared_skipped: the skip means the receivable was
          // already settled (a prior tap, or this tap's crashed predecessor) —
          // the top-up is idempotent on the ref, so posting again is a no-op,
          // and skipping it here is what would strand a half-recorded deposit.
          await recordFloatTopUp({ amountMinor, externalRef })
          return { transferId, outcome: result.outcome }
        }

        // Same refusal taxonomy as the funding route (and the funded-only
        // reasons stay mapped so the switch is exhaustive over the type).
        switch (result.reason) {
          case 'transfer_not_found':
            return sendError(reply, 404, 'not_found', 'Transfer not found')
          case 'processor_not_manual':
            return sendError(
              reply,
              409,
              'conflict',
              `Out-of-band funding requires FUNDING_PROCESSOR=manual (currently ${result.provider})`,
            )
          case 'already_funded':
            return sendError(reply, 409, 'conflict', 'Transfer is already funded')
          case 'not_pending_payment':
            return sendError(
              reply,
              409,
              'conflict',
              `Transfer is not awaiting payment (state ${result.state})`,
            )
          case 'funding_not_initiated':
            return sendError(
              reply,
              409,
              'conflict',
              'Transfer has no funding reference — the sender has not confirmed it yet',
            )
          case 'amount_mismatch':
            return sendError(
              reply,
              409,
              'conflict',
              'Stated amount does not match this transfer',
              [{ path: 'amountMinor', issue: `expected ${result.expectedMinor}` }],
            )
          case 'stale':
            return sendError(
              reply,
              409,
              'conflict',
              'Transfer moved while being funded — refresh and retry',
            )
        }
      } catch (err) {
        request.log.error(
          { route: 'ops/transfers/deposit-landed' },
          `ops deposit-landed failed: ${err instanceof Error ? err.message : String(err)}`,
        )
        return sendError(reply, 500, 'internal_error', 'Something went wrong')
      }
    },
  )

  // POST /v1/ops/treasury/float-topup (funding-ops-automation slice 2) — the
  // "I sent 100 into the wallet" entry: books DR bridge_wallet_float /
  // CR cash_clearing via recordFloatTopUp, the same service the break-glass
  // CLI (record-float-topup.ts) calls. Run AFTER the deposit actually landed —
  // the ledger records what is true, and the UI copy restates it.
  //
  // Double-tap safety, both layers: the required Idempotency-Key replays a
  // stored 2xx, and the ledger no-ops on a repeated float_topup:<ref>. With a
  // blank ref the derived adhoc:<Idempotency-Key> keeps the two layers
  // aligned — a held key is the SAME booking at both layers, a fresh key is
  // legitimately a new one.
  server.post<{ Body: { amountMinor: number; currency: 'USD'; externalRef?: string } }>(
    '/ops/treasury/float-topup',
    {
      config: { idempotency: true },
      onRequest: async (request, reply) => {
        if (!opsWriteEnabled() || !env.OPS_ADMIN_USER_IDS.has(request.user!.id)) {
          return sendError(reply, 404, 'not_found', 'Route not found')
        }
      },
      schema: {
        body: floatTopUpBodySchema,
        response: {
          200: floatTopUpResponseSchema,
          400: errorResponseSchema,
          404: errorResponseSchema,
          409: errorResponseSchema,
          500: errorResponseSchema,
        },
      },
    },
    async (request, reply) => {
      if (!opsWriteEnabled() || !env.OPS_ADMIN_USER_IDS.has(request.user!.id)) {
        return sendError(reply, 404, 'not_found', 'Route not found')
      }

      const { amountMinor } = request.body
      // The idempotency preHandler already validated the header exists.
      const stated = request.body.externalRef?.trim() ?? ''
      const externalRef =
        stated.length > 0
          ? stated
          : `adhoc:${request.headers['idempotency-key'] as string}`

      try {
        await recordFloatTopUp({ amountMinor, externalRef })
        const balance = await getAccountBalance('bridge_wallet_float')
        return { amountMinor, externalRef, floatBalanceMinor: balance.amountMinor }
      } catch (err) {
        if (err instanceof PayoutValidationError) {
          // Input the schema could not catch (its messages carry amounts and
          // field names only — safe for this admin wire).
          return sendError(reply, 400, 'validation_error', err.message)
        }
        request.log.error(
          { route: 'ops/treasury/float-topup' },
          `ops float top-up failed: ${err instanceof Error ? err.message : String(err)}`,
        )
        return sendError(reply, 500, 'internal_error', 'Something went wrong')
      }
    },
  )
}
