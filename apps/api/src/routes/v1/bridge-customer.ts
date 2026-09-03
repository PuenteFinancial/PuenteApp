import type { FastifyInstance } from 'fastify'
import * as Sentry from '@sentry/node'
import { supabaseAdmin } from '../../services/supabase.js'
import {
  BRIDGE_KYC_STATUS_MAP,
  BridgeApiError,
  classifyBridgeCustomerError,
  createBridgeCustomerWithIdentity,
} from '../../services/bridge.js'
import {
  bridgeKycToVerificationStatus,
  recordKycVerification,
} from '../../services/kyc-verifications.js'
import { sendError, errorResponseSchema } from '../../utils/errors.js'
import { isProfileComplete, type UserRow } from './users.js'

/**
 * K6 — the KYC relay (2026-09-03). The ONE route in this API whose request
 * body carries identity numbers.
 *
 * Bridge's Customers API needs the sender's DOB and tax ID
 * (tax_identification_number sits in missing.all_of — proven in sandbox
 * 2026-09-02) and does not accept Stripe's verification. So the K5 form's two
 * values are POSTed here once, after Stripe has verified L1, and relayed
 * straight to Bridge's create-customer call. They live in this request's
 * memory and nowhere else: not on any row (schema-pii.test.ts scans every
 * migration), not in any log line (bridge-customer.test.ts spies the logger),
 * not in Sentry (config/sentry-scrub.ts redacts by key name), and never in
 * this route's response. This is the "relay-never-persist" degrade the
 * 2026-08-27 custody rule reserved for exactly this evidence.
 *
 * Invariant scan: apps/api/src/routes/schema-pii.test.ts asserts this is the
 * only route file that names these fields. Keep it that way.
 */

// Exported so the invariant test can read the wire contract directly.
export const relayBodySchema = {
  type: 'object',
  required: ['dob', 'taxId'],
  properties: {
    dob: {
      type: 'string',
      pattern: '^(19|20)[0-9]{2}-(0[1-9]|1[0-2])-(0[1-9]|[12][0-9]|3[01])$',
    },
    taxId: {
      type: 'object',
      required: ['type', 'number'],
      properties: {
        type: { type: 'string', enum: ['ssn', 'itin'] },
        // 9 digits, dashes optional. ITIN-specific shape (leading 9) is the
        // web form's concern; Bridge validates the number itself.
        number: { type: 'string', pattern: '^[0-9]{3}-?[0-9]{2}-?[0-9]{4}$' },
      },
      additionalProperties: false,
    },
  },
  additionalProperties: false,
} as const

export const relayResponseSchema = {
  type: 'object',
  properties: {
    bridgeCustomerId: { type: 'string' },
    status: { type: 'string' },
  },
} as const

interface RelayBody {
  dob: string
  taxId: { type: 'ssn' | 'itin'; number: string }
}

// A second literal (not a concatenation of USER_COLUMNS): supabase-js parses
// the column list at the type level, and a widened `string` poisons the cast.
const RELAY_COLUMNS =
  'id, first_name, last_name, email, phone, kyc_status, bridge_customer_id, address_line1, address_line2, address_city, address_state, address_postal_code, stripe_kyc_tier, bridge_signed_agreement_id'

interface RelayUserRow extends UserRow {
  stripe_kyc_tier: string | null
  bridge_signed_agreement_id: string | null
}

// Tighter than the global limiter. Each attempt costs Bridge a KYC ($2) and
// the sender an L1 verification, and a bounded count keeps the
// duplicate_identity answer from being usable as an oracle.
export const RELAY_RATE_LIMIT = { max: 5, timeWindow: '15 minutes' } as const

// Whitespace-normalize the stored address for Bridge. Decision 7 keeps CASS
// out of scope; the AddressElement (K6b) improves the input, this only keeps
// it tidy. Country is pinned to USA by the body builder.
export function normalizeResidentialAddress(row: {
  address_line1: string | null
  address_line2: string | null
  address_city: string | null
  address_state: string | null
  address_postal_code: string | null
}) {
  const clean = (value: string | null) => (value ?? '').trim().replace(/\s+/g, ' ')
  const line2 = clean(row.address_line2)
  return {
    streetLine1: clean(row.address_line1),
    streetLine2: line2 === '' ? null : line2,
    city: clean(row.address_city),
    subdivision: clean(row.address_state).toUpperCase(),
    postalCode: clean(row.address_postal_code),
  }
}

export async function bridgeCustomerRoute(server: FastifyInstance) {
  server.post<{ Body: RelayBody }>(
    '/users/me/bridge-customer',
    {
      config: {
        rateLimit: {
          ...RELAY_RATE_LIMIT,
          keyGenerator: (request) => request.user?.id ?? request.ip,
        },
      },
      schema: {
        body: relayBodySchema,
        response: {
          200: relayResponseSchema,
          400: errorResponseSchema,
          403: errorResponseSchema,
          404: errorResponseSchema,
          409: errorResponseSchema,
          422: errorResponseSchema,
          500: errorResponseSchema,
          502: errorResponseSchema,
        },
      },
    },
    async (request, reply) => {
      const userId = request.user!.id

      // The whole handler is guarded: an unexpected throw becomes a 502 after
      // a code-only log line, never a rethrow — so no framework error path
      // ever holds this request's body.
      try {
        const { data, error } = await supabaseAdmin
          .from('users')
          .select(RELAY_COLUMNS)
          .eq('id', userId)
          .single()

        if (error || !data) {
          return sendError(reply, 404, 'not_found', 'User not found')
        }
        const user = data as RelayUserRow

        if (!isProfileComplete(user)) {
          return sendError(reply, 403, 'forbidden', 'Complete your profile before verification')
        }

        // No-op when the customer already exists: Bridge is never called
        // twice for one sender, whatever the client re-sends.
        if (user.bridge_customer_id) {
          return { bridgeCustomerId: user.bridge_customer_id, status: user.kyc_status }
        }

        // Decision 2: sequential, after Stripe L1. stripe_kyc_tier is the
        // column derived only from `verified` entries (stripe_kyc_tier_status
        // is whatever verification happens to be listed first).
        if (user.stripe_kyc_tier !== 'L1' && user.stripe_kyc_tier !== 'L2') {
          return sendError(
            reply,
            403,
            'kyc_required',
            'Identity verification must complete before this step',
          )
        }

        // Decision 1: ToS first. The pointer is the latest unconsumed
        // signed_agreement_id; the consents row is the evidence.
        if (!user.bridge_signed_agreement_id) {
          return sendError(reply, 409, 'conflict', 'Bridge terms must be accepted first', [
            { path: 'bridge_tos', issue: 'required' },
          ])
        }

        let created: { id: string; status: string | undefined }
        try {
          created = await createBridgeCustomerWithIdentity({
            userId,
            firstName: user.first_name!,
            lastName: user.last_name!,
            email: user.email!,
            signedAgreementId: user.bridge_signed_agreement_id,
            birthDate: request.body.dob,
            address: normalizeResidentialAddress(user),
            taxId: { type: request.body.taxId.type, number: request.body.taxId.number },
          })
        } catch (err) {
          if (!(err instanceof BridgeApiError)) {
            // Timeout / network. Name only: the error may wrap the request.
            server.log.error(
              { userId, err: err instanceof Error ? err.name : 'unknown' },
              'bridge customer relay unreachable',
            )
            return sendError(reply, 502, 'provider_unavailable', 'Verification is unavailable, try again shortly')
          }
          const kind = classifyBridgeCustomerError(err)
          const bridgeCode = (err.body as { code?: string } | null)?.code
          // Status + code only — Bridge error bodies can echo the request.
          server.log.warn({ userId, bridgeStatus: err.status, bridgeCode, kind }, 'bridge customer relay refused')
          switch (kind) {
            case 'duplicate':
              // Decision 9: hard stop, support route, never auto-link.
              return sendError(reply, 409, 'duplicate_identity', 'This identity is already registered — contact support')
            case 'agreement': {
              // The agreement id was consumed or refused: drop the pointer so
              // the pay step sends the sender back through the click-through.
              await supabaseAdmin
                .from('users')
                .update({ bridge_signed_agreement_id: null })
                .eq('id', userId)
              return sendError(reply, 409, 'conflict', 'Bridge terms must be accepted again', [
                { path: 'signed_agreement_id', issue: 'consumed' },
              ])
            }
            case 'rejected':
              // Decision 4: the client offers one correction.
              return sendError(reply, 422, 'provider_rejected', 'Bridge could not accept these details')
            case 'unavailable':
              return sendError(reply, 502, 'provider_unavailable', 'Verification is unavailable, try again shortly')
          }
        }

        const kycStatus = (created.status && BRIDGE_KYC_STATUS_MAP[created.status]) || 'pending'

        // Guarded persist: only the first writer lands. The agreement id is
        // consumed by the create, so the pointer clears in the same write.
        const { data: persisted, error: persistError } = await supabaseAdmin
          .from('users')
          .update({
            bridge_customer_id: created.id,
            kyc_status: kycStatus,
            bridge_signed_agreement_id: null,
          })
          .eq('id', userId)
          .is('bridge_customer_id', null)
          .select('bridge_customer_id')

        if (persistError) {
          // The customer exists at Bridge. A retry with the same values
          // replays the idempotency key and lands the same id.
          server.log.error({ userId, supabaseError: persistError.code }, 'bridge customer persist failed')
          return sendError(reply, 500, 'internal_error', 'Could not save verification, try again')
        }

        let bridgeCustomerId = created.id
        if (!persisted || persisted.length === 0) {
          // A concurrent writer won. Re-read and report the stored id; if it
          // differs, the created customer is an orphan at Bridge — page it.
          const { data: current } = await supabaseAdmin
            .from('users')
            .select('bridge_customer_id')
            .eq('id', userId)
            .single()
          const stored = (current as { bridge_customer_id?: string | null } | null)?.bridge_customer_id
          if (stored && stored !== created.id) {
            Sentry.captureMessage('bridge customer orphaned by concurrent relay', {
              level: 'error',
              fingerprint: ['bridge-customer-orphan'],
              extra: { userId, storedCustomerId: stored, orphanCustomerId: created.id },
            })
          }
          bridgeCustomerId = stored ?? created.id
        }

        // Corner 2: the verdict log. Best-effort by contract.
        await recordKycVerification(
          {
            userId,
            provider: 'bridge',
            providerRef: bridgeCustomerId,
            status: bridgeKycToVerificationStatus(kycStatus),
            providerStatus: created.status ?? null,
            source: 'relay',
          },
          server.log,
        )

        return { bridgeCustomerId, status: kycStatus }
      } catch (err) {
        server.log.error(
          { userId, err: err instanceof Error ? err.name : 'unknown' },
          'bridge customer relay failed',
        )
        Sentry.captureMessage('bridge customer relay failed', {
          level: 'error',
          fingerprint: ['bridge-customer-relay-unknown'],
          extra: { userId, errName: err instanceof Error ? err.name : 'unknown' },
        })
        return sendError(reply, 502, 'provider_unavailable', 'Verification is unavailable, try again shortly')
      }
    },
  )
}
