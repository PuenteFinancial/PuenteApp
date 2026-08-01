import type { FastifyPluginAsync } from 'fastify'
import { env } from '../../config/env.js'
import { buildOpsOverview } from '../../services/ops-overview.js'
import { refundCancellation, denyCancellation } from '../../services/cancellation-review.js'
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
          enteredStateAt: { type: 'string' },
          dwellMinutes: { type: 'number' },
          thresholdMinutes: { type: 'number' },
          overThreshold: { type: 'boolean' },
          holdReason: { type: ['string', 'null'] },
          fundingCleared: { type: 'boolean' },
          submitAttempted: { type: 'boolean' },
          cancellationRequested: { type: 'boolean' },
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
}
