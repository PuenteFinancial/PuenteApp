import type { FastifyInstance } from 'fastify'
import { env } from '../../config/env.js'
import { supabaseAdmin } from '../../services/supabase.js'
import {
  createBridgeCustomer,
  createTosLink,
  getBridgeCustomer,
  getKycLink,
  BridgeApiError,
} from '../../services/bridge.js'
import { sendError, errorResponseSchema } from '../../utils/errors.js'
import { fetchGrantedConsents, missingConsents } from './consents.js'

const USER_COLUMNS = 'id, first_name, last_name, email, kyc_status, bridge_customer_id'

const KYC_MAX_RETRIES = 3
const KYC_RETRY_COLUMNS = 'kyc_status, bridge_customer_id, kyc_retry_count'

interface KycRetryRow {
  kyc_status: string
  bridge_customer_id: string | null
  kyc_retry_count: number
}

interface UserRow {
  id: string
  first_name: string | null
  last_name: string | null
  email: string | null
  kyc_status: string
  bridge_customer_id: string | null
}

function toApiUser(row: UserRow) {
  return {
    id: row.id,
    firstName: row.first_name,
    lastName: row.last_name,
    email: row.email,
    kycStatus: row.kyc_status,
    bridgeCustomerId: row.bridge_customer_id,
  }
}

const userResponseSchema = {
  type: 'object',
  properties: {
    id: { type: 'string' },
    firstName: { type: ['string', 'null'] },
    lastName: { type: ['string', 'null'] },
    email: { type: ['string', 'null'] },
    kycStatus: { type: 'string' },
    bridgeCustomerId: { type: ['string', 'null'] },
    // GET only (PATCH omits it): whether every REQUIRED_CONSENTS pair is
    // granted. The /continue router gates on this (K1).
    consentsCurrent: { type: 'boolean' },
  },
} as const

interface UpdateMeBody {
  firstName: string
  lastName: string
  email: string
}

interface TosLinkBody {
  origin?: string
  platform?: 'web' | 'mobile'
  state?: string
}

interface KycLinkBody {
  signed_agreement_id: string
  origin?: string
  platform?: 'web' | 'mobile'
}

// Bridge redirects the browser back to the web app after ToS/KYC, so the
// redirect must target the origin the user is actually on (localhost web vs
// Expo, staging vs prod). Only allowlisted origins are honored — anything
// else falls back to the canonical first entry.
function resolveWebOrigin(origin?: string): string {
  if (origin && env.ALLOWED_ORIGINS.includes(origin)) return origin
  // splitting a non-empty env var always yields at least one entry
  return env.ALLOWED_ORIGINS[0]!
}

// The mobile app's URL scheme. Must match "scheme" in apps/mobile/app.json.
//
// Hardcoded, never taken from the request. Bridge's ToS page performs the
// return leg as a bare `location.href = <redirect_uri>` with no validation of
// any kind — verified against their sandbox on 2026-08-11 — so the redirect
// target is only ever as trustworthy as whoever supplied it. Minting it here
// is what keeps it out of a caller's hands.
const MOBILE_SCHEME = 'puente'

// Bridge appends `signed_agreement_id` to whatever redirect_uri it is given,
// preserving existing query params (verified against their sandbox). That is
// what lets a nonce round-trip so the app can refuse a return it did not start.
//
// The target is this API rather than the app's own scheme, and that indirection
// is not optional: Bridge's ToS page ends with a client-side `location.href`,
// and iOS does not surface that to ASWebAuthenticationSession for a custom
// scheme — the sheet lands on about:blank and never closes. Pointing at an
// https URL that answers 302 → puente:// turns it into the redirect form iOS
// does intercept. Measured both ways on a simulator, 2026-08-11.
//
// `state` is schema-constrained to an opaque token, so it cannot smuggle extra
// query parameters or a fragment into the URL built here.
function mobileTosRedirect(publicApiUrl: string, state: string): string {
  return `${publicApiUrl}/v1/kyc/tos-return?state=${encodeURIComponent(state)}`
}

/**
 * Where Persona sends the browser once hosted KYC finishes.
 *
 * Web lands on its own /onboarding/kyc/return page, which reads the user and
 * routes. Mobile needs the same thing — a redirect, not a dismissal — because
 * asking the user to close the browser themselves is ambiguous: if that
 * dismissal does not resolve, the app waits forever with no way out. Observed
 * happening on a simulator, 2026-08-11.
 *
 * So mobile gets the same relay treatment as the ToS leg, and for the same iOS
 * reason. No nonce here: this leg carries no payload the app acts on —
 * kyc_status arrives by webhook and the app re-reads /v1/users/me — so there is
 * nothing for a forged call to forge.
 */
function kycReturnRedirect(platform: 'web' | 'mobile', publicApiUrl: string | undefined, origin?: string): string {
  return platform === 'mobile' && publicApiUrl
    ? `${publicApiUrl}/v1/kyc/return`
    : `${resolveWebOrigin(origin)}/onboarding/kyc/return`
}

export async function usersRoute(server: FastifyInstance) {
  server.get(
    '/users/me',
    {
      schema: {
        response: {
          200: userResponseSchema,
          404: errorResponseSchema,
          500: errorResponseSchema,
        },
      },
    },
    async (request, reply) => {
      const userId = request.user!.id
      const { data, error } = await supabaseAdmin
        .from('users')
        .select(USER_COLUMNS)
        .eq('id', userId)
        .single()

      if (error || !data) {
        return sendError(reply, 404, 'not_found', 'User not found')
      }

      // 500 rather than a guessed value on failure: false would bounce the
      // user into re-consenting, true would skip a legally required gate.
      const granted = await fetchGrantedConsents(userId)
      if (granted === null) {
        return sendError(reply, 500, 'internal_error', 'Failed to load consents')
      }

      return {
        ...toApiUser(data as UserRow),
        consentsCurrent: missingConsents(granted).length === 0,
      }
    },
  )

  server.patch<{ Body: UpdateMeBody }>(
    '/users/me',
    {
      schema: {
        body: {
          type: 'object',
          required: ['firstName', 'lastName', 'email'],
          properties: {
            firstName: { type: 'string', minLength: 1, maxLength: 100 },
            lastName: { type: 'string', minLength: 1, maxLength: 100 },
            email: { type: 'string', format: 'email' },
          },
          additionalProperties: false,
        },
        response: { 200: userResponseSchema },
      },
    },
    async (request, reply) => {
      const userId = request.user!.id
      const { firstName, lastName, email } = request.body

      const { data, error } = await supabaseAdmin
        .from('users')
        .update({
          first_name: firstName.trim(),
          last_name: lastName.trim(),
          email: email.trim(),
        })
        .eq('id', userId)
        .select(USER_COLUMNS)
        .single()

      if (error || !data) {
        server.log.error({ userId, supabaseError: error?.code }, 'profile update failed')
        return sendError(reply, 500, 'internal_error', 'Failed to update profile')
      }

      // Triggers Supabase's email verification flow. Non-blocking by design:
      // the user may continue onboarding before confirming their email.
      supabaseAdmin.auth.admin
        .updateUserById(userId, { email: email.trim() })
        .then(({ error: emailError }) => {
          if (emailError) {
            server.log.warn({ userId, authError: emailError.status }, 'email verification trigger failed')
          }
        })
        .catch(() => {
          server.log.warn({ userId }, 'email verification trigger failed')
        })

      return toApiUser(data as UserRow)
    },
  )

  server.post<{ Body: TosLinkBody }>(
    '/users/me/tos-link',
    {
      schema: {
        body: {
          type: 'object',
          properties: {
            origin: { type: 'string' },
            // Absent means web, so every existing caller is unaffected.
            platform: { type: 'string', enum: ['web', 'mobile'] },
            // Opaque nonce, mobile only. The pattern is the security control:
            // it admits nothing that could add a query parameter, a fragment,
            // or a second scheme to the redirect URI this route builds.
            state: { type: 'string', pattern: '^[A-Za-z0-9_-]{16,64}$' },
          },
          additionalProperties: false,
        },
        response: {
          200: {
            type: 'object',
            properties: { url: { type: 'string' } },
          },
          400: errorResponseSchema,
          502: errorResponseSchema,
        },
      },
    },
    async (request, reply) => {
      const userId = request.user!.id
      const platform = request.body?.platform ?? 'web'

      // A mobile caller with no nonce has no way to tell its own return from a
      // forged one, so the flow is refused rather than started insecurely.
      if (platform === 'mobile' && !request.body?.state) {
        return sendError(reply, 400, 'validation_error', 'state is required for mobile')
      }

      // Misconfiguration, not a bad request: without this the return leg has
      // nowhere to land, and a silently-web redirect would strand the user in a
      // browser instead of returning them to the app.
      if (platform === 'mobile' && !env.PUBLIC_API_URL) {
        server.log.error({ userId }, 'PUBLIC_API_URL is unset — mobile KYC cannot return')
        return sendError(
          reply,
          503,
          'not_configured',
          'Identity verification is unavailable, try again shortly',
        )
      }

      const redirectUri =
        platform === 'mobile'
          ? mobileTosRedirect(env.PUBLIC_API_URL!, request.body!.state!)
          : `${resolveWebOrigin(request.body?.origin)}/onboarding/kyc/tos-return`

      try {
        const { url } = await createTosLink(redirectUri)
        return { url }
      } catch (err) {
        if (err instanceof BridgeApiError) {
          const bridgeCode = (err.body as { code?: string } | null)?.code
          server.log.error({ userId, bridgeStatus: err.status, bridgeCode }, 'bridge tos link failed')
          return sendError(reply, 502, 'provider_unavailable', 'Identity verification is unavailable, try again shortly')
        }
        throw err
      }
    },
  )

  /**
   * The mobile ToS return leg. Bridge sends the browser here; this bounces it
   * into the app.
   *
   * It exists only because of an iOS behaviour: ASWebAuthenticationSession does
   * not intercept a custom scheme reached by a page's own `location.href`, which
   * is how Bridge finishes its ToS flow — the sheet lands on about:blank and
   * never closes, stranding the user. It DOES intercept a 302 to that scheme.
   * So this converts the one into the other and does nothing else.
   *
   * Public because Bridge's redirect arrives with no credentials, and it needs
   * none: nothing here reads or writes user state. It forwards two validated
   * parameters and redirects. The security boundary is the nonce the app checks
   * on the other side — a forged call to this route can only produce a deep link
   * the app then refuses.
   */
  server.get<{ Querystring: { state: string; signed_agreement_id: string } }>(
    '/kyc/tos-return',
    {
      config: { public: true },
      schema: {
        querystring: {
          type: 'object',
          required: ['state', 'signed_agreement_id'],
          properties: {
            // Same pattern the tos-link route pins, for the same reason: it
            // admits nothing that could add a parameter, a fragment or a second
            // scheme to the redirect built below.
            state: { type: 'string', pattern: '^[A-Za-z0-9_-]{16,64}$' },
            // Bridge issues UUIDs. Constrained rather than trusted, so a
            // hostile caller cannot inject URL syntax through it either.
            signed_agreement_id: { type: 'string', pattern: '^[A-Za-z0-9-]{8,64}$' },
          },
        },
        response: { 400: errorResponseSchema },
      },
    },
    async (request, reply) => {
      const target =
        `${MOBILE_SCHEME}://kyc/tos-return` +
        `?state=${encodeURIComponent(request.query.state)}` +
        `&signed_agreement_id=${encodeURIComponent(request.query.signed_agreement_id)}`
      // The Location carries a one-time nonce and an agreement id. Nothing
      // between here and the device should keep a copy: no shared cache has any
      // use for a redirect that is valid exactly once.
      return reply.header('Cache-Control', 'no-store').redirect(target, 302)
    },
  )

  /**
   * The mobile KYC return leg. Persona sends the browser here; this bounces it
   * back into the app.
   *
   * Carries nothing — no nonce, no identifiers. Its entire job is to be a URL
   * Persona will redirect to and iOS will intercept, so the app learns the user
   * is done without asking them to close a browser by hand. What actually
   * happened is read from /v1/users/me afterwards; this is a doorbell.
   *
   * That also means a forged call achieves nothing: the worst an attacker can
   * do is make a signed-in app re-read its own KYC status.
   */
  server.get(
    '/kyc/return',
    { config: { public: true } },
    async (_request, reply) => {
      return reply.header('Cache-Control', 'no-store').redirect(`${MOBILE_SCHEME}://kyc/return`, 302)
    },
  )

  server.get(
    '/users/me/kyc-rejection',
    {
      schema: {
        response: {
          200: {
            type: 'object',
            properties: {
              reasons: { type: 'array', items: { type: 'string' } },
              retriesRemaining: { type: 'number' },
            },
          },
          404: errorResponseSchema,
          409: errorResponseSchema,
        },
      },
    },
    async (request, reply) => {
      const userId = request.user!.id
      const { data, error } = await supabaseAdmin
        .from('users')
        .select(KYC_RETRY_COLUMNS)
        .eq('id', userId)
        .single()

      if (error || !data) {
        return sendError(reply, 404, 'not_found', 'User not found')
      }

      const user = data as KycRetryRow
      if (user.kyc_status !== 'rejected') {
        return sendError(reply, 409, 'conflict', 'Identity verification is not in a rejected state')
      }

      // Reason strings can reference the user's documents — they go to the
      // client for display and nowhere else (never logged, never in URLs).
      let reasons: string[] = []
      if (user.bridge_customer_id) {
        try {
          const customer = await getBridgeCustomer(user.bridge_customer_id)
          reasons = customer.rejectionReasons
        } catch (err) {
          if (!(err instanceof BridgeApiError)) throw err
          // Degrade to generic copy — a Bridge blip must not blank the page
          server.log.warn({ userId, bridgeStatus: err.status }, 'bridge customer fetch failed')
        }
      }

      return {
        reasons,
        retriesRemaining: Math.max(0, KYC_MAX_RETRIES - user.kyc_retry_count),
      }
    },
  )

  server.post<{ Body: TosLinkBody }>(
    '/users/me/kyc-link/retry',
    {
      schema: {
        body: {
          type: 'object',
          properties: {
            origin: { type: 'string' },
            platform: { type: 'string', enum: ['web', 'mobile'] },
          },
          additionalProperties: false,
        },
        response: {
          200: {
            type: 'object',
            properties: { url: { type: 'string' } },
          },
          404: errorResponseSchema,
          409: errorResponseSchema,
          429: errorResponseSchema,
          502: errorResponseSchema,
        },
      },
    },
    async (request, reply) => {
      const userId = request.user!.id
      const { data, error } = await supabaseAdmin
        .from('users')
        .select(KYC_RETRY_COLUMNS)
        .eq('id', userId)
        .single()

      if (error || !data) {
        return sendError(reply, 404, 'not_found', 'User not found')
      }

      const user = data as KycRetryRow
      if (user.kyc_status !== 'rejected' || !user.bridge_customer_id) {
        return sendError(reply, 409, 'conflict', 'Identity verification cannot be retried right now')
      }
      if (user.kyc_retry_count >= KYC_MAX_RETRIES) {
        return sendError(reply, 429, 'rate_limited', 'Retry limit reached, contact support')
      }

      // Consume the retry before issuing the link. The kyc_retry_count guard
      // collapses concurrent retries into one — the loser matches 0 rows.
      const { data: bumped, error: bumpError } = await supabaseAdmin
        .from('users')
        .update({ kyc_retry_count: user.kyc_retry_count + 1 })
        .eq('id', userId)
        .eq('kyc_retry_count', user.kyc_retry_count)
        .select('kyc_retry_count')
        .single()

      if (bumpError || !bumped) {
        return sendError(reply, 409, 'conflict', 'Identity verification cannot be retried right now')
      }

      try {
        const { url } = await getKycLink(
          user.bridge_customer_id,
          kycReturnRedirect(request.body?.platform ?? 'web', env.PUBLIC_API_URL, request.body?.origin),
        )
        return { url }
      } catch (err) {
        // Refund the consumed retry on ANY throw, not just BridgeApiError
        // (debt-pass review fix): with Bridge calls bounded, a TimeoutError is
        // the COMMON failure mode, and the old BridgeApiError-only guard
        // silently ate one of the user's lifetime retries on every timeout —
        // no refund, no log, straight to "Retry limit reached" for a user who
        // never failed KYC. Best-effort; a crash here costs one retry,
        // recoverable by an admin resetting the column.
        const { error: refundError } = await supabaseAdmin
          .from('users')
          .update({ kyc_retry_count: user.kyc_retry_count })
          .eq('id', userId)
          .eq('kyc_retry_count', user.kyc_retry_count + 1)

        if (refundError) {
          server.log.warn({ userId, supabaseError: refundError.code }, 'kyc retry refund failed')
        }

        if (err instanceof BridgeApiError) {
          const bridgeCode = (err.body as { code?: string } | null)?.code
          server.log.error({ userId, bridgeStatus: err.status, bridgeCode }, 'bridge request failed')
          return sendError(reply, 502, 'provider_unavailable', 'Identity verification is unavailable, try again shortly')
        }
        throw err
      }
    },
  )

  server.post<{ Body: KycLinkBody }>(
    '/users/me/kyc-link',
    {
      schema: {
        body: {
          type: 'object',
          required: ['signed_agreement_id'],
          properties: {
            signed_agreement_id: { type: 'string', minLength: 1 },
            origin: { type: 'string' },
            platform: { type: 'string', enum: ['web', 'mobile'] },
          },
          additionalProperties: false,
        },
        response: {
          200: {
            type: 'object',
            properties: { url: { type: 'string' } },
          },
        },
      },
    },
    async (request, reply) => {
      const userId = request.user!.id

      const { data, error } = await supabaseAdmin
        .from('users')
        .select(USER_COLUMNS)
        .eq('id', userId)
        .single()

      if (error || !data) {
        return sendError(reply, 404, 'not_found', 'User not found')
      }

      const user = data as UserRow
      if (!user.first_name || !user.last_name || !user.email) {
        return sendError(reply, 400, 'validation_error', 'Complete your profile before identity verification')
      }

      try {
        let bridgeCustomerId = user.bridge_customer_id

        if (!bridgeCustomerId) {
          const created = await createBridgeCustomer({
            firstName: user.first_name,
            lastName: user.last_name,
            email: user.email,
            signedAgreementId: request.body.signed_agreement_id,
          })
          bridgeCustomerId = created.id

          const { error: saveError } = await supabaseAdmin
            .from('users')
            .update({ bridge_customer_id: bridgeCustomerId })
            .eq('id', userId)

          if (saveError) {
            server.log.error({ userId, supabaseError: saveError.code }, 'bridge customer save failed')
            return sendError(reply, 500, 'internal_error', 'Failed to start identity verification')
          }
        }

        const { url } = await getKycLink(
          bridgeCustomerId,
          kycReturnRedirect(request.body.platform ?? 'web', env.PUBLIC_API_URL, request.body.origin),
        )
        return { url }
      } catch (err) {
        if (err instanceof BridgeApiError) {
          const bridgeCode = (err.body as { code?: string } | null)?.code
          server.log.error({ userId, bridgeStatus: err.status, bridgeCode }, 'bridge request failed')
          return sendError(reply, 502, 'provider_unavailable', 'Identity verification is unavailable, try again shortly')
        }
        throw err
      }
    },
  )
}
