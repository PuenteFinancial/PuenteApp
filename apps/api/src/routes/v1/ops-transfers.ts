import type { FastifyPluginAsync } from 'fastify'
import * as Sentry from '@sentry/node'
import { buildOpsTransferDetail } from '../../services/ops-transfer-detail.js'
import { releaseHold, RELEASABLE_HOLD_REASONS, type ReleasableHoldReason } from '../../services/payout-holds.js'
import {
  verifyPrincipalReturned,
  refundClaimStatus,
  refundPayoutFailure,
  refundLedgerBatches,
  type PrincipalVerdict,
} from '../../services/refunds.js'
import { BridgeApiError, isBridgeUnreachable } from '../../services/bridge.js'
import { recordOpsAction } from '../../services/ops-actions.js'
import { errorResponseSchema, sendError } from '../../utils/errors.js'
import {
  opsWriteEnabled,
  opsReadAllowed,
  opsWriteAllowed,
  opsReadOnRequest,
  opsWriteOnRequest,
  denyAsNotFound,
} from './ops-gate.js'

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
//
// Writes (O-B): POST /ops/transfers/hold-release and POST /ops/transfers/refund
// — the two actions a crypto-rail pilot needs, previously a SQL statement in
// the Supabase editor and a CLI. Both: double-control gate, transferId in the
// BODY (idempotency identity = route pattern + body hash, ops.ts precedent),
// Idempotency-Key required, a typed operator note, refusals as non-2xx, and an
// append-only ops_actions row on every 2xx. Neither offers the CLI's --reclaim:
// an abandoned refund claim is the STOP state, runbook only.

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
    // Slice 2: this transfer's ops history. The note rides here (and only
    // here); before/after arrive as a derived list of string changes so the
    // allowlist stays strict — a raw jsonb object never crosses this wire.
    activity: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          createdAt: { type: 'string' },
          actor: { type: 'string' },
          action: { type: 'string' },
          transferId: { type: ['string', 'null'] },
          reason: { type: ['string', 'null'] },
          note: { type: ['string', 'null'] },
          changes: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                key: { type: 'string' },
                before: { type: ['string', 'null'] },
                after: { type: ['string', 'null'] },
              },
            },
          },
          requestId: { type: ['string', 'null'] },
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

// The operator's typed note: what they verified before acting. Short enough to
// stay a note, long enough to force a sentence. Free text, stored ONLY in
// ops_actions.note — never in transfer_transitions.reason, never logged.
const noteSchema = { type: 'string', minLength: 10, maxLength: 500 } as const

// The enum IS the policy: sender_kyc_pending is not in it (auto-released;
// releasing while unverified only re-holds), so the schema 400s it.
const holdReleaseBodySchema = {
  type: 'object',
  required: ['transferId', 'reason', 'note'],
  additionalProperties: false,
  properties: {
    transferId: { type: 'string', format: 'uuid' },
    reason: { type: 'string', enum: [...RELEASABLE_HOLD_REASONS] },
    note: noteSchema,
  },
} as const

const holdReleaseResponseSchema = {
  type: 'object',
  properties: {
    transferId: { type: 'string' },
    outcome: { type: 'string', enum: ['released'] },
    // False = the direct enqueue failed; the 1-min sweep resubmits regardless.
    enqueued: { type: 'boolean' },
  },
} as const

const refundBodySchema = {
  type: 'object',
  required: ['transferId', 'note'],
  additionalProperties: false,
  properties: {
    transferId: { type: 'string', format: 'uuid' },
    note: noteSchema,
  },
} as const

const refundResponseSchema = {
  type: 'object',
  properties: {
    transferId: { type: 'string' },
    outcome: { type: 'string', enum: ['refunded', 'already_disbursed', 'already_settled'] },
    // Whether every expected refund batch is on the ledger (bridge_return only
    // when the payout had reached Bridge). False is paged server-side; the
    // operator sees it too.
    ledgerComplete: { type: 'boolean' },
    ledgerKeys: { type: 'array', items: { type: 'string' } },
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

  // The write surface does not exist unless both controls are set at boot
  // (ops.ts precedent).
  if (!opsWriteEnabled()) return

  // POST /v1/ops/transfers/hold-release — the runbook's release SQL as a
  // button. Idempotency-keyed even though the compare-and-swap is naturally
  // idempotent: a replay after a network blip must echo the 200, not surface
  // as a 409 not_held that reads like a failure; and a release initiates a
  // payout submission, which is money-moving in effect.
  server.post<{ Body: { transferId: string; reason: ReleasableHoldReason; note: string } }>(
    '/ops/transfers/hold-release',
    {
      config: { idempotency: true },
      onRequest: opsWriteOnRequest,
      schema: {
        body: holdReleaseBodySchema,
        response: {
          200: holdReleaseResponseSchema,
          400: errorResponseSchema,
          404: errorResponseSchema,
          409: errorResponseSchema,
          500: errorResponseSchema,
        },
      },
    },
    async (request, reply) => {
      if (!opsWriteAllowed(request)) return denyAsNotFound(reply)

      const { transferId, reason, note } = request.body
      try {
        const outcome = await releaseHold(
          {
            transferId,
            reason,
            // Actor from the verified JWT, never the body (decisions.md 2026-08-01).
            actor: `ops:${request.user!.id}`,
            note: note.trim(),
            requestId: request.id,
          },
          request.log,
        )
        if (outcome.done) {
          return { transferId, outcome: outcome.outcome, enqueued: outcome.enqueued }
        }
        // Refusals are NON-2xx by design (ops.ts): the idempotency plugin
        // replays only 2xx, and a non-2xx releases the claim for a retry. Every
        // branch here means "the row moved — refresh" on the web, so `conflict`
        // + details is enough; no new code.
        switch (outcome.reason) {
          case 'transfer_not_found':
            return sendError(reply, 404, 'not_found', 'Transfer not found')
          case 'not_funded':
            return sendError(reply, 409, 'conflict', 'Transfer is not FUNDED', [
              { path: 'transferId', issue: `state is ${outcome.state}` },
            ])
          case 'not_held':
            return sendError(reply, 409, 'conflict', 'Transfer has no payout hold', [
              { path: 'transferId', issue: 'no hold on this transfer' },
            ])
          case 'hold_reason_mismatch':
            return sendError(reply, 409, 'conflict', 'The hold changed underneath you', [
              { path: 'reason', issue: `hold is ${outcome.actual}` },
            ])
        }
      } catch (err) {
        request.log.error(
          { route: 'ops/transfers/hold-release' },
          `ops hold release failed: ${err instanceof Error ? err.message : String(err)}`,
        )
        return sendError(reply, 500, 'internal_error', 'Something went wrong')
      }
    },
  )

  // POST /v1/ops/transfers/refund — scripts/trigger-refund.ts as a button, same
  // step order: (1) the principal-returned interlock (recorded event + LIVE
  // Bridge state must agree; a pre-submit row passes, #254), (2) the claim —
  // abandoned is the STOP state and refuses BEFORE any write, (3) the refund
  // service, (4) prove the batches landed, (5) the provenance row. No --reclaim
  // here, ever. The one live provider call on the ops surface, bounded by
  // BRIDGE_TIMEOUT_SECONDS; unreachable Bridge is a 500 (silence is not
  // confirmation).
  server.post<{ Body: { transferId: string; note: string } }>(
    '/ops/transfers/refund',
    {
      config: { idempotency: true },
      onRequest: opsWriteOnRequest,
      schema: {
        body: refundBodySchema,
        response: {
          200: refundResponseSchema,
          400: errorResponseSchema,
          404: errorResponseSchema,
          409: errorResponseSchema,
          500: errorResponseSchema,
        },
      },
    },
    async (request, reply) => {
      if (!opsWriteAllowed(request)) return denyAsNotFound(reply)

      const { transferId, note } = request.body
      const actor = `ops:${request.user!.id}`
      try {
        // 1) Interlock. bridge_return ASSERTS Bridge sent our cash back; two
        //    independent sources must agree before it may post. Bridge not
        //    reachable (transport error, timeout, 5xx) → 502: the check did
        //    not run, nothing was written, try again shortly — never a 500,
        //    which reads as "something broke" and hides that a retry is the
        //    right move. A Bridge 4xx is an ANSWER (it does not know our ref):
        //    not transient, so it takes the STOP code with the status in
        //    details. Anything else (the DB read inside) stays a 500.
        let verdict: PrincipalVerdict
        try {
          verdict = await verifyPrincipalReturned(transferId)
        } catch (err) {
          const bridgeStatus = err instanceof BridgeApiError ? err.status : null
          if (isBridgeUnreachable(err)) {
            request.log.error(
              { route: 'ops/transfers/refund', transferId, bridgeStatus },
              'ops refund: Bridge unreachable during the principal interlock — nothing written',
            )
            return sendError(
              reply,
              502,
              'provider_unavailable',
              'Bridge is unreachable — the principal check did not run and nothing was changed. Try again shortly.',
            )
          }
          if (err instanceof BridgeApiError) {
            request.log.error(
              { route: 'ops/transfers/refund', transferId, bridgeStatus },
              'ops refund: Bridge rejected the interlock lookup',
            )
            return sendError(
              reply,
              409,
              'principal_not_returned',
              'Bridge did not recognize this transfer — the principal check could not run. Read the Bridge dashboard, then follow runbooks/manual-refund.md.',
              [{ path: 'transferId', issue: `bridge_lookup_failed; bridge=http_${err.status}; event=unknown` }],
            )
          }
          throw err
        }
        let preSubmit = false
        if (!verdict.returned) {
          if (verdict.reason === 'transfer_not_found') {
            return sendError(reply, 404, 'not_found', 'Transfer not found')
          }
          if (verdict.reason === 'not_submitted') {
            // Never reached Bridge: nothing left, nothing to return; the tail
            // posts no bridge_return and the ledger check expects one batch.
            preSubmit = true
          } else {
            const stuck = verdict.bridgeState === 'refund_failed'
            return sendError(
              reply,
              409,
              'principal_not_returned',
              stuck
                ? 'Bridge reports refund_failed — the principal is stuck AT Bridge, not returned. Escalate per runbooks/manual-refund.md.'
                : 'Principal not confirmed returned — the recorded event and Bridge must agree before a refund can post',
              [
                {
                  path: 'transferId',
                  issue: `${verdict.reason}; bridge=${verdict.bridgeState ?? 'unknown'}; event=${verdict.eventType ?? 'none'}`,
                },
              ],
            )
          }
        }

        // 2) The claim, BEFORE any write — the CLI reports it before --confirm
        //    for the same reason. Abandoned = a prior run may have paid without
        //    recording; only a human at the processor can tell.
        const claim = await refundClaimStatus(transferId)
        if (claim == null) return sendError(reply, 404, 'not_found', 'Transfer not found')
        if (claim.claimStatus === 'abandoned') {
          return sendError(
            reply,
            409,
            'claim_abandoned',
            'A prior refund run abandoned its claim — follow the manual-refund runbook',
          )
        }

        // 3) The refund itself. Full actor string here (unlike refundCancellation,
        //    which prefixes internally); the operator's note stays out of the
        //    transition reason — that field is system vocabulary.
        const outcome = await refundPayoutFailure({
          transferId,
          actor,
          reason: 'ops board refund — AUTO_REFUND off',
        })
        if (!outcome.done) {
          switch (outcome.reason) {
            case 'transfer_not_found':
              return sendError(reply, 404, 'not_found', 'Transfer not found')
            case 'not_payout_failed':
              return sendError(reply, 409, 'conflict', 'Transfer is not PAYOUT_FAILED', [
                { path: 'transferId', issue: `state is ${outcome.state}` },
              ])
            case 'claim_taken':
              return sendError(reply, 409, 'conflict', 'A refund run holds the claim — wait for it', [
                {
                  path: 'transferId',
                  issue: `refund in progress since ${outcome.claimedAt ?? 'unknown'} by ${outcome.claimedBy ?? 'unknown'}`,
                },
              ])
            case 'claim_abandoned':
              return sendError(
                reply,
                409,
                'claim_abandoned',
                'A prior refund run abandoned its claim — follow the manual-refund runbook',
              )
          }
        }

        // 4) Prove the batches landed. Money has moved by now, so an incomplete
        //    ledger is paged, not turned into a 500 the operator would retry.
        const batches = await refundLedgerBatches(transferId)
        const ledgerKeys = batches.map((b) => b.idempotency_key)
        const expected = preSubmit
          ? [`${transferId}:REFUNDED`]
          : [`${transferId}:bridge_return`, `${transferId}:REFUNDED`]
        const ledgerComplete = expected.every((key) => ledgerKeys.includes(key))
        if (!ledgerComplete) {
          request.log.error(
            { route: 'ops/transfers/refund', transferId, expected, ledgerKeys },
            'ops refund: expected ledger batch missing after refund',
          )
          Sentry.withScope((scope) => {
            scope.setFingerprint(['ops-refund-ledger-incomplete', transferId])
            scope.setContext('ops_refund', { transferId, expected, ledgerKeys, outcome: outcome.outcome })
            Sentry.captureMessage('ops refund: expected ledger batch missing', 'error')
          })
        }

        // 5) Provenance — on every 2xx, including already_settled (the operator
        //    still acted; the row says nothing moved).
        await recordOpsAction(
          {
            actor,
            action: 'refund',
            transferId,
            reason: outcome.outcome,
            note: note.trim(),
            before: { state: 'PAYOUT_FAILED', claimStatus: claim.claimStatus, preSubmit },
            after: { state: 'REFUNDED', outcome: outcome.outcome, ledgerComplete },
            requestId: request.id,
          },
          request.log,
        )

        return { transferId, outcome: outcome.outcome, ledgerComplete, ledgerKeys }
      } catch (err) {
        request.log.error(
          { route: 'ops/transfers/refund' },
          `ops refund failed: ${err instanceof Error ? err.message : String(err)}`,
        )
        return sendError(reply, 500, 'internal_error', 'Something went wrong')
      }
    },
  )
}
