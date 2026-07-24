import type { FastifyInstance } from 'fastify'
import { env } from '../../config/env.js'
import { supabaseAdmin } from '../../services/supabase.js'
import { buildMockFundingEvent } from '../../services/funding/mock-events.js'
import { sendError, errorResponseSchema } from '../../utils/errors.js'

// TWO INDEPENDENT CONTROLS, both of which must be positively set — neither is
// inferred from the environment:
//
//   1. ENABLE_DEV_ENDPOINTS — explicit opt-in, defaults to false.
//   2. MOCK_FUNDING_WEBHOOK_SECRET — the existing production lock on mock
//      funding (absent in prod by policy), which the funding webhook carries
//      too, so this endpoint can never make mock funding reachable somewhere
//      it wasn't.
//
// Deliberately NOT `NODE_ENV !== 'production'`: nothing in this repo sets
// NODE_ENV for the deployed API, and an unset value parses to 'development'
// (config/env.ts), so that test fails OPEN. It also matters more here than for
// the webhook: forging a funding event needs the secret, whereas this endpoint
// lets ANY authenticated session fund its own transfer for free — so if the
// secret ever drifted into prod, this would widen the blast radius from
// "needs a secret" to "needs an account". Both controls are checked in
// server.ts (route not registered) and again here (handler refuses).
export function devEndpointsEnabled(): boolean {
  return env.ENABLE_DEV_ENDPOINTS && Boolean(env.MOCK_FUNDING_WEBHOOK_SECRET)
}

interface SimulateParams {
  id: string
}

interface TransferForSimulation {
  id: string
  state: string
  funding_payment_ref: string | null
}

export async function devRoute(server: FastifyInstance) {
  // The in-app equivalent of scripts/fire-funding-webhook.ts: signs a
  // funding_succeeded event with the mock secret and drives it through the REAL
  // /v1/webhooks/funding route, so the web "Simulate payment" button exercises
  // signature verification, the transition RPC, the FUNDED ledger batch, and
  // the payout enqueue — the entire production path minus Stripe. The secret
  // never leaves the API env; the web only ever sees this authenticated,
  // owner-scoped endpoint.
  //
  // Only funding_succeeded is exposed. The failure/clear/reverse kinds stay
  // script-only: they are operator debugging tools, not customer-surface
  // actions, and every event type added here is another dev backdoor to reason
  // about. No Idempotency-Key: the PENDING_PAYMENT guard below plus the
  // transition RPC's fromState guard already make a double-fire a no-op or a
  // clean 409, and money movement here is simulated by definition.
  server.post<{ Params: SimulateParams }>(
    '/dev/transfers/:id/simulate-funding',
    {
      schema: {
        params: {
          type: 'object',
          required: ['id'],
          properties: { id: { type: 'string', format: 'uuid' } },
        },
        response: {
          200: {
            type: 'object',
            properties: { simulated: { type: 'boolean' } },
          },
          404: errorResponseSchema,
          409: errorResponseSchema,
          500: errorResponseSchema,
        },
      },
    },
    async (request, reply) => {
      // 404, not 403: in production this endpoint does not exist, and the
      // response must not confirm otherwise.
      if (!devEndpointsEnabled()) {
        return sendError(reply, 404, 'not_found', 'Not found')
      }

      const userId = request.user!.id

      // Owner-scoped even though this is dev-only — a shared staging database
      // has many users' transfers in it, and "it's only staging" is exactly how
      // a cross-tenant write lands in the real thing later.
      const { data, error } = await supabaseAdmin
        .from('transfers')
        .select('id, state, funding_payment_ref')
        .eq('id', request.params.id)
        .eq('user_id', userId)
        .single()

      // PGRST116 = no rows, the genuine "not found". Anything else is an
      // infrastructure fault; reporting that as 404 would have an engineer
      // hunting a missing transfer that is sitting right there.
      if (error && error.code !== 'PGRST116') {
        server.log.error(
          { userId, transferId: request.params.id, supabaseError: error.code },
          'simulate-funding: transfer lookup failed',
        )
        return sendError(reply, 500, 'internal_error', 'Failed to simulate funding')
      }

      const transfer = data as unknown as TransferForSimulation | null
      if (!transfer) {
        return sendError(reply, 404, 'not_found', 'Transfer not found')
      }

      // Funding may only be simulated for a confirmed, still-unfunded transfer.
      // funding_payment_ref is set at confirm, so its presence is the marker
      // that the sender actually accepted the disclosure — simulating funding
      // on an unconfirmed transfer would fund something nobody agreed to.
      if (transfer.state !== 'PENDING_PAYMENT' || !transfer.funding_payment_ref) {
        return sendError(
          reply,
          409,
          'conflict',
          'Only a confirmed, unfunded transfer can have funding simulated',
        )
      }

      // Echo the ref minted at confirm, exactly as Stripe would echo its
      // PaymentIntent id — the webhook writes this back to funding_payment_ref,
      // so a freshly-minted one here would silently overwrite the real value.
      const { body, signature } = buildMockFundingEvent({
        transferId: transfer.id,
        type: 'funding_succeeded',
        secret: env.MOCK_FUNDING_WEBHOOK_SECRET!,
        paymentRef: transfer.funding_payment_ref,
      })

      // In-process dispatch through the app's own router: the real route, the
      // real signature check, the real handler — with no self-addressed HTTP
      // call and so no base-URL config to get wrong in a container.
      const webhookRes = await server.inject({
        method: 'POST',
        url: '/v1/webhooks/funding',
        headers: {
          'content-type': 'application/json',
          'funding-signature': signature,
        },
        payload: body,
      })

      if (webhookRes.statusCode !== 200) {
        // Our own signer failed our own verifier, or the transition faulted —
        // either way it is our bug, not the caller's.
        server.log.error(
          { userId, transferId: transfer.id, webhookStatus: webhookRes.statusCode },
          'simulate-funding: funding webhook rejected the generated event',
        )
        return sendError(reply, 500, 'internal_error', 'Failed to simulate funding')
      }

      return reply.status(200).send({ simulated: true })
    },
  )
}
