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
  event_object_id?: string
  event_object_status?: string
  event_object?: {
    id?: string
    kyc_status?: string
    status?: string
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
  const digest = crypto
    .createHash('sha256')
    .update(`${parsed.t}.`)
    .update(rawBody)
    .digest()

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
      if (!env.BRIDGE_WEBHOOK_PUBLIC_KEY) {
        server.log.error('bridge webhook received but BRIDGE_WEBHOOK_PUBLIC_KEY is not set')
        return reply.status(503).send({ error: 'Webhook not configured' })
      }

      const signature = request.headers['x-webhook-signature']
      const rawBody = request.body as Buffer
      if (
        typeof signature !== 'string' ||
        !Buffer.isBuffer(rawBody) ||
        !verifySignature(rawBody, signature, env.BRIDGE_WEBHOOK_PUBLIC_KEY)
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
          return reply.status(500).send({ error: 'Failed to process webhook' })
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
          return reply.status(500).send({ error: 'Failed to process webhook' })
        }
      }

      return { received: true }
    },
  )
}
