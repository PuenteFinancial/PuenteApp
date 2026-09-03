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
  createOnrampSession,
  checkoutOnrampSession,
  KYC_STEP_UP_CODES,
  NoStoredTokenError,
  StripeCryptoApiError,
} from '../../services/stripe-crypto.js'
import { getFundingProcessor } from '../../services/funding/index.js'
import { UNSUPPORTED_CODES } from '../../services/funding/stripe-onramp.js'
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
    return sendError(reply, 409, 'link_auth_required', 'Link authentication required')
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

  // ── Pay-step money surface (K4) ──────────────────────────────────────────
  // Live only under FUNDING_PROCESSOR=stripe_crypto: with any other rail,
  // confirm already minted the funding object and a session created here
  // would fight it.

  // Ownership + lifecycle guard shared by both money routes. Returns the row
  // or null (reply already sent). Requires acceptance (confirmed transfer)
  // and PENDING_PAYMENT — the only state where funding may be (re)attempted.
  async function loadPayableTransfer(
    userId: string,
    transferId: string,
    reply: Parameters<typeof sendError>[0],
  ): Promise<{
    id: string
    send_amount_minor: number
    fee_amount_minor: number
    funding_payment_ref: string | null
  } | null> {
    if (getFundingProcessor().deferredInitiation !== true) {
      await sendError(reply, 409, 'conflict', 'Onramp sessions are not used by the active funding rail')
      return null
    }
    const { data } = await supabaseAdmin
      .from('transfers')
      .select('id, user_id, state, disclosure_accepted_at, send_amount_minor, fee_amount_minor, funding_payment_ref')
      .eq('id', transferId)
      .eq('user_id', userId)
      .maybeSingle()
    const transfer = data as {
      id: string
      state: string
      disclosure_accepted_at: string | null
      send_amount_minor: number
      fee_amount_minor: number
      funding_payment_ref: string | null
    } | null
    if (!transfer) {
      await sendError(reply, 404, 'not_found', 'Transfer not found')
      return null
    }
    if (!transfer.disclosure_accepted_at || transfer.state !== 'PENDING_PAYMENT') {
      await sendError(reply, 409, 'conflict', 'Transfer is not awaiting payment')
      return null
    }
    return transfer
  }

  // Session-create failures the K5 UI must branch on, mapped once for both
  // money routes. KYC step-ups keep the exact Stripe code in details so the
  // client knows WHICH verification to run; geo/profile refusals reuse the
  // widget rail's stable code.
  function sendSessionError(
    reply: Parameters<typeof sendError>[0],
    userId: string,
    err: StripeCryptoApiError,
  ) {
    const code = err.code
    if (code && KYC_STEP_UP_CODES.has(code)) {
      return sendError(reply, 400, 'kyc_required', 'Identity verification required', [
        { path: 'kyc', issue: code },
      ])
    }
    if (code && UNSUPPORTED_CODES.has(code)) {
      return sendError(reply, 403, 'funding_unsupported', 'Payments are not supported from your location')
    }
    if (code === 'crypto_onramp_disabled') {
      return sendError(reply, 503, 'not_configured', 'Funding is not available yet')
    }
    // Other 4xx: the session/quote is no longer usable (expired quote,
    // consumed token…). Never-resume rule: the client starts a fresh attempt.
    // LOGGED (K5 drive, 2026-08-28): this branch is where every unmapped
    // provider refusal lands, and swallowing the code made a live failure
    // undiagnosable — the sender saw "start again" and the server said
    // nothing. Code only, never the body (it can carry sender PII).
    if (err.status < 500) {
      server.log.warn(
        { userId, stripeStatus: err.status, stripeCode: code },
        'stripe crypto session refused — client must restart the attempt',
      )
      return sendError(reply, 409, 'conflict', 'This payment attempt can no longer be used — start again')
    }
    server.log.error({ userId, stripeStatus: err.status, stripeCode: code }, 'stripe crypto session failed')
    return sendError(reply, 502, 'provider_unavailable', 'Service is unavailable, try again shortly')
  }

  server.post<{ Params: { id: string }; Body: { paymentTokenId: string } }>(
    '/crypto/transfers/:id/onramp-session',
    {
      schema: {
        params: {
          type: 'object',
          required: ['id'],
          properties: { id: { type: 'string', format: 'uuid' } },
        },
        body: {
          type: 'object',
          required: ['paymentTokenId'],
          properties: {
            // cpt_ from the SDK's collectPaymentMethod callback. Bound to the
            // caller's own crypto customer by Stripe (the session is created
            // under THEIR OAuth token), so a stolen token id fails there.
            paymentTokenId: { type: 'string', pattern: '^cpt_[A-Za-z0-9]{1,64}$' },
          },
          additionalProperties: false,
        },
        response: {
          200: {
            type: 'object',
            properties: { sessionId: { type: 'string' }, status: { type: 'string' } },
          },
          400: errorResponseSchema,
          403: errorResponseSchema,
          404: errorResponseSchema,
          409: errorResponseSchema,
          502: errorResponseSchema,
        },
      },
    },
    async (request, reply) => {
      const userId = request.user!.id
      const transfer = await loadPayableTransfer(userId, request.params.id, reply)
      if (!transfer) return

      // New session per attempt, never resume (ratified decision): a prior
      // session may be replaced — but only while it provably hasn't moved
      // money. Pre-checkout statuses and rejected are safe to abandon
      // (checkout is the money moment and it never ran or was refused);
      // fulfillment_* means money is in motion and a second session would
      // double-charge.
      if (transfer.funding_payment_ref) {
        let priorStatus: string
        try {
          const prior = await getFundingProcessor().getPaymentStatus!({
            paymentRef: transfer.funding_payment_ref,
          })
          priorStatus = prior.status
        } catch {
          // Can't prove the prior session is safe to abandon — refuse rather
          // than risk a parallel money path.
          return sendError(reply, 502, 'provider_unavailable', 'Service is unavailable, try again shortly')
        }
        if (priorStatus === 'fulfillment_processing' || priorStatus === 'fulfillment_complete') {
          return sendError(reply, 409, 'conflict', 'Payment is already in progress for this transfer')
        }
      }

      const { data: userData } = await supabaseAdmin
        .from('users')
        .select('stripe_crypto_customer_id')
        .eq('id', userId)
        .single()
      const cryptoCustomerId = (userData as { stripe_crypto_customer_id: string | null } | null)
        ?.stripe_crypto_customer_id
      if (!cryptoCustomerId) {
        return sendError(reply, 409, 'link_auth_required', 'Link authentication required')
      }

      // Real client IP (widget-rail contract): Stripe geo-checks it and
      // refuses private/localhost addresses itself.
      const forwardedIp = request.headers['x-client-ip']
      const clientIp = (typeof forwardedIp === 'string' ? forwardedIp : request.ip) || ''

      try {
        const accessToken = await mintAccessToken(userId)
        const session = await createOnrampSession({
          transferId: transfer.id,
          cryptoCustomerId,
          paymentTokenId: request.body.paymentTokenId,
          destinationAmountUsd: ((transfer.send_amount_minor + transfer.fee_amount_minor) / 100).toFixed(2),
          clientIp,
          accessToken,
        })

        // Stamp the ref while still PENDING_PAYMENT. A raced older tab's
        // checkout is refused by the ref-binding check on the checkout route,
        // so last-write-wins here is safe.
        const { error: refError } = await supabaseAdmin
          .from('transfers')
          .update({ funding_payment_ref: session.id, funding_processor: getFundingProcessor().provider })
          .eq('id', transfer.id)
          .eq('state', 'PENDING_PAYMENT')
        if (refError) {
          server.log.error({ userId, transferId: transfer.id, supabaseError: refError.code }, 'onramp session ref persist failed')
          return sendError(reply, 500, 'internal_error', 'Failed to start payment')
        }

        return { sessionId: session.id, status: session.status }
      } catch (err) {
        if (err instanceof NoStoredTokenError) {
          return sendError(reply, 409, 'link_auth_required', 'Link authentication required')
        }
        if (err instanceof StripeCryptoApiError) {
          return sendSessionError(reply, userId, err)
        }
        throw err
      }
    },
  )

  server.post<{ Params: { id: string }; Body: { sessionId: string; paymentMethodType: 'card' | 'us_bank_account' } }>(
    '/crypto/transfers/:id/onramp-checkout',
    {
      schema: {
        params: {
          type: 'object',
          required: ['id'],
          properties: { id: { type: 'string', format: 'uuid' } },
        },
        body: {
          type: 'object',
          required: ['sessionId', 'paymentMethodType'],
          properties: {
            sessionId: { type: 'string', pattern: '^cos_[A-Za-z0-9_]{1,128}$' },
            // Decides the mandate: ACH checkout carries the sender's online
            // acceptance evidence (ip + user agent); cards need none.
            paymentMethodType: { type: 'string', enum: ['card', 'us_bank_account'] },
          },
          additionalProperties: false,
        },
        response: {
          200: { type: 'object', properties: { clientSecret: { type: 'string' } } },
          400: errorResponseSchema,
          403: errorResponseSchema,
          404: errorResponseSchema,
          409: errorResponseSchema,
          502: errorResponseSchema,
        },
      },
    },
    async (request, reply) => {
      const userId = request.user!.id
      const transfer = await loadPayableTransfer(userId, request.params.id, reply)
      if (!transfer) return

      // The checkout must target the CURRENT session for this transfer — a
      // stale tab holding a replaced session id gets refused instead of
      // executing a payment the webhook side would then flag as a mismatch.
      if (!transfer.funding_payment_ref || transfer.funding_payment_ref !== request.body.sessionId) {
        return sendError(reply, 409, 'conflict', 'This payment attempt can no longer be used — start again')
      }

      const forwardedIp = request.headers['x-client-ip']
      const clientIp = (typeof forwardedIp === 'string' ? forwardedIp : request.ip) || ''
      const userAgent = request.headers['user-agent'] ?? ''

      try {
        const accessToken = await mintAccessToken(userId)
        const { clientSecret } = await checkoutOnrampSession({
          sessionId: request.body.sessionId,
          accessToken,
          ...(request.body.paymentMethodType === 'us_bank_account' && {
            achMandate: { clientIp, userAgent },
          }),
        })
        // client_secret goes to the SDK callback and nowhere else — never
        // persisted, never logged (PI-rail contract).
        return { clientSecret }
      } catch (err) {
        if (err instanceof NoStoredTokenError) {
          return sendError(reply, 409, 'link_auth_required', 'Link authentication required')
        }
        if (err instanceof StripeCryptoApiError) {
          return sendSessionError(reply, userId, err)
        }
        throw err
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
