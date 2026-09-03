import type { FastifyInstance } from 'fastify'
import { BRIDGE_TOS_VERSION, REQUIRED_CONSENTS, type ConsentDocument } from '@puente/shared'
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

// K6: has the sender accepted the CURRENT Bridge ToS? Evidence-based (the
// append-only row), independent of whether the agreement id is still
// unconsumed — the pay step skips the click-through on this OR on an existing
// Bridge customer.
export function hasBridgeTos(granted: Pick<ConsentRow, 'type' | 'version'>[]): boolean {
  return granted.some((g) => g.type === 'bridge_tos' && g.version === BRIDGE_TOS_VERSION)
}

export type GrantBridgeTosResult = 'ok' | 'consent_failed' | 'pointer_failed'

/**
 * Record a Bridge ToS acceptance (K6 decision 1: ToS first, before Link auth).
 * Two writes, in this order:
 *   1. the append-only `consents` evidence row — idempotent on
 *      (user, bridge_tos, version); a re-acceptance keeps the FIRST row's
 *      evidence, exactly like our own documents;
 *   2. `users.bridge_signed_agreement_id`, the mutable pointer to the LATEST
 *      agreement id, which the relay presents to Bridge and clears on use.
 * Split on purpose: the row proves acceptance forever, the pointer keeps a
 * consumed id from ever locking the sender out of a re-acceptance.
 */
export async function grantBridgeTos(
  userId: string,
  input: {
    signedAgreementId: string
    locale: 'en' | 'es'
    ip: string | null
    userAgent: string | null
  },
): Promise<GrantBridgeTosResult> {
  const { error: consentError } = await supabaseAdmin.from('consents').upsert(
    {
      user_id: userId,
      type: 'bridge_tos',
      version: BRIDGE_TOS_VERSION,
      locale: input.locale,
      evidence: {
        ip: input.ip,
        user_agent: input.userAgent,
        signed_agreement_id: input.signedAgreementId,
      },
    },
    { onConflict: 'user_id,type,version', ignoreDuplicates: true },
  )
  if (consentError) return 'consent_failed'

  const { error: pointerError } = await supabaseAdmin
    .from('users')
    .update({ bridge_signed_agreement_id: input.signedAgreementId })
    .eq('id', userId)
  if (pointerError) return 'pointer_failed'

  return 'ok'
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

interface BridgeTosBody {
  signed_agreement_id: string
  locale?: 'en' | 'es'
}

// Which network endpoint and client presented a document — stored as
// evidence, never logged. Browser traffic arrives via the Next.js proxy, so
// the true address rides in x-client-ip (transfer-confirm precedent);
// request.ip is the fallback for direct callers. An authenticated caller
// spoofing the header only pollutes their own consent evidence.
function consentEvidence(request: {
  headers: Record<string, string | string[] | undefined>
  ip: string
}): { ip: string | null; user_agent: string | null } {
  const forwardedIp = request.headers['x-client-ip']
  const userAgent = request.headers['user-agent']
  return {
    ip: (typeof forwardedIp === 'string' ? forwardedIp : request.ip) || null,
    user_agent: typeof userAgent === 'string' ? userAgent : null,
  }
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

      // E-consent evidence, stored (not logged). Same fields the ERD
      // reserved for this.
      const evidence = consentEvidence(request)

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

  /**
   * K6: the web return leg of Bridge's standalone ToS click-through. Bridge
   * redirects the browser back with a signed_agreement_id; the page posts it
   * here (server-side, via the Next proxy) and we record the acceptance. The
   * only client-asserted value is Bridge's own opaque id, pattern-pinned so it
   * can carry no URL syntax; POST /users/me/consents keeps refusing
   * bridge_tos because THIS is the one path that can attach that evidence.
   */
  server.post<{ Body: BridgeTosBody }>(
    '/users/me/bridge-tos',
    {
      schema: {
        body: {
          type: 'object',
          required: ['signed_agreement_id'],
          properties: {
            // Same pin as the kyc-link and tos-return legs.
            signed_agreement_id: { type: 'string', pattern: '^[A-Za-z0-9-]{8,64}$' },
            locale: { type: 'string', enum: ['en', 'es'] },
          },
          additionalProperties: false,
        },
        response: {
          200: {
            type: 'object',
            properties: { bridgeTosAccepted: { type: 'boolean' } },
          },
          400: errorResponseSchema,
          500: errorResponseSchema,
        },
      },
    },
    async (request, reply) => {
      const userId = request.user!.id
      const evidence = consentEvidence(request)
      const result = await grantBridgeTos(userId, {
        signedAgreementId: request.body.signed_agreement_id,
        locale: request.body.locale ?? 'en',
        ip: evidence.ip,
        userAgent: evidence.user_agent,
      })
      if (result !== 'ok') {
        server.log.error({ userId, step: result }, 'bridge tos grant failed')
        return sendError(reply, 500, 'internal_error', 'Failed to record consent')
      }
      return { bridgeTosAccepted: true }
    },
  )
}
