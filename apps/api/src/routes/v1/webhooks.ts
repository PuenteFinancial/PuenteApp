import crypto from 'node:crypto'
import * as Sentry from '@sentry/node'
import type { FastifyInstance } from 'fastify'
import { env } from '../../config/env.js'
import { BRIDGE_KYC_STATUS_MAP } from '../../services/bridge.js'
import { supabaseAdmin } from '../../services/supabase.js'
import { getFundingProcessor, isOnrampSessionRail } from '../../services/funding/index.js'
import { enqueuePaymentEventProcess } from '../../services/queue.js'
import { recordEvent, markProcessed } from '../../services/payment-events.js'
import { actOnRefundTailEvent } from '../../services/refunds.js'
import {
  applyFundingCleared,
  applyFundingFailed,
  applyFundingSucceeded,
  applyOnrampFunded,
  applyOnrampSettlement,
  type ApplyFundingOutcome,
  type OnrampAmountMismatch,
} from '../../services/funding-apply.js'
import { sendError, errorResponseSchema } from '../../utils/errors.js'

interface BridgeWebhookEvent {
  event_type?: string
  event_object_id?: string
  event_object_status?: string
  event_object?: {
    id?: string
    kyc_status?: string
    status?: string
    // transfer events (slice 5): the payout's current Bridge state and the
    // client_reference_id we set at submission (= our transfer UUID)
    state?: string
    client_reference_id?: string
  }
}

// Bridge customer event types that carry the current status. Verified against
// Bridge's event-structure docs and production deliveries — there is no
// "customer.kyc_status_updated" event; status changes arrive as
// customer.updated.status_transitioned (customer.created/updated also carry
// the current status, so processing them is an idempotent no-op or catch-up).
const CUSTOMER_STATUS_EVENT_TYPES = new Set([
  'customer.created',
  'customer.updated',
  'customer.updated.status_transitioned',
])

// Bridge signature freshness window (their docs: reject events older than 10 min)
const SIGNATURE_MAX_AGE_MS = 10 * 60 * 1000

// Header shape: "t=<ms-timestamp>,v0=<base64 signature>". Split each part at
// the FIRST '=' only — base64 padding contains '=' characters.
function parseSignatureHeader(header: string): { t: string; v0: string } | null {
  let t: string | undefined
  let v0: string | undefined
  for (const part of header.split(',')) {
    const idx = part.indexOf('=')
    if (idx === -1) return null
    const key = part.slice(0, idx).trim()
    const value = part.slice(idx + 1)
    if (key === 't') t = value
    else if (key === 'v0') v0 = value
  }
  if (!t || !v0) return null
  return { t, v0 }
}

function verifySignature(rawBody: Buffer, signatureHeader: string, publicKeyPem: string): boolean {
  const parsed = parseSignatureHeader(signatureHeader)
  if (!parsed) return false

  const timestamp = Number(parsed.t)
  if (!Number.isFinite(timestamp)) return false
  if (Date.now() - timestamp > SIGNATURE_MAX_AGE_MS) return false

  // Bridge signs RSA-PKCS1v15 over sha256(sha256("{t}.{body}")). The outer
  // sha256 happens inside RSA-SHA256 verification, so hash exactly once here.
  // Use the timestamp string as received — re-serializing could alter it.
  const digest = crypto.createHash('sha256').update(`${parsed.t}.`).update(rawBody).digest()

  const verifier = crypto.createVerify('RSA-SHA256')
  verifier.update(digest)
  try {
    return verifier.verify(publicKeyPem, parsed.v0, 'base64')
  } catch {
    // malformed base64 or unparseable key must reject, not crash
    return false
  }
}

export async function webhooksRoute(server: FastifyInstance) {
  // HMAC must be computed over the exact bytes Bridge sent, so JSON parsing
  // is deferred until after signature verification. Scoped to this plugin's
  // encapsulation context — other routes keep the default JSON parser.
  server.addContentTypeParser('application/json', { parseAs: 'buffer' }, (_request, body, done) =>
    done(null, body),
  )

  server.post(
    '/webhooks/bridge',
    {
      config: { public: true },
      schema: {
        response: {
          200: {
            type: 'object',
            properties: { received: { type: 'boolean' } },
          },
          400: errorResponseSchema,
          500: errorResponseSchema,
          503: errorResponseSchema,
        },
      },
    },
    async (request, reply) => {
      if (!env.BRIDGE_WEBHOOK_PUBLIC_KEY) {
        server.log.error('bridge webhook received but BRIDGE_WEBHOOK_PUBLIC_KEY is not set')
        return sendError(reply, 503, 'not_configured', 'Webhook not configured')
      }

      const signature = request.headers['x-webhook-signature']
      const rawBody = request.body as Buffer
      if (
        typeof signature !== 'string' ||
        !Buffer.isBuffer(rawBody) ||
        !verifySignature(rawBody, signature, env.BRIDGE_WEBHOOK_PUBLIC_KEY)
      ) {
        server.log.warn({ audit: true, webhook: 'bridge' }, 'invalid webhook signature')
        return sendError(reply, 400, 'validation_error', 'Invalid signature')
      }

      let event: BridgeWebhookEvent
      try {
        event = JSON.parse(rawBody.toString('utf8')) as BridgeWebhookEvent
      } catch {
        return sendError(reply, 400, 'validation_error', 'Invalid payload')
      }

      const eventType = event.event_type ?? 'unknown'
      const bridgeCustomerId = event.event_object?.id ?? event.event_object_id

      // Route is public so the audit plugin skips it — log explicitly.
      // Bridge customer id only, never PII.
      server.log.info(
        { audit: true, webhook: 'bridge', eventType, bridgeCustomerId },
        'bridge webhook received',
      )

      // A customer deleted in Bridge (support action, dashboard cleanup) must
      // not leave a dangling reference — a stale bridge_customer_id makes
      // every subsequent kyc_link request 404. Clear it so the next ToS
      // acceptance creates a fresh customer.
      if (eventType === 'customer.deleted' && bridgeCustomerId) {
        const { error } = await supabaseAdmin
          .from('users')
          .update({ bridge_customer_id: null, kyc_status: 'not_started' })
          .eq('bridge_customer_id', bridgeCustomerId)

        if (error) {
          server.log.error(
            { webhook: 'bridge', bridgeCustomerId, supabaseError: error.code },
            'bridge customer unlink failed',
          )
          // 500 so Bridge retries the delivery
          return sendError(reply, 500, 'internal_error', 'Failed to process webhook')
        }
        return { received: true }
      }

      // ── transfer events (slice 5): payout lifecycle ────────────────────────
      // Record raw, dedupe on (source, external_event_id), enqueue async
      // processing, ack fast. The payload is stored raw for the worker and is
      // NEVER logged here (decision 6) — only ids/type/state.
      if (eventType.startsWith('transfer.')) {
        const bridgeTransferId = event.event_object?.id ?? event.event_object_id
        const state = event.event_object?.state ?? event.event_object_status
        if (!bridgeTransferId || !state) {
          server.log.warn(
            { audit: true, webhook: 'bridge', eventType },
            'transfer event missing id or state',
          )
          return { received: true } // malformed — a retry won't fix it
        }

        // Resolve our transfer up front so the row carries it; the processor
        // falls back to provider_transfer_ref if this is null.
        const clientRef = event.event_object?.client_reference_id
        let transferId: string | null = null
        if (clientRef) {
          const { data } = await supabaseAdmin
            .from('transfers')
            .select('id')
            .eq('id', clientRef)
            .maybeSingle()
          transferId = (data as { id: string } | null)?.id ?? null
        }

        let recorded: { id: string; inserted: boolean }
        try {
          recorded = await recordEvent({
            source: 'bridge',
            // per-state key: redeliveries dedupe, distinct states don't collide
            externalEventId: `${bridgeTransferId}:${state}`,
            eventType: state,
            transferId,
            providerRef: bridgeTransferId,
            payload: event,
          })
        } catch {
          // insert failed — 500 so Bridge redelivers into a clean attempt
          return sendError(reply, 500, 'internal_error', 'Failed to record event')
        }

        server.log.info(
          { audit: true, webhook: 'bridge', eventType, state, transferId },
          'bridge transfer event recorded',
        )

        if (recorded.inserted) {
          try {
            await enqueuePaymentEventProcess(recorded.id, 'api')
          } catch (enqueueErr) {
            // still ack — payout.sweep re-enqueues stale received events
            server.log.warn(
              { webhook: 'bridge', paymentEventId: recorded.id },
              'payment-event enqueue failed — sweep will heal',
            )
            Sentry.captureException(enqueueErr)
          }
        }
        return { received: true }
      }

      if (CUSTOMER_STATUS_EVENT_TYPES.has(eventType) && bridgeCustomerId) {
        const bridgeStatus =
          event.event_object?.kyc_status ?? event.event_object?.status ?? event.event_object_status
        const kycStatus = bridgeStatus ? BRIDGE_KYC_STATUS_MAP[bridgeStatus] : undefined

        if (!kycStatus) {
          server.log.warn(
            { audit: true, webhook: 'bridge', bridgeCustomerId, bridgeStatus },
            'unmapped bridge kyc status',
          )
          return { received: true }
        }

        const update: Record<string, string> = { kyc_status: kycStatus }
        if (kycStatus === 'approved') {
          update.status = 'active'
        }

        const { error } = await supabaseAdmin
          .from('users')
          .update(update)
          .eq('bridge_customer_id', bridgeCustomerId)

        if (error) {
          server.log.error(
            { webhook: 'bridge', bridgeCustomerId, supabaseError: error.code },
            'kyc status update failed',
          )
          // 500 so Bridge retries the delivery
          return sendError(reply, 500, 'internal_error', 'Failed to process webhook')
        }
      }

      return { received: true }
    },
  )

  // Funding processor webhook — drives PENDING_PAYMENT → FUNDED (with the
  // first real ledger posting) and → PAYMENT_FAILED. The processor interface
  // owns signature scheme, header name, configured-check, and payload shape —
  // the route is identical for mock and Stripe (PR-S1). Exactly-once effects
  // come from the transition guard + the ledger's (transfer_id, transition)
  // uniqueness — replayed deliveries ack idempotently below.
  server.post(
    '/webhooks/funding',
    {
      config: { public: true },
      schema: {
        response: {
          200: {
            type: 'object',
            properties: { received: { type: 'boolean' } },
          },
          400: errorResponseSchema,
          500: errorResponseSchema,
          503: errorResponseSchema,
        },
      },
    },
    async (request, reply) => {
      // The processor declares its own configured-check. For the mock this IS
      // the production lock (its webhook secret is never set in prod, so mock
      // funding cannot exist there); for Stripe, env.superRefine already
      // refuses to boot a keyless stripe selection — this 503 is the runtime
      // belt-and-suspenders.
      const processor = getFundingProcessor()
      if (!processor.isConfigured()) {
        server.log.error(
          { webhook: 'funding', provider: processor.provider },
          'funding webhook received but the processor is not configured',
        )
        return sendError(reply, 503, 'not_configured', 'Webhook not configured')
      }

      // Amount-guard refusal (#213): the widget's amount is user-editable, so
      // a fulfillment event whose delivered amount doesn't match send+fee
      // applies NOTHING — no FUNDED, no payout, no ledger. Ack 200 (Stripe
      // redelivering identical data can't fix it) and page: real money may be
      // arriving at the treasury for a transfer we refused to fund — an ops
      // review case. Amounts are money values, not PII.
      const pageOnrampAmountMismatch = (
        mismatchTransferId: string,
        eventId: string,
        mismatch: OnrampAmountMismatch,
      ) => {
        server.log.error(
          {
            audit: true,
            webhook: 'funding',
            transferId: mismatchTransferId,
            eventId,
            expectedMinor: mismatch.expectedMinor,
            deliveredAmountMicro: mismatch.deliveredAmountMicro,
          },
          'onramp amount mismatch — nothing applied, payout NOT released',
        )
        Sentry.captureMessage('onramp funding amount mismatch', {
          level: 'error',
          fingerprint: ['onramp-amount-mismatch', mismatchTransferId],
          tags: { transferId: mismatchTransferId },
        })
      }

      const signature = request.headers[processor.signatureHeader]
      const rawBody = request.body as Buffer
      if (
        typeof signature !== 'string' ||
        !Buffer.isBuffer(rawBody) ||
        !processor.verifySignature(rawBody, signature)
      ) {
        server.log.warn({ audit: true, webhook: 'funding' }, 'invalid webhook signature')
        return sendError(reply, 400, 'validation_error', 'Invalid signature')
      }

      const parsed = processor.parseEvent(rawBody)
      if (parsed.outcome === 'malformed') {
        return sendError(reply, 400, 'validation_error', 'Invalid payload')
      }
      if (parsed.outcome === 'unhandled') {
        // Signed and well-formed but outside the funding mapping (e.g. Stripe
        // payment_method.automatically_updated). A 400 would put a legitimate
        // delivery into a redelivery loop and count against webhook-endpoint
        // health — ack it, keep the type visible to ops.
        server.log.warn(
          {
            audit: true,
            webhook: 'funding',
            eventId: parsed.eventId,
            eventType: parsed.eventType,
          },
          'unhandled funding event acknowledged',
        )
        return { received: true }
      }
      const event = parsed.event

      // Resolve the transfer: PI events echo transfers.id via metadata;
      // Stripe dispute events can't (transferRef null) and join through the
      // funding_payment_ref persisted at confirm instead.
      let transferId = event.transferRef
      if (transferId === null) {
        const { data: match } = await supabaseAdmin
          .from('transfers')
          .select('id')
          .eq('funding_payment_ref', event.paymentRef)
          .maybeSingle()
        transferId = (match as { id: string } | null)?.id ?? null
        if (!transferId) {
          // Signature was valid, so this is our processor talking about a
          // payment we never recorded — ack (a retry cannot fix it), log loud.
          server.log.error(
            { webhook: 'funding', eventId: event.eventId, paymentRef: event.paymentRef },
            'funding event unmatched to any transfer',
          )
          return { received: true }
        }
      }

      // Public route — audit plugin skips it; log explicitly. Ids only, no PII.
      server.log.info(
        {
          audit: true,
          webhook: 'funding',
          eventId: event.eventId,
          eventType: event.type,
          transferId,
        },
        'funding webhook received',
      )

      if (event.type === 'funding_cleared') {
        // A flag, not a state: recorded for the WAIT_FOR_CLEARING policy, plus
        // the ACH CLEARS cash leg. Both live in applyFundingCleared, shared with
        // the ops manual-funding action. The onramp rail (#213) routes through
        // applyOnrampSettlement instead — same cash leg, plus the out-of-order
        // catch-up (fulfillment_complete can beat fulfillment_processing) and
        // the float top-up for the USDC Stripe just delivered to the treasury.
        try {
          if (isOnrampSessionRail(processor.provider)) {
            const settled = await applyOnrampSettlement({
              transferId,
              paymentRef: event.paymentRef,
              eventId: event.eventId,
              ...(event.deliveredAmountMicro !== undefined && {
                deliveredAmountMicro: event.deliveredAmountMicro,
              }),
            })
            if ('outcome' in settled) {
              pageOnrampAmountMismatch(transferId, event.eventId, settled)
              return { received: true }
            }
            server.log.info(
              {
                webhook: 'funding',
                transferId,
                caughtUp: settled.caughtUp,
                cleared: settled.cleared.outcome,
                floatTopUp: settled.floatTopUpKey !== null,
              },
              'onramp settlement applied',
            )
          } else {
            const cleared = await applyFundingCleared({ transferId })
            if (cleared.outcome === 'skipped') {
              server.log.info(
                { webhook: 'funding', transferId, state: cleared.state },
                'funding_cleared: receivable already closed, no cash leg posted',
              )
            }
          }
        } catch (err) {
          // Never replay-safe to fail silently: the flag is already set, so a
          // lost posting would leave the receivable open forever with no retry.
          // The unique (transfer, transition) key makes a redelivery a no-op, so
          // 500 and let the processor redeliver.
          server.log.error(
            { webhook: 'funding', transferId },
            `funding_cleared failed: ${err instanceof Error ? err.message : String(err)}`,
          )
          return sendError(reply, 500, 'internal_error', 'Failed to process webhook')
        }
        return { received: true }
      }

      if (event.type === 'funding_reversed') {
        // Post-COMPLETED handling (loss booking, recovery) needs the slice-5/6
        // machinery — normalize + record the delivery now, act later. (For
        // Stripe this is a post-settlement ACH return via dispute — final, no
        // appeal; PR-S2's refund guard and the O-lane recon own the tail.)
        server.log.warn(
          { audit: true, webhook: 'funding', transferId, eventId: event.eventId },
          'funding_reversed received — handling deferred to slice 5/6',
        )
        return { received: true }
      }

      if (event.type === 'refund_failed' || event.type === 'refund_settled') {
        // The undo tail (PR-S2): a refund ISSUED by voidFunding/refund
        // resolving days later. No state transition — the transfer settled at
        // REFUNDED at issuance; this is the money-truth record plus, on a
        // bounce, the ops page (sender still owed; never auto-adjusted).
        // Recorded to payment_events (source 'funding') so replays dedupe, the
        // O-lane reconciliation can read it, and — if this handler dies before
        // the mark below — payout-sweep re-enqueues the stale 'received' row
        // into the payment-event job, which re-drives the same act.
        let recorded: Awaited<ReturnType<typeof recordEvent>>
        try {
          recorded = await recordEvent({
            source: 'funding',
            externalEventId: event.eventId,
            eventType: event.type,
            transferId,
            providerRef: event.undoRef ?? null,
            payload: JSON.parse(rawBody.toString('utf8')) as unknown,
          })
        } catch {
          // insert failed — 500 so the provider redelivers into a clean attempt
          return sendError(reply, 500, 'internal_error', 'Failed to record event')
        }
        if (!recorded.inserted && recorded.status !== 'received') {
          return { received: true } // replayed delivery — already handled
        }

        if (event.type === 'refund_failed') {
          // Public route — audit plugin skips it; ids only, no PII.
          server.log.error(
            {
              audit: true,
              webhook: 'funding',
              transferId,
              eventId: event.eventId,
              refundRef: event.undoRef,
            },
            'funding refund failed — sender still owed',
          )
        }
        actOnRefundTailEvent({
          eventType: event.type,
          transferId,
          refundRef: event.undoRef ?? null,
          ...(event.reason !== undefined && { reason: event.reason }),
        })
        try {
          await markProcessed(recorded.id)
        } catch {
          // The act is done and idempotent (fingerprinted page). A failed mark
          // leaves the row 'received'; the sweep→job path retires it — ack
          // rather than pull Stripe into a redelivery loop over our own DB.
        }
        return { received: true }
      }

      // funding_succeeded | funding_failed → state transition.
      // Both appliers live in services/transfers.ts and are shared with the ops
      // manual-funding action, so "a transfer became funded" has exactly one
      // implementation regardless of what triggered it. The onramp rail routes
      // funding_succeeded through the amount guard first (#213): its widget
      // amount is user-editable, so FUNDED must never release on the event's
      // say-so alone.
      let result: ApplyFundingOutcome
      try {
        if (event.type === 'funding_succeeded' && isOnrampSessionRail(processor.provider)) {
          const funded = await applyOnrampFunded({
            transferId,
            paymentRef: event.paymentRef,
            eventId: event.eventId,
            ...(event.deliveredAmountMicro !== undefined && {
              deliveredAmountMicro: event.deliveredAmountMicro,
            }),
          })
          if (funded.outcome === 'amount_mismatch') {
            pageOnrampAmountMismatch(transferId, event.eventId, funded)
            return { received: true }
          }
          result = funded
        } else {
          result =
            event.type === 'funding_succeeded'
              ? await applyFundingSucceeded({
                  transferId,
                  paymentRef: event.paymentRef,
                  eventId: event.eventId,
                  actor: 'webhook:funding',
                })
              : await applyFundingFailed({
                  transferId,
                  paymentRef: event.paymentRef,
                  eventId: event.eventId,
                  actor: 'webhook:funding',
                  ...(event.reason !== undefined && { reason: event.reason }),
                })
        }
      } catch {
        server.log.error(
          { webhook: 'funding', transferId, eventId: event.eventId },
          'funding transition failed',
        )
        // 500 so the provider redelivers into a clean row
        return sendError(reply, 500, 'internal_error', 'Failed to process webhook')
      }

      if (result.outcome === 'unknown_transfer') {
        // signature was valid, so this is our own processor talking about a
        // transfer we don't have — ack (a retry cannot fix it) but log loudly
        server.log.error(
          { webhook: 'funding', transferId, eventId: event.eventId },
          'funding event for unknown transfer',
        )
      } else if (result.outcome === 'stale') {
        // the transfer has already moved past this event
        server.log.warn(
          { webhook: 'funding', transferId, eventId: event.eventId },
          'stale funding event for advanced transfer',
        )
      } else if (result.outcome === 'applied' && result.enqueueFailed) {
        server.log.warn(
          { webhook: 'funding', transferId },
          'payout.submit enqueue failed — payout.sweep will heal',
        )
      }

      return { received: true }
    },
  )
}
