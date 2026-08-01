import type { FastifyPluginAsync } from 'fastify'
import { env } from '../../config/env.js'
import { buildOpsOverview } from '../../services/ops-overview.js'
import { errorResponseSchema, sendError } from '../../utils/errors.js'

// The read-only money-ops overview (slice 8.5-v1, docs/api-contract.md).
// Registered in server.ts ONLY when OPS_ADMIN_USER_IDS is non-empty, and the
// handler independently re-checks membership as its FIRST statement — the
// dev-route double-control posture. Non-members get a 404 whose body is
// byte-identical to the router's own not-found response ('Route not found'):
// this surface must not confirm it exists. v1.1 replaces the allowlist with a
// real admin-auth design before any write endpoint ships.
//
// The response schema is the OUTPUT ALLOWLIST: every field is enumerated and
// nothing sets additionalProperties true — a future reconciliation check (or a
// widened service read) cannot leak new fields onto this wire without a
// deliberate schema change here.

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
        return await buildOpsOverview()
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
}
