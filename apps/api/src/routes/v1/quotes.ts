import type { FastifyInstance } from 'fastify'
import { env } from '../../config/env.js'
import { supabaseAdmin } from '../../services/supabase.js'
import { getExchangeRate, BridgeApiError } from '../../services/bridge.js'
import {
  priceQuote,
  formatRate4,
  InvalidBuyRateError,
  QuoteAmountError,
} from '../../services/quotes.js'
import { requireApprovedUser } from './recipients.js'

// source_rate / fx_rate_at are reconciliation-only and deliberately excluded:
// they never cross the wire.
const QUOTE_COLUMNS =
  'id, payout_destination_id, send_amount_minor, send_currency, receive_amount_minor, ' +
  'receive_currency, fee_amount_minor, fee_currency, fx_rate, status, expires_at, created_at'

interface QuoteRow {
  id: string
  payout_destination_id: string
  send_amount_minor: number
  send_currency: string
  receive_amount_minor: number
  receive_currency: string
  fee_amount_minor: number
  fee_currency: string
  fx_rate: number // numeric(12,4) — PostgREST serializes as a JSON number
  status: string
  expires_at: string
  created_at: string
}

// numeric(12,4) values are exact decimals with ≤4 dp and ≤12 significant
// digits, so the double round-trips exactly; the round + BigInt path restores
// the integer scale-4 value without ever doing float arithmetic on amounts.
function fxRateToWire(fxRate: number): string {
  return formatRate4(BigInt(Math.round(fxRate * 10_000)))
}

function toApiQuote(row: QuoteRow, now: Date = new Date()) {
  const derivedStatus =
    row.status === 'active' && new Date(row.expires_at) <= now ? 'expired' : row.status
  return {
    id: row.id,
    payoutDestinationId: row.payout_destination_id,
    totalAmount: {
      amountMinor: row.send_amount_minor + row.fee_amount_minor,
      currency: row.send_currency,
    },
    sendAmount: { amountMinor: row.send_amount_minor, currency: row.send_currency },
    feeAmount: { amountMinor: row.fee_amount_minor, currency: row.fee_currency },
    receiveAmount: { amountMinor: row.receive_amount_minor, currency: row.receive_currency },
    fxRate: fxRateToWire(row.fx_rate),
    expiresAt: row.expires_at,
    status: derivedStatus,
    createdAt: row.created_at,
  }
}

const moneySchema = (currency: string) =>
  ({
    type: 'object',
    properties: {
      amountMinor: { type: 'integer' },
      currency: { type: 'string', enum: [currency] },
    },
  }) as const

const quoteResponseSchema = {
  type: 'object',
  properties: {
    id: { type: 'string' },
    payoutDestinationId: { type: 'string' },
    totalAmount: moneySchema('USD'),
    sendAmount: moneySchema('USD'),
    feeAmount: moneySchema('USD'),
    receiveAmount: moneySchema('MXN'),
    fxRate: { type: 'string' },
    expiresAt: { type: 'string' },
    status: { type: 'string' },
    createdAt: { type: 'string' },
  },
} as const

const errorResponseSchema = {
  type: 'object',
  properties: { error: { type: 'string' } },
} as const

interface CreateQuoteBody {
  payoutDestinationId: string
  totalAmount: { amountMinor: number; currency: 'USD' }
}

interface OwnedDestinationRow {
  id: string
  currency: string
  status: string
  recipients: { user_id: string; status: string }
}

export async function quotesRoute(server: FastifyInstance) {
  server.post<{ Body: CreateQuoteBody }>(
    '/quotes',
    {
      config: {
        // Tighter than the global limiter: quote creation hits Bridge's rate
        // endpoint. Keyed per user when auth has run, per IP otherwise.
        rateLimit: {
          max: 10,
          timeWindow: '1 minute',
          keyGenerator: (request) => request.user?.id ?? request.ip,
        },
      },
      schema: {
        body: {
          type: 'object',
          required: ['payoutDestinationId', 'totalAmount'],
          properties: {
            payoutDestinationId: { type: 'string', format: 'uuid' },
            totalAmount: {
              type: 'object',
              required: ['amountMinor', 'currency'],
              properties: {
                // Upper bound keeps every downstream product inside safe
                // integer range; funding is USD-only for MVP.
                amountMinor: { type: 'integer', minimum: 1, maximum: 1_000_000_000_000 },
                currency: { type: 'string', enum: ['USD'] },
              },
              additionalProperties: false,
            },
          },
          additionalProperties: false,
        },
        response: {
          201: quoteResponseSchema,
          400: errorResponseSchema,
          403: errorResponseSchema,
          404: errorResponseSchema,
          429: errorResponseSchema,
          503: errorResponseSchema,
        },
      },
    },
    async (request, reply) => {
      const userId = request.user!.id

      if (!(await requireApprovedUser(userId, reply))) return

      // Owner-scoped destination gate: active destination under an active
      // recipient of this user, in the supported corridor. provider_account_ref
      // is deliberately NOT required here — payability is the slice-5
      // submission gate; a quote is just a price.
      const { data: destinationData } = await supabaseAdmin
        .from('payout_destinations')
        .select('id, currency, status, recipients!inner(user_id, status)')
        .eq('id', request.body.payoutDestinationId)
        .eq('recipients.user_id', userId)
        .single()

      if (!destinationData) {
        return reply.status(404).send({ error: 'Payout destination not found' })
      }
      const destination = destinationData as unknown as OwnedDestinationRow
      if (destination.status !== 'active' || destination.recipients.status !== 'active') {
        return reply.status(400).send({ error: 'Payout destination is archived' })
      }
      if (destination.currency !== 'MXN') {
        return reply.status(400).send({ error: 'Only MXN payouts are supported' })
      }

      let buyRate: string
      try {
        const rates = await getExchangeRate('usd', 'mxn')
        buyRate = rates.buyRate
      } catch (err) {
        if (err instanceof BridgeApiError) {
          server.log.error({ userId, bridgeStatus: err.status }, 'bridge rate fetch failed')
        } else {
          server.log.error({ userId }, 'bridge rate request failed')
        }
        return reply.status(503).send({ error: 'Exchange rate is unavailable, try again shortly' })
      }
      const fxRateAt = new Date()

      let priced
      try {
        priced = priceQuote({
          totalMinor: request.body.totalAmount.amountMinor,
          buyRate,
          config: {
            feeFlatMinor: env.QUOTE_FEE_FLAT_MINOR,
            feeBps: env.QUOTE_FEE_BPS,
            fxBufferBps: env.QUOTE_FX_BUFFER_BPS,
          },
        })
      } catch (err) {
        if (err instanceof QuoteAmountError) {
          return reply.status(400).send({ error: err.message })
        }
        if (err instanceof InvalidBuyRateError) {
          // Malformed provider data is a provider outage from the caller's
          // perspective; log the shape problem, never the failed math inputs.
          server.log.error({ userId }, 'bridge buy_rate failed validation')
          return reply
            .status(503)
            .send({ error: 'Exchange rate is unavailable, try again shortly' })
        }
        throw err
      }

      const expiresAt = new Date(fxRateAt.getTime() + env.QUOTE_EXPIRY_SECONDS * 1000)

      const { data, error } = await supabaseAdmin
        .from('quotes')
        .insert({
          user_id: userId,
          payout_destination_id: destination.id,
          send_amount_minor: priced.sendMinor,
          send_currency: 'USD',
          receive_amount_minor: priced.receiveMinor,
          receive_currency: 'MXN',
          fee_amount_minor: priced.feeMinor,
          fee_currency: 'USD',
          // strings into numeric columns — the fixed-scale value is preserved
          // verbatim; a JS float never touches the write path
          fx_rate: priced.fxRate4,
          source_rate: buyRate,
          fx_rate_at: fxRateAt.toISOString(),
          expires_at: expiresAt.toISOString(),
        })
        .select(QUOTE_COLUMNS)
        .single()

      if (error || !data) {
        server.log.error({ userId, supabaseError: error?.code }, 'quote insert failed')
        return reply.status(500).send({ error: 'Failed to create quote' })
      }

      return reply.status(201).send(toApiQuote(data as unknown as QuoteRow))
    },
  )

  server.get<{ Params: { id: string } }>(
    '/quotes/:id',
    {
      schema: {
        params: {
          type: 'object',
          required: ['id'],
          properties: { id: { type: 'string', format: 'uuid' } },
        },
        response: {
          200: quoteResponseSchema,
          404: errorResponseSchema,
        },
      },
    },
    async (request, reply) => {
      const userId = request.user!.id

      const { data, error } = await supabaseAdmin
        .from('quotes')
        .select(QUOTE_COLUMNS)
        .eq('id', request.params.id)
        .eq('user_id', userId)
        .single()

      if (error || !data) {
        return reply.status(404).send({ error: 'Quote not found' })
      }

      // Expiry is derived on read — the row is not rewritten; slice 4 flips
      // status to consumed/expired transactionally at transfer creation.
      return toApiQuote(data as unknown as QuoteRow)
    },
  )
}
