import type { FastifyInstance } from 'fastify'
import { REQUIRED_CONSENTS, type ConsentDocument } from '@puente/shared'
import { supabaseAdmin } from '../../services/supabase.js'
import { sendError, errorResponseSchema } from '../../utils/errors.js'

// K1 (KYC rehaul): the consent leg of onboarding. Grants are append-only rows
// in `consents`; what counts as "current" is REQUIRED_CONSENTS in
// packages/shared — shared with the web router so both ends agree on when a
// user is done consenting.

interface ConsentRow {
  type: string
  version: string
  locale: string
  consented_at: string
}

export async function fetchGrantedConsents(userId: string): Promise<ConsentRow[] | null> {
  const { data, error } = await supabaseAdmin
    .from('consents')
    .select('type, version, locale, consented_at')
    .eq('user_id', userId)

  if (error) return null
  return (data ?? []) as ConsentRow[]
}

export function missingConsents(granted: Pick<ConsentRow, 'type' | 'version'>[]): ConsentDocument[] {
  return REQUIRED_CONSENTS.filter(
    (req) => !granted.some((g) => g.type === req.type && g.version === req.version),
  )
}

const consentDocumentSchema = {
  type: 'object',
  properties: {
    type: { type: 'string' },
    version: { type: 'string' },
  },
} as const

const consentsResponseSchema = {
  type: 'object',
  properties: {
    required: { type: 'array', items: consentDocumentSchema },
    granted: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          type: { type: 'string' },
          version: { type: 'string' },
          locale: { type: 'string' },
          consentedAt: { type: 'string' },
        },
      },
    },
    missing: { type: 'array', items: consentDocumentSchema },
  },
} as const

function toConsentsResponse(granted: ConsentRow[]) {
  return {
    required: REQUIRED_CONSENTS,
    granted: granted.map((g) => ({
      type: g.type,
      version: g.version,
      locale: g.locale,
      consentedAt: g.consented_at,
    })),
    missing: missingConsents(granted),
  }
}

interface GrantConsentsBody {
  consents: { type: string; version: string }[]
  locale: 'en' | 'es'
}

export async function consentsRoute(server: FastifyInstance) {
  server.get(
    '/users/me/consents',
    {
      schema: {
        response: {
          200: consentsResponseSchema,
          500: errorResponseSchema,
        },
      },
    },
    async (request, reply) => {
      const userId = request.user!.id
      const granted = await fetchGrantedConsents(userId)
      if (granted === null) {
        return sendError(reply, 500, 'internal_error', 'Failed to load consents')
      }
      return toConsentsResponse(granted)
    },
  )

  server.post<{ Body: GrantConsentsBody }>(
    '/users/me/consents',
    {
      schema: {
        body: {
          type: 'object',
          required: ['consents', 'locale'],
          properties: {
            locale: { type: 'string', enum: ['en', 'es'] },
            consents: {
              type: 'array',
              minItems: 1,
              maxItems: 8,
              items: {
                type: 'object',
                required: ['type', 'version'],
                properties: {
                  // bridge_tos is deliberately not accepted here: it is
                  // written server-side at first send with signed_agreement_id
                  // evidence (K4/K5), never self-asserted by the client.
                  type: { type: 'string', enum: ['esign', 'puente_tos', 'puente_privacy'] },
                  version: { type: 'string', minLength: 1, maxLength: 32 },
                },
                additionalProperties: false,
              },
            },
          },
          additionalProperties: false,
        },
        response: {
          200: consentsResponseSchema,
          400: errorResponseSchema,
          500: errorResponseSchema,
        },
      },
    },
    async (request, reply) => {
      const userId = request.user!.id
      const { consents, locale } = request.body

      // Server-authoritative versioning: only the exact pairs the server
      // currently requires can be recorded. A stale client showing an old
      // document version posts an old pair and gets refused — consent is
      // never recorded for a document the user wasn't actually shown.
      const unknown = consents.filter(
        (c) => !REQUIRED_CONSENTS.some((req) => req.type === c.type && req.version === c.version),
      )
      if (unknown.length > 0) {
        return sendError(
          reply,
          400,
          'validation_error',
          'Unknown consent document version — reload the page and try again',
          unknown.map((c) => ({ path: c.type, issue: `version ${c.version} is not current` })),
        )
      }

      // E-consent evidence, stored (not logged): which network endpoint and
      // client presented the document. Same fields the ERD reserved for this.
      // Browser traffic arrives via the Next.js proxy, so the true address
      // rides in x-client-ip (transfer-confirm precedent); request.ip is the
      // fallback for direct callers. An authenticated caller spoofing the
      // header only pollutes their own consent evidence.
      const forwardedIp = request.headers['x-client-ip']
      const evidence = {
        ip: (typeof forwardedIp === 'string' ? forwardedIp : request.ip) || null,
        user_agent: request.headers['user-agent'] ?? null,
      }

      const rows = consents.map((c) => ({
        user_id: userId,
        type: c.type,
        version: c.version,
        locale,
        evidence,
      }))

      // ON CONFLICT DO NOTHING via ignoreDuplicates: re-consenting to an
      // already-granted version is an idempotent success (double-click, retry,
      // back button), and the original evidence row is never overwritten —
      // the table's forbid_mutation trigger would reject an update anyway.
      const { error } = await supabaseAdmin
        .from('consents')
        .upsert(rows, { onConflict: 'user_id,type,version', ignoreDuplicates: true })

      if (error) {
        server.log.error({ userId, supabaseError: error.code }, 'consent grant failed')
        return sendError(reply, 500, 'internal_error', 'Failed to record consent')
      }

      const granted = await fetchGrantedConsents(userId)
      if (granted === null) {
        return sendError(reply, 500, 'internal_error', 'Failed to load consents')
      }
      return toConsentsResponse(granted)
    },
  )
}
