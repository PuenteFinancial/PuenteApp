import type { FastifyPluginAsync } from 'fastify'
import { buildOpsTransferDetail } from '../../services/ops-transfer-detail.js'
import { errorResponseSchema, sendError } from '../../utils/errors.js'
import { opsWriteEnabled, opsReadAllowed, opsReadOnRequest, denyAsNotFound } from './ops-gate.js'

// Per-transfer ops surface (ops board slice 1, docs/api-contract.md). Same
// double-control posture as ops.ts, same output-allowlist response schemas:
// every field is enumerated and nothing sets additionalProperties true, so a
// widened service read cannot leak a new column onto this wire without a
// deliberate schema change here.
//
// Unlike GET /ops/overview, this route has a params schema — so the allowlist
// gate runs as a route-level onRequest hook, BEFORE validation. Otherwise a
// non-admin sending a malformed id would receive a 400 and learn the route
// exists; the 404 posture must win every race. The handler re-checks too.

const nullableString = { type: ['string', 'null'] } as const

const dwellSchema = {
  type: ['object', 'null'],
  properties: {
    enteredStateAt: { type: 'string' },
    dwellMinutes: { type: 'number' },
    thresholdMinutes: { type: 'number' },
    overThreshold: { type: 'boolean' },
  },
} as const

const detailResponseSchema = {
  type: 'object',
  properties: {
    generatedAt: { type: 'string' },
    // Whether the write capability is live on THIS deployment (overview
    // precedent) — the page renders action buttons only when true.
    actionsEnabled: { type: 'boolean' },
    transfer: {
      type: 'object',
      properties: {
        transferId: { type: 'string' },
        state: { type: 'string' },
        sendAmountMinor: { type: 'number' },
        sendCurrency: { type: 'string' },
        receiveAmountMinor: { type: 'number' },
        receiveCurrency: { type: 'string' },
        feeAmountMinor: { type: 'number' },
        marginMinor: { type: 'number' },
        fxRate: { type: 'number' },
        fundingSourceType: { type: 'string' },
        fundingProcessor: { type: 'string' },
        fundingCleared: { type: 'boolean' },
        fundingPaymentRef: nullableString,
        providerTransferRef: nullableString,
        refundPaymentRef: nullableString,
        payoutHoldReason: nullableString,
        payoutHeldAt: nullableString,
        submitAttemptedAt: nullableString,
        cancellationRequestedAt: nullableString,
        paymentClaimedAt: nullableString,
        disclosureAcceptedAt: nullableString,
        paymentAt: nullableString,
        cancelableUntil: nullableString,
        completedAt: nullableString,
        refundedAt: nullableString,
        createdAt: { type: 'string' },
        dwell: dwellSchema,
      },
    },
    quote: {
      type: ['object', 'null'],
      properties: {
        fxRate: { type: 'number' },
        sourceRate: { type: 'number' },
        marginMinor: { type: 'number' },
        fxRateAt: { type: 'string' },
        expiresAt: { type: 'string' },
        createdAt: { type: 'string' },
        status: { type: 'string' },
      },
    },
    // Statuses only — never who the recipient is or where the money goes.
    destination: {
      type: ['object', 'null'],
      properties: {
        status: { type: 'string' },
        hasProviderAccountRef: { type: 'boolean' },
        recipientStatus: nullableString,
      },
    },
    refund: {
      type: 'object',
      properties: {
        claimStatus: { type: 'string', enum: ['unclaimed', 'claimed', 'abandoned'] },
        claimedAt: nullableString,
        claimedBy: nullableString,
        returnEventType: nullableString,
        ledgerKeys: {
          type: 'object',
          properties: {
            bridgeReturn: { type: 'boolean' },
            refunded: { type: 'boolean' },
          },
        },
      },
    },
    transitions: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          fromState: nullableString,
          toState: { type: 'string' },
          actor: { type: 'string' },
          reason: nullableString,
          createdAt: { type: 'string' },
        },
      },
    },
    ledger: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          transition: nullableString,
          idempotencyKey: { type: 'string' },
          description: nullableString,
          postedAt: { type: 'string' },
          netMinor: { type: 'number' },
          entries: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                accountCode: { type: 'string' },
                direction: { type: 'string' },
                amountMinor: { type: 'number' },
                currency: { type: 'string' },
              },
            },
          },
        },
      },
    },
    paymentEvents: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          source: { type: 'string' },
          eventType: { type: 'string' },
          status: { type: 'string' },
          receivedAt: { type: 'string' },
          processedAt: nullableString,
          providerRef: nullableString,
          hasError: { type: 'boolean' },
        },
      },
    },
    cancellationRequests: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          requestedAt: { type: 'string' },
          requestedState: { type: 'string' },
          withinWindow: { type: 'boolean' },
          status: { type: 'string' },
          resolvedAt: nullableString,
          resolvedBy: nullableString,
        },
      },
    },
    depositInstructions: {
      type: ['object', 'null'],
      properties: {
        bridgeTransferRef: { type: 'string' },
        currency: { type: 'string' },
        amountMinor: { type: 'number' },
        paymentRail: { type: 'string' },
        depositMessage: { type: 'string' },
        attachedBy: nullableString,
      },
    },
    disclosures: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          type: { type: 'string' },
          locale: { type: 'string' },
          presentedAt: { type: 'string' },
        },
      },
    },
  },
} as const

const detailParamsSchema = {
  type: 'object',
  required: ['id'],
  additionalProperties: false,
  properties: {
    id: { type: 'string', format: 'uuid' },
  },
} as const

export const opsTransfersRoute: FastifyPluginAsync = async (server) => {
  server.get<{ Params: { id: string } }>(
    '/ops/transfers/:id',
    {
      onRequest: opsReadOnRequest,
      schema: {
        params: detailParamsSchema,
        response: {
          200: detailResponseSchema,
          400: errorResponseSchema,
          404: errorResponseSchema,
          500: errorResponseSchema,
        },
      },
    },
    async (request, reply) => {
      // Gate FIRST, again: env can drift after registration, and the surface
      // must not confirm it exists. Same 404 body as every ops refusal.
      if (!opsReadAllowed(request)) return denyAsNotFound(reply)

      try {
        const detail = await buildOpsTransferDetail(request.params.id)
        // The gate has passed, so a real not-found is honest here: the
        // operator is allowlisted and typed an id we do not have.
        if (detail == null) return sendError(reply, 404, 'not_found', 'Transfer not found')
        return { ...detail, actionsEnabled: opsWriteEnabled() }
      } catch (err) {
        // Fail closed and loud: a broken read must never render as an empty
        // timeline. Message only (no error objects — provider bodies can
        // carry PII).
        request.log.error(
          { route: 'ops/transfers/detail' },
          `ops transfer detail failed: ${err instanceof Error ? err.message : String(err)}`,
        )
        return sendError(reply, 500, 'internal_error', 'Something went wrong')
      }
    },
  )
}
