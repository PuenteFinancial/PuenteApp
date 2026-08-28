import type { FastifyInstance } from 'fastify'
import { supabaseAdmin } from '../../services/supabase.js'
import {
  createOrReuseLinkAuthIntent,
  exchangeLinkAuthIntent,
  getCryptoCustomer,
  cacheKycStatus,
  getOnrampQuote,
  getTransactionLimits,
  mintAccessToken,
  isStripeCryptoConfigured,
  NoStoredTokenError,
  StripeCryptoApiError,
} from '../../services/stripe-crypto.js'
import { sendError, errorResponseSchema } from '../../utils/errors.js'

// K3 (KYC rehaul): the server surface for Link OAuth + crypto status. These
// routes exist for the K5 send flow; until then they are a dark, authed
// surface. All of them 503 when the OAuth pair isn't configured — the
// K-lane ships dark until Doppler carries the credentials.
//
// PII rules: the user's email is read from their own row server-side — a
// client-supplied email could bind someone else's Link identity to this
// account. Tokens never appear in any response, log line, or URL.

// The corridor's destination is fixed: USDC on Base (same rail the widget
// slice locked — ONRAMP_DESTINATION_ADDRESS is a Base address).
const DESTINATION_CURRENCY = 'usdc'
const DESTINATION_NETWORK = 'base'

// One place to translate provider failures. Body is never logged (it can
// echo request context); status + Stripe error code are enough to debug.
function handleProviderError(
  server: FastifyInstance,
  reply: Parameters<typeof sendError>[0],
  userId: string,
  err: unknown,
) {
  if (err instanceof NoStoredTokenError) {
    // Not an error state: the user simply has to (re)authenticate with Link.
    return sendError(reply, 409, 'conflict', 'Link authentication required')
  }
  if (err instanceof StripeCryptoApiError) {
    server.log.error({ userId, stripeStatus: err.status, stripeCode: err.code }, 'stripe crypto request failed')
    return sendError(reply, 502, 'provider_unavailable', 'Service is unavailable, try again shortly')
  }
  throw err
}

export async function cryptoRoute(server: FastifyInstance) {
  // Gate every route in one hook rather than per-handler: an unconfigured
  // crypto surface must be uniformly 503, never a mix of 503s and stack
  // traces from half-initialized calls.
  server.addHook('onRequest', async (_request, reply) => {
    if (!isStripeCryptoConfigured()) {
      return sendError(reply, 503, 'not_configured', 'Onramp is unavailable')
    }
  })

  server.post(
    '/crypto/link-auth-intent',
    {
      schema: {
        response: {
          200: {
            type: 'object',
            properties: {
              authIntentId: { type: 'string' },
              expiresAt: { type: 'number' },
              linkAccountExists: { type: 'boolean' },
            },
          },
          400: errorResponseSchema,
          502: errorResponseSchema,
          503: errorResponseSchema,
        },
      },
    },
    async (request, reply) => {
      const userId = request.user!.id

      const { data } = await supabaseAdmin.from('users').select('email').eq('id', userId).single()
      const email = (data as { email: string | null } | null)?.email
      if (!email) {
        return sendError(reply, 400, 'validation_error', 'Complete your profile first')
      }

      try {
        const intent = await createOrReuseLinkAuthIntent(userId, email)
        return {
          authIntentId: intent.id,
          expiresAt: intent.expiresAt,
          linkAccountExists: intent.linkAccountExists,
        }
      } catch (err) {
        return handleProviderError(server, reply, userId, err)
      }
    },
  )

  server.post<{ Body: { authIntentId: string } }>(
    '/crypto/link-auth-intent/exchange',
    {
      schema: {
        body: {
          type: 'object',
          required: ['authIntentId'],
          properties: {
            authIntentId: { type: 'string', pattern: '^lai_[A-Za-z0-9]{1,64}$' },
          },
          additionalProperties: false,
        },
        response: {
          200: { type: 'object', properties: { ok: { type: 'boolean' } } },
          403: errorResponseSchema,
          502: errorResponseSchema,
        },
      },
    },
    async (request, reply) => {
      const userId = request.user!.id
      const { authIntentId } = request.body

      // Only the intent WE minted for this user is exchangeable. Without
      // this, a caller could submit someone else's consented lai_ id and
      // graft that person's Link identity (and tokens) onto their own
      // account.
      const { data } = await supabaseAdmin
        .from('stripe_link_tokens')
        .select('auth_intent_id')
        .eq('user_id', userId)
        .maybeSingle()
      const stored = (data as { auth_intent_id: string | null } | null)?.auth_intent_id
      if (!stored || stored !== authIntentId) {
        return sendError(reply, 403, 'forbidden', 'Unknown authentication attempt')
      }

      try {
        // Access token deliberately dropped: this endpoint's job is to bank
        // the refresh token. Server-side callers mint their own on demand.
        await exchangeLinkAuthIntent(userId, authIntentId)
        return { ok: true }
      } catch (err) {
        return handleProviderError(server, reply, userId, err)
      }
    },
  )

  server.post<{ Body: { customerId: string } }>(
    '/crypto/customer',
    {
      schema: {
        body: {
          type: 'object',
          required: ['customerId'],
          properties: {
            // crc_ id from the SDK's authenticate callback (K5 client). The
            // poll below verifies it against Stripe under the USER'S OAuth
            // token before anything trusts it — a fabricated id fails there.
            customerId: { type: 'string', pattern: '^crc_[A-Za-z0-9]{1,64}$' },
          },
          additionalProperties: false,
        },
        response: {
          200: {
            type: 'object',
            properties: {
              customerId: { type: 'string' },
              verifications: {
                type: 'array',
                items: {
                  type: 'object',
                  properties: { type: { type: 'string' }, status: { type: 'string' } },
                },
              },
            },
          },
          409: errorResponseSchema,
          502: errorResponseSchema,
        },
      },
    },
    async (request, reply) => {
      const userId = request.user!.id
      try {
        // Verify-then-persist: retrieving the customer under this user's own
        // OAuth token proves the id belongs to them (Stripe scopes the call);
        // only then does it land on their row.
        const accessToken = await mintAccessToken(userId)
        const status = await getCryptoCustomer(request.body.customerId, accessToken)
        await cacheKycStatus(userId, status)
        return status
      } catch (err) {
        return handleProviderError(server, reply, userId, err)
      }
    },
  )

  server.get(
    '/crypto/kyc-status',
    {
      schema: {
        response: {
          200: {
            type: 'object',
            properties: {
              customerId: { type: 'string' },
              verifications: {
                type: 'array',
                items: {
                  type: 'object',
                  properties: { type: { type: 'string' }, status: { type: 'string' } },
                },
              },
            },
          },
          404: errorResponseSchema,
          409: errorResponseSchema,
          502: errorResponseSchema,
        },
      },
    },
    async (request, reply) => {
      const userId = request.user!.id

      const { data } = await supabaseAdmin
        .from('users')
        .select('stripe_crypto_customer_id')
        .eq('id', userId)
        .single()
      const customerId = (data as { stripe_crypto_customer_id: string | null } | null)
        ?.stripe_crypto_customer_id
      if (!customerId) {
        return sendError(reply, 404, 'not_found', 'No crypto customer yet')
      }

      try {
        const accessToken = await mintAccessToken(userId)
        const status = await getCryptoCustomer(customerId, accessToken)
        await cacheKycStatus(userId, status)
        return status
      } catch (err) {
        return handleProviderError(server, reply, userId, err)
      }
    },
  )

  server.get<{ Querystring: { amount: string } }>(
    '/crypto/quote',
    {
      schema: {
        querystring: {
          type: 'object',
          required: ['amount'],
          properties: {
            // Decimal-string USD amount (Stripe quotes in display units, not
            // minor units — deliberate exception to the Money rule, contained
            // to this boundary; nothing here posts to a ledger).
            amount: { type: 'string', pattern: '^[0-9]{1,6}(\\.[0-9]{1,2})?$' },
          },
          additionalProperties: false,
        },
        response: {
          200: {
            type: 'object',
            properties: {
              destinationCurrency: { type: 'string' },
              destinationAmount: { type: 'string' },
              destinationNetwork: { type: 'string' },
              networkFee: { type: 'string' },
              transactionFee: { type: 'string' },
              sourceTotalAmount: { type: 'string' },
            },
          },
          404: errorResponseSchema,
          502: errorResponseSchema,
        },
      },
    },
    async (request, reply) => {
      const userId = request.user!.id
      try {
        const quote = await getOnrampQuote({
          sourceAmount: request.query.amount,
          destinationCurrency: DESTINATION_CURRENCY,
          destinationNetwork: DESTINATION_NETWORK,
        })
        if (!quote) {
          return sendError(reply, 404, 'not_found', 'No quote available for this amount')
        }
        return quote
      } catch (err) {
        return handleProviderError(server, reply, userId, err)
      }
    },
  )

  server.get(
    '/crypto/limits',
    {
      // No 200 response schema on purpose: transaction_limits is the one
      // SMOKE-VALIDATED endpoint (no public doc) — pinning a schema would
      // strip fields we haven't seen yet. K5 narrows it once smoke has run
      // against a provisioned account.
      schema: {
        response: {
          409: errorResponseSchema,
          502: errorResponseSchema,
        },
      },
    },
    async (request, reply) => {
      const userId = request.user!.id
      try {
        const accessToken = await mintAccessToken(userId)
        return { limits: await getTransactionLimits(accessToken) }
      } catch (err) {
        return handleProviderError(server, reply, userId, err)
      }
    },
  )
}
