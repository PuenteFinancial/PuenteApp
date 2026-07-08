import crypto from 'node:crypto'
import type { FastifyInstance } from 'fastify'
import type { KycStatus } from '@puente/shared'
import { env } from '../../config/env.js'
import { supabaseAdmin } from '../../services/supabase.js'

// Bridge statuses we don't recognize fall through unmapped and are only logged
const BRIDGE_KYC_STATUS_MAP: Record<string, KycStatus> = {
  not_started: 'not_started',
  incomplete: 'pending',
  awaiting_questionnaire: 'pending',
  awaiting_ubo: 'pending',
  under_review: 'pending',
  in_review: 'pending',
  pending: 'pending',
  manual_review: 'manual_review',
  approved: 'approved',
  active: 'approved',
  rejected: 'rejected',
}

interface BridgeWebhookEvent {
  event_type?: string
  event_object?: {
    id?: string
    kyc_status?: string
    status?: string
  }
}

function verifySignature(rawBody: Buffer, signatureHeader: string, secret: string): boolean {
  const expected = crypto.createHmac('sha256', secret).update(rawBody).digest('hex')
  const received = Buffer.from(signatureHeader)
  const computed = Buffer.from(expected)
  return received.length === computed.length && crypto.timingSafeEqual(received, computed)
}

export async function webhooksRoute(server: FastifyInstance) {
  // HMAC must be computed over the exact bytes Bridge sent, so JSON parsing
  // is deferred until after signature verification. Scoped to this plugin's
  // encapsulation context — other routes keep the default JSON parser.
  server.addContentTypeParser(
    'application/json',
    { parseAs: 'buffer' },
    (_request, body, done) => done(null, body),
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
          400: {
            type: 'object',
            properties: { error: { type: 'string' } },
          },
          500: {
            type: 'object',
            properties: { error: { type: 'string' } },
          },
          503: {
            type: 'object',
            properties: { error: { type: 'string' } },
          },
        },
      },
    },
    async (request, reply) => {
      if (!env.BRIDGE_WEBHOOK_SECRET) {
        server.log.error('bridge webhook received but BRIDGE_WEBHOOK_SECRET is not set')
        return reply.status(503).send({ error: 'Webhook not configured' })
      }

      const signature = request.headers['x-webhook-signature']
      const rawBody = request.body as Buffer
      if (
        typeof signature !== 'string' ||
        !Buffer.isBuffer(rawBody) ||
        !verifySignature(rawBody, signature, env.BRIDGE_WEBHOOK_SECRET)
      ) {
        server.log.warn({ audit: true, webhook: 'bridge' }, 'invalid webhook signature')
        return reply.status(400).send({ error: 'Invalid signature' })
      }

      let event: BridgeWebhookEvent
      try {
        event = JSON.parse(rawBody.toString('utf8')) as BridgeWebhookEvent
      } catch {
        return reply.status(400).send({ error: 'Invalid payload' })
      }

      const eventType = event.event_type ?? 'unknown'
      const bridgeCustomerId = event.event_object?.id

      // Route is public so the audit plugin skips it — log explicitly.
      // Bridge customer id only, never PII.
      server.log.info(
        { audit: true, webhook: 'bridge', eventType, bridgeCustomerId },
        'bridge webhook received',
      )

      if (eventType === 'customer.kyc_status_updated' && bridgeCustomerId) {
        const bridgeStatus = event.event_object?.kyc_status ?? event.event_object?.status
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
          return reply.status(500).send({ error: 'Failed to process webhook' })
        }
      }

      return { received: true }
    },
  )
}
